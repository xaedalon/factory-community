import type { TaskState } from './api/client.js'

/**
 * What a task state looks like — the one table, and now the only one.
 *
 * It lived in `TaskStateBadge.vue` as a map of Tailwind class strings, which
 * made it the one place only for things that are badges. The progress bar was
 * not a badge, so it drew every task's progress in the accent colour: a blocked
 * task and a finished one had the same purple bar, on a board whose whole
 * premise is that colour means status.
 *
 * A class string cannot be shared, because Tailwind only generates utilities it
 * can see written out in the source. A custom property can, so the value lives
 * here and the components spend it through `style` — the same arrangement
 * `identity.ts` uses for project colours, and for the same reason.
 *
 * `fill` is the exception that proves the rule. Most states tint their badge
 * with their own colour, but draft, cancelled and archived have no colour of
 * their own — they are grey because nothing is happening — so they take the
 * neutral veil every other quiet surface in the app uses rather than a mix of
 * grey with itself. Both follow the theme; the veil is just the one the rest of
 * the interface already agrees on.
 */
export interface StateLook {
  readonly label: string
  readonly tone: string
  readonly fill?: string
}

export const STATE_LOOKS: Record<TaskState, StateLook> = {
  draft: { label: 'Draft', tone: 'var(--color-ink-muted)', fill: 'var(--color-veil-strong)' },
  queued: { label: 'Queued', tone: 'var(--color-pending)' },
  running: { label: 'Running', tone: 'var(--color-info)' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'var(--color-warn)' },
  blocked: { label: 'Blocked', tone: 'var(--color-danger)' },
  done: { label: 'Done', tone: 'var(--color-ok)' },
  cancelled: { label: 'Cancelled', tone: 'var(--color-ink-faint)', fill: 'var(--color-veil)' },
  archived: { label: 'Archived', tone: 'var(--color-ink-faint)', fill: 'var(--color-veil)' },
}

/**
 * The tint a state's colour sits on when it is a badge rather than a mark.
 *
 * `color-mix` rather than a second hex per state, so there is still one value
 * per meaning — and so it follows the theme without a light-side entry of its
 * own. Chromium-only by nature, which is what this ships in.
 */
export const wash = (tone: string): string => `color-mix(in srgb, ${tone} 12%, transparent)`

/** What fills a state's badge: its own colour, or the neutral veil. */
export const fillFor = (look: StateLook): string => look.fill ?? wash(look.tone)

/** The colour a task's progress bar is drawn in, or the accent before it starts. */
export const toneFor = (state: TaskState | undefined): string =>
  state === undefined ? 'var(--color-accent)' : STATE_LOOKS[state].tone
