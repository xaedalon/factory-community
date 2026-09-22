<script setup lang="ts">
import AppIcon, { type IconName } from '../AppIcon.vue'
import SwitchInput from './SwitchInput.vue'

/**
 * A setting that is on or off, and says what it means both ways.
 *
 * The projects form had these as bare checkboxes with the explanation running
 * on inside the label — "A worktree per task — off: work happens in the
 * repository, one task at a time" — so the consequence of the setting was a
 * sentence you had to finish reading to discover, in 12px grey, wrapped across
 * a flex row. The same two settings appeared again in the project list as
 * *buttons* labelled with the state they would move to, which is the one
 * labelling scheme nobody can read without trying it.
 *
 * So: a real switch, the current position visible, and one line underneath
 * saying what this position means — not what the other one would.
 */
withDefaults(
  defineProps<{
    modelValue: boolean
    label: string
    /** What being on means, and what being off means. Shown for the live one. */
    whenOn: string
    whenOff: string
    icon?: IconName | undefined
    disabled?: boolean | undefined
    /** Why it cannot be changed, when it cannot. */
    disabledReason?: string | undefined
    id?: string | undefined
  }>(),
  { disabled: false },
)
defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <label
    class="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 transition-colors"
    :class="
      disabled
        ? 'cursor-not-allowed opacity-60'
        : 'hover:border-[var(--color-line-strong)] hover:bg-[var(--color-veil-weak)]'
    "
  >
    <SwitchInput
      :id="id"
      :model-value="modelValue"
      :disabled="disabled"
      class="mt-0.5"
      @update:model-value="$emit('update:modelValue', $event)"
    />

    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5 text-sm text-[var(--color-ink)]">
        <AppIcon v-if="icon" :name="icon" />
        {{ label }}
      </span>
      <span class="mt-0.5 block text-xs leading-relaxed text-[var(--color-ink-muted)]">
        {{ modelValue ? whenOn : whenOff }}
      </span>
      <span
        v-if="disabled && disabledReason"
        class="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-warn)]"
      >
        <AppIcon name="alert" :size="12" />
        {{ disabledReason }}
      </span>
    </span>
  </label>
</template>
