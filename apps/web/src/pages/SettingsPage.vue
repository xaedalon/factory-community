<script setup lang="ts">
import { onMounted } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import AppButton from '../components/AppButton.vue'
import AppIcon, { type IconName } from '../components/AppIcon.vue'
import Tooltip from '../components/Tooltip.vue'
import { useClipboard } from '../composables/useClipboard.js'
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
const THEMES: readonly { value: UiTheme; label: string; icon: IconName }[] = [
  { value: 'light', label: 'Light', icon: 'light' },
  { value: 'dark', label: 'Dark', icon: 'night' },
  { value: 'system', label: 'System', icon: 'system' },
]

/**
 * The two profiles, with the names a person reads.
 *
 * Spelled here rather than derived from the served settings, because the board
 * has to offer a choice the daemon has not been told about yet — and a third
 * profile would be a deliberate change to this list, not a silent one.
 */
const PROFILES: readonly { value: ExecutionProfile; label: string; icon: IconName; hint: string }[] =
  [
    {
      value: 'default',
      label: 'Default',
      icon: 'profile',
      hint: 'An agent is confined to the workspace and handed an environment with the credentials taken out',
    },
    {
      value: 'full-access',
      label: 'Full Access',
      icon: 'alert',
      hint: 'No workspace boundary, and every credential passed through',
    },
  ]

const { copied, copy } = useClipboard()

onMounted(() => {
  if (settings.settings === undefined) void settings.load()
})
</script>

<template>
  <PageHeader title="Settings" subtitle="Preferences, kept beside your definitions." />

  <div class="page-body">
    <p
      v-if="settings.error"
      class="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      <AppIcon name="alert" class="mr-1 inline-block align-[-2px]" />
      {{ settings.error }}
    </p>

    <!-- One group, not four page-level blocks. A column of bordered cards sits
         8px apart everywhere else in the app — the plugin list, the setup
         steps, the scope chain — and these were inheriting the 24px that
         separates unlike sections because they were direct children of
         `.page-body`. -->
    <div class="space-y-2">

    <!-- A card per setting. These were four unbounded stacks separated by
         whitespace, so a heading, its buttons and the paragraph explaining them
         had nothing saying they belonged together. -->
    <section
      class="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
      data-testid="appearance"
    >
      <h2 class="mb-3 flex items-center gap-2 text-title">
        <AppIcon name="light" :size="15" class="text-[var(--color-ink-muted)]" />
        Appearance
      </h2>
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="option in THEMES"
          :key="option.value"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors"
          :class="
            settings.theme === option.value
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
              : 'border-[var(--color-line-strong)] text-[var(--color-ink-muted)] hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)]'
          "
          :aria-pressed="settings.theme === option.value"
          :data-testid="`theme-${option.value}`"
          @click="settings.setTheme(option.value)"
        >
          <AppIcon :name="option.icon" :size="13" />
          {{ option.label }}
        </button>
      </div>
      <p class="mt-2 text-xs text-[var(--color-ink-faint)]">
        System follows whatever your browser reports, and keeps following it if
        that changes.
      </p>

      <p class="mt-6 mb-2 font-mono text-label text-[var(--color-ink-faint)] uppercase">
        Interface size
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <Tooltip v-for="value in SCALES" :key="value" :label="`Scale the whole interface to ${value}×`">
          <button
            type="button"
            class="rounded-md border px-3 py-1.5 text-sm transition-colors"
            :class="
              settings.scale === value
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
                : 'border-[var(--color-line-strong)] text-[var(--color-ink-muted)] hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)]'
            "
            :aria-pressed="settings.scale === value"
            :data-testid="`scale-${value}`"
            @click="settings.setScale(value)"
          >
            {{ value }}×
          </button>
        </Tooltip>
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
    <section
      class="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
      data-testid="execution-profile"
    >
      <h2 class="mb-3 flex items-center gap-2 text-title">
        <AppIcon name="profile" :size="15" class="text-[var(--color-ink-muted)]" />
        What agents may reach
      </h2>
      <div class="flex flex-wrap items-center gap-2">
        <!-- The hint is the consequence, not the name. This is the setting a
             person is most likely to change without knowing what it costs. -->
        <Tooltip v-for="option in PROFILES" :key="option.value" :label="option.hint">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors"
            :class="
              settings.profile === option.value
                ? option.value === 'full-access'
                  ? 'border-[var(--color-warn)] bg-[var(--color-warn)]/10 text-[var(--color-warn)]'
                  : 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
                : 'border-[var(--color-line-strong)] text-[var(--color-ink-muted)] hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)]'
            "
            :aria-pressed="settings.profile === option.value"
            :data-testid="`profile-${option.value}`"
            @click="settings.setProfile(option.value)"
          >
            <AppIcon :name="option.icon" :size="13" />
            {{ option.label }}
          </button>
        </Tooltip>
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
        <AppIcon name="alert" :size="13" class="mr-1 inline-block align-[-2px]" />
        Full Access removes the workspace boundary and passes every credential
        through to the agent. Use it where you can restore the machine.
      </p>
    </section>

    <section
      class="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
      data-testid="disclaimer-state"
    >
      <h2 class="mb-2 flex items-center gap-2 text-title">
        <AppIcon :name="settings.accepted === true ? 'check' : 'alert'" :size="15"
          :class="settings.accepted === true ? 'text-[var(--color-ok)]' : 'text-[var(--color-warn)]'" />
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
        <div class="mt-3">
          <AppButton
            label="I understand — accept"
            icon="check"
            tone="primary"
            hint="Records that you have read this. It starts nothing."
            data-testid="accept-here"
            @click="settings.accept()"
          />
        </div>
      </div>
      <details v-if="settings.disclaimer" class="mt-3">
        <summary
          class="inline-flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
          data-testid="read-disclaimer"
        >
          <AppIcon name="go" :size="11" />
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

    <section
      v-if="settings.file"
      class="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
      data-testid="settings-file"
    >
      <h2 class="mb-2 flex items-center gap-2 text-title">
        <AppIcon name="folder" :size="15" class="text-[var(--color-ink-muted)]" />
        Where this is kept
      </h2>
      <!-- A path on screen with no way to take it is a path you retype. -->
      <Tooltip label="Copy the path">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-base)] px-3 py-2 text-left font-mono text-meta text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
          data-testid="copy-settings-file"
          @click="copy(settings.file)"
        >
          <AppIcon name="copy" :size="11" class="shrink-0" />
          <span class="min-w-0 flex-1 break-all">{{ settings.file }}</span>
          <span v-if="copied === settings.file" class="shrink-0 text-[var(--color-ok)]">copied</span>
        </button>
      </Tooltip>
    </section>
    </div>
  </div>
</template>
