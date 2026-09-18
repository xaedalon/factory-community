import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  ApiError,
  api,
  type Disclaimer,
  type ExecutionProfile,
  type FactorySettings,
  type UiTheme,
} from '../api/client.js'

/**
 * What the person using Factory has chosen.
 *
 * Held by the daemon rather than in this browser, so the desktop app and a tab
 * pointed at the same daemon agree, and so the CLI can honour the same
 * switches. `localStorage` would have been simpler and would have made the app
 * and the browser disagree about the same installation.
 */
export const MAX_SCALE = 3

/** Every size the control offers. 1 is what the board was designed at. */
export const SCALES: readonly number[] = [1, 1.25, 1.5, 2, 2.5, 3]

export const useSettings = defineStore('settings', () => {
  const settings = ref<FactorySettings | undefined>(undefined)
  const file = ref<string | undefined>(undefined)
  const loading = ref(false)
  const error = ref<string | undefined>(undefined)
  /** The wording to show, served with the settings so there is only one of it. */
  const disclaimer = ref<Disclaimer | undefined>(undefined)
  /**
   * Whether this installation has accepted it.
   *
   * Served rather than derived from the version number, because deciding
   * whether a stored 1 satisfies a current 2 is the daemon's arithmetic and a
   * second copy of it here would be the copy that goes stale.
   *
   * `undefined` until the first load, which is not the same as `false`: the
   * board must not flash a disclaimer at somebody who has already accepted it.
   */
  const accepted = ref<boolean | undefined>(undefined)
  /**
   * Whether to show the disclaimer *now*.
   *
   * Separate from `accepted`, and that separation is the whole behaviour. The
   * first version drew the panel whenever nothing had been accepted, which put
   * it over the board on load — and browsing is not running. It is raised when
   * a run is actually refused, so it appears where the button was pressed.
   */
  const needsAcceptance = ref(false)
  /**
   * What to do once it has been accepted.
   *
   * The button says "Continue", and continuing means the thing the person
   * asked for happens. Without this, accepting dismisses a panel and leaves
   * them to press Queue a second time — which is a worse reading of the same
   * word, and a person who has just read a page about agent autonomy has
   * already decided.
   *
   * One deep, and cleared whether it succeeds or fails: a retry that itself
   * gets refused must not queue another retry.
   */
  let continueWith: (() => Promise<void>) | undefined

  // Optional all the way down, including *inside* a settings object that
  // exists. A board served by an older daemon gets a settings object with no
  // `security` group at all — which is exactly what happened the first time
  // this ran, and `settings.value?.security.profile` threw and took the whole
  // component update with it. Degrade by absence applies to a payload as much
  // as to a capability.
  const scale = computed(() => settings.value?.ui?.scale ?? 1)
  const theme = computed<UiTheme>(() => settings.value?.ui?.theme ?? 'system')
  const profile = computed<ExecutionProfile>(() => settings.value?.security?.profile ?? 'default')
  /** Whether to draw the Full Access marker. Read by the shell on every page. */
  const unconfined = computed(() => profile.value === 'full-access')

  /**
   * Apply the size the way Cmd+ applies it.
   *
   * `zoom` rather than a root `font-size`, because the board has a hundred
   * hard-coded pixel text sizes in its mono badges and labels: a font-size
   * would grow the body text and leave the metadata layer behind. `zoom`
   * scales px and rem alike, which is what "what happens when I press command
   * and plus" actually means.
   */
  const apply = (value: number): void => {
    const root = document.documentElement
    root.style.zoom = value === 1 ? '' : String(value)
    // Told to the stylesheet as well, because `100vh` is measured in unzoomed
    // pixels: the shell divides by this so "full height" keeps meaning the
    // window rather than a multiple of it.
    root.style.setProperty('--app-zoom', String(value))
  }

  /** Whichever of `light`/`dark` is currently applied, so the `system` listener below knows what it's following. */
  let appliedTheme: UiTheme = 'system'
  let media: MediaQueryList | undefined

  const resolveTheme = (value: UiTheme): 'light' | 'dark' =>
    value === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : value

  /**
   * Set the `data-theme` attribute `tokens.css` switches on.
   *
   * `system` is resolved here, not in CSS: the attribute is always `light` or
   * `dark`, so the stylesheet never has to know a third value exists.
   */
  const applyTheme = (value: UiTheme): void => {
    appliedTheme = value
    document.documentElement.dataset.theme = resolveTheme(value)
  }

  /**
   * Follow the OS while the stored preference is `system`.
   *
   * Attached once, on the first successful load: a second load attaching a
   * second listener would apply the same OS change twice.
   */
  const watchSystemTheme = (): void => {
    if (media !== undefined) return
    media = window.matchMedia('(prefers-color-scheme: light)')
    media.addEventListener('change', () => {
      if (appliedTheme === 'system') applyTheme('system')
    })
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      const answer = await api.settings()
      settings.value = answer.settings
      file.value = answer.file
      disclaimer.value = answer.disclaimer
      accepted.value = answer.accepted
      // Through the guarded computed, so an older payload with no ui group
      // falls back to 1 rather than throwing here.
      apply(answer.settings.ui?.scale ?? 1)
      applyTheme(answer.settings.ui?.theme ?? 'system')
      watchSystemTheme()
      error.value = undefined
    } catch (caught) {
      error.value = caught instanceof ApiError ? caught.message : String(caught)
    } finally {
      loading.value = false
    }
  }

  async function setScale(value: number): Promise<void> {
    // Applied before the round trip, so dragging feels immediate; the answer
    // is still the daemon's, and a refusal puts it back.
    apply(value)
    try {
      const answer = await api.saveSettings({ ui: { scale: value } })
      settings.value = answer.settings
      error.value = undefined
    } catch (caught) {
      error.value = caught instanceof ApiError ? caught.message : String(caught)
      apply(scale.value)
    }
  }

  async function setTheme(value: UiTheme): Promise<void> {
    // Same optimistic pattern as setScale: applied immediately, rolled back to
    // whatever was applied before if the daemon refuses it.
    const previous = theme.value
    applyTheme(value)
    try {
      const answer = await api.saveSettings({ ui: { theme: value } })
      settings.value = answer.settings
      error.value = undefined
    } catch (caught) {
      error.value = caught instanceof ApiError ? caught.message : String(caught)
      applyTheme(previous)
    }
  }

  /**
   * Record that the disclaimer has been read.
   *
   * No argument: the version stored is the daemon's own, so a board showing an
   * older copy cannot accept on behalf of a newer one.
   */
  async function accept(): Promise<boolean> {
    try {
      const answer = await api.acceptDisclaimer()
      settings.value = answer.settings
      accepted.value = answer.accepted
      needsAcceptance.value = false
      error.value = undefined
      const resume = continueWith
      continueWith = undefined
      if (resume !== undefined) await resume()
      return true
    } catch (caught) {
      error.value = caught instanceof ApiError ? caught.message : String(caught)
      return false
    }
  }

  /**
   * Put the panel away without agreeing to anything.
   *
   * What "Review permissions" does. The panel is `fixed inset-0` in the shell,
   * so navigating to the settings page left it sitting over the very page it
   * had just sent somebody to read — which is how this was found.
   *
   * The pending action is dropped, deliberately. Somebody who chose to go and
   * read rather than to continue has not asked for the run to start, and
   * starting it when they later accept from a settings page would be a
   * surprise.
   */
  function dismiss(): void {
    needsAcceptance.value = false
    continueWith = undefined
  }

  async function setProfile(value: ExecutionProfile): Promise<void> {
    try {
      const answer = await api.saveSettings({ security: { profile: value } })
      settings.value = answer.settings
      error.value = undefined
    } catch (caught) {
      error.value = caught instanceof ApiError ? caught.message : String(caught)
    }
  }

  /**
   * Was this refusal the disclaimer, and if so, show it.
   *
   * One implementation, two callers — the task page and the board both queue
   * tasks, and a refusal that became the panel on one and a red error message
   * on the other would be the same idea twice. Returns whether it handled the
   * error, so the caller knows not to also report it.
   *
   * Narrow on purpose: it opens a modal, so it checks for the payload the
   * daemon actually sends rather than trusting the status code alone.
   */
  function handledRefusal(caught: unknown, retry?: () => Promise<void>): boolean {
    if (!(caught instanceof ApiError) || caught.status !== 409) return false
    const body = caught.body
    const carriesDisclaimer =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { disclaimer?: unknown }).disclaimer === 'object'
    if (!carriesDisclaimer) return false

    accepted.value = false
    needsAcceptance.value = true
    continueWith = retry
    // The wording comes from the daemon; a board that has not loaded it yet has
    // nothing to show, so fetch it before the panel is looked for.
    if (disclaimer.value === undefined) void load()
    return true
  }

  return {
    settings,
    file,
    loading,
    error,
    scale,
    theme,
    profile,
    unconfined,
    disclaimer,
    accepted,
    needsAcceptance,
    load,
    setScale,
    setTheme,
    setProfile,
    accept,
    dismiss,
    handledRefusal,
  }
})
