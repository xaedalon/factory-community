<script setup lang="ts">
import AppIcon, { type IconName } from '../AppIcon.vue'

// Optional props accept an explicit `undefined` because that is what a Vue
// template binds when a value is absent, and `exactOptionalPropertyTypes`
// distinguishes "missing" from "present and undefined".
defineProps<{
  label: string
  hint?: string | undefined
  for?: string | undefined
  /** Beside the label, so a field is recognisable before it is read. */
  icon?: IconName | undefined
  /** Marks the field, and is what the form refuses to submit without. */
  required?: boolean | undefined
  /** What went wrong with this field, from whichever side found out. */
  error?: string | undefined
}>()
</script>

<template>
  <div class="grid grid-cols-[9rem_1fr] items-start gap-4 py-2">
    <label
      :for="$props.for"
      class="flex items-center gap-1.5 pt-1.5 font-mono text-label text-[var(--color-ink-faint)] uppercase"
    >
      <AppIcon v-if="icon" :name="icon" :size="12" />
      {{ label }}
      <!-- The asterisk is `aria-hidden` and the word carries the meaning, so
           nobody has to know what a red star means. -->
      <span v-if="required" class="text-[var(--color-danger)]" aria-hidden="true">*</span>
      <span v-if="required" class="sr-only">(required)</span>
    </label>
    <div class="min-w-0">
      <slot />
      <p v-if="hint" class="mt-1 text-xs leading-relaxed text-[var(--color-ink-faint)]">
        {{ hint }}
      </p>
      <!-- Under the field it belongs to, not in a banner at the top of the
           form: an error that does not say which box is wrong makes you check
           all of them. -->
      <p
        v-if="error"
        class="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-[var(--color-danger)]"
        :data-testid="`field-error-${label.toLowerCase().replace(/\s+/g, '-')}`"
      >
        <AppIcon name="alert" :size="12" class="mt-0.5" />
        {{ error }}
      </p>
    </div>
  </div>
</template>
