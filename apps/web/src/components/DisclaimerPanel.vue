<script setup lang="ts">
import { ref } from 'vue'
import { useSettings } from '../stores/settings.js'

/**
 * What a person is shown before Factory runs an agent for them, once.
 *
 * Factory coordinates other people's coding agents against real repositories.
 * Until this increment it did that with no boundary of its own and said nothing
 * about it, so the first way anybody found out what a run could reach was by
 * reading the source.
 *
 * Shown over the board rather than as a page of its own, and only once a run
 * has actually been refused — so it appears wherever somebody pressed the
 * button, rather than over the board on every load. Browsing costs nothing:
 * the daemon gates *starting a run*, and so does this.
 *
 * The first version keyed off "nothing has been accepted", which put a modal
 * in front of a person who had come to read. The board's own scenario caught
 * it.
 *
 * The wording is the daemon's, served with the settings. A copy here would be
 * the copy that drifts from what somebody actually agreed to.
 */
const settings = useSettings()
const saving = ref(false)

async function accept(): Promise<void> {
  saving.value = true
  try {
    await settings.accept()
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="settings.needsAcceptance && settings.disclaimer !== undefined"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
    data-testid="disclaimer"
    role="dialog"
    aria-modal="true"
    aria-labelledby="disclaimer-title"
  >
    <div
      class="max-h-full w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-8 shadow-2xl"
    >
      <h2
        id="disclaimer-title"
        class="text-lg font-semibold text-[var(--color-ink)]"
        data-testid="disclaimer-title"
      >
        {{ settings.disclaimer.title }}
      </h2>

      <p class="mt-4 text-sm leading-relaxed text-[var(--color-ink)]" data-testid="disclaimer-summary">
        {{ settings.disclaimer.summary }}
      </p>

      <ul class="mt-5 space-y-2" data-testid="disclaimer-points">
        <li
          v-for="point in settings.disclaimer.points"
          :key="point"
          class="flex gap-2 text-xs leading-relaxed text-[var(--color-ink-muted)]"
        >
          <span aria-hidden="true" class="text-[var(--color-accent-text)]">·</span>
          <span>{{ point }}</span>
        </li>
      </ul>

      <!-- Said plainly rather than buried, because the alternative is somebody
           discovering it later and being right to be annoyed. -->
      <p
        class="mt-5 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-4 py-3 text-xs leading-relaxed text-[var(--color-ink)]"
        data-testid="disclaimer-caveat"
      >
        {{ settings.disclaimer.caveat }}
      </p>

      <p v-if="settings.error !== undefined" class="mt-4 text-xs text-[var(--color-danger)]" data-testid="error">
        {{ settings.error }}
      </p>

      <div class="mt-6 flex items-center gap-3">
        <button
          type="button"
          class="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          data-testid="accept-disclaimer"
          :disabled="saving"
          @click="accept"
        >
          Continue with Default
        </button>
        <!-- Dismisses on the way. Without this the panel stays over the
             settings page, because it is `fixed inset-0` in the shell and a
             route change does not touch it — so the one link that sends
             somebody to read blocked the page they were sent to. -->
        <RouterLink
          to="/settings"
          class="text-xs text-[var(--color-ink-faint)] underline"
          data-testid="review-permissions"
          @click="settings.dismiss()"
        >
          Review permissions
        </RouterLink>
      </div>
    </div>
  </div>
</template>
