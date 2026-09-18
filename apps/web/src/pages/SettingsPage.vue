<script setup lang="ts">
import { onMounted } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import { SCALES, useSettings } from '../stores/settings.js'
import type { ExecutionProfile, UiTheme } from '../api/client.js'

/**
 * Preferences, kept in a file Factory owns.
 *
 * Not in `config.yaml`, which is hand-written and full of the author's
 * comments, and not in the database, which lives in the default write scope
 * and is therefore per-repository rather than per-person.
 */
const settings = useSettings()

/**
 * The three choices, with the names a person reads.
 *
 * Spelled here for the same reason `PROFILES` is below: the board offers a
 * choice the daemon has not been told about yet.
 */
const THEMES: readonly { value: UiTheme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

/**
 * The two profiles, with the names a person reads.
 *
 * Spelled here rather than derived from the served settings, because the board
 * has to offer a choice the daemon has not been told about yet — and a third
 * profile would be a deliberate change to this list, not a silent one.
 */
const PROFILES: readonly { value: ExecutionProfile; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'full-access', label: 'Full Access' },
]

onMounted(() => {
  if (settings.settings === undefined) void settings.load()
})
</script>

<template>
  <PageHeader title="Settings" subtitle="Preferences, kept beside your definitions." />

  <div class="space-y-8 px-8 py-6">
    <p
      v-if="settings.error"
      class="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      {{ settings.error }}
    </p>

    <section data-testid="appearance">
      <h2 class="mb-3 font-mono text-[11px] tracking-widest text-[var(--color-ink-faint)] uppercase">
        Appearance
      </h2>
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="option in THEMES"
          :key="option.value"
          type="button"
          class="rounded-md border px-3 py-1.5 text-sm"
          :class="
            settings.theme === option.value
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
              : 'border-[var(--color-line-strong)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
          "
          :data-testid="`theme-${option.value}`"
          @click="settings.setTheme(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <p class="mt-2 text-xs text-[var(--color-ink-faint)]">
        System follows whatever your browser reports, and keeps following it if
        that changes.
      </p>

      <p class="mt-6 mb-2 text-xs text-[var(--color-ink-faint)]">Interface size</p>
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="value in SCALES"
          :key="value"
          type="button"
          class="rounded-md border px-3 py-1.5 text-sm"
          :class="
            settings.scale === value
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
              : 'border-[var(--color-line-strong)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
          "
          :data-testid="`scale-${value}`"
          @click="settings.setScale(value)"
        >
          {{ value }}×
        </button>
      </div>
      <!-- The same thing Cmd+ does, which is what was asked for — and why it
           is page zoom rather than a font size: the board has a hundred
           hard-coded pixel sizes in its badges that a font-size would leave
           behind. -->
      <p class="mt-2 text-xs text-[var(--color-ink-faint)]">
        Scales everything, the way ⌘+ does. Saved for this installation, so the
        app and a browser agree.
      </p>
    </section>

    <!-- Above the file path and below appearance: it is the setting with
         consequences, and the reading order should say so. -->
    <section data-testid="execution-profile">
      <h2 class="mb-3 font-mono text-[11px] tracking-widest text-[var(--color-ink-faint)] uppercase">
        What agents may reach
      </h2>
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="option in PROFILES"
          :key="option.value"
          type="button"
          class="rounded-md border px-3 py-1.5 text-sm"
          :class="
            settings.profile === option.value
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
              : 'border-[var(--color-line-strong)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
          "
          :data-testid="`profile-${option.value}`"
          @click="settings.setProfile(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <p class="mt-2 text-xs text-[var(--color-ink-faint)]">
        What a project gets when it has not chosen for itself. A project can
        override this on the Projects page.
      </p>
      <!-- Warned about here as well as marked in the shell. Choosing it and
           seeing nothing said would be the wrong kind of quiet. -->
      <p
        v-if="settings.unconfined"
        class="mt-3 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-4 py-3 text-xs leading-relaxed text-[var(--color-ink)]"
        data-testid="full-access-warning"
      >
        Full Access removes the workspace boundary and passes every credential
        through to the agent. Use it where you can restore the machine.
      </p>
    </section>

    <section data-testid="disclaimer-state">
      <h2 class="mb-2 font-mono text-[11px] tracking-widest text-[var(--color-ink-faint)] uppercase">
        What you agreed to
      </h2>
      <p v-if="settings.accepted === true" class="text-xs text-[var(--color-ink-muted)]">
        Accepted, version {{ settings.settings?.security?.acceptedVersion }}.
        <span class="text-[var(--color-ink-faint)]">
          Factory will ask again only if what an agent may reach changes.
        </span>
      </p>
      <div v-else-if="settings.accepted === false">
        <p class="text-xs text-[var(--color-ink-muted)]">
          Not yet accepted. No run will start until it is.
        </p>
        <!-- Acceptable from here, not only from the panel. This is the page the
             panel's own "Review permissions" link sends people to, and sending
             somebody somewhere to read and then giving them no way to agree is
             a dead end. Accepting here starts nothing: it is not "continue". -->
        <button
          type="button"
          class="mt-3 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
          data-testid="accept-here"
          @click="settings.accept()"
        >
          I understand — accept
        </button>
      </div>
      <details v-if="settings.disclaimer" class="mt-3">
        <summary
          class="cursor-pointer text-xs text-[var(--color-ink-faint)] underline"
          data-testid="read-disclaimer"
        >
          Read it
        </summary>
        <p class="mt-3 text-xs leading-relaxed text-[var(--color-ink)]">
          {{ settings.disclaimer.summary }}
        </p>
        <ul class="mt-2 space-y-1">
          <li
            v-for="point in settings.disclaimer.points"
            :key="point"
            class="text-[11px] leading-relaxed text-[var(--color-ink-muted)]"
          >
            · {{ point }}
          </li>
        </ul>
        <p class="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          {{ settings.disclaimer.caveat }}
        </p>
      </details>
    </section>

    <section v-if="settings.file" data-testid="settings-file">
      <h2 class="mb-2 font-mono text-[11px] tracking-widest text-[var(--color-ink-faint)] uppercase">
        Where this is kept
      </h2>
      <p class="font-mono text-[11px] text-[var(--color-ink-muted)]">{{ settings.file }}</p>
    </section>
  </div>
</template>
