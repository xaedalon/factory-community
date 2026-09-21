<script setup lang="ts">
import AppIcon, { type IconName } from '../AppIcon.vue'

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
    <!-- A real checkbox, visually a switch. Keyboard, form semantics and
         `:focus-visible` all come free, which a div with a click handler would
         have had to reimplement and would have got wrong.
         It is transparent rather than `sr-only`, and it lies exactly over the
         switch it draws. `sr-only` clips the input to a 1px box tucked behind
         the graphic, which nothing — a pointer, or a browser suite calling
         `check()` — can actually hit. -->
    <span class="relative mt-0.5 flex h-4 w-7 shrink-0 items-center">
      <input
        :id="id"
        type="checkbox"
        class="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        :checked="modelValue"
        :disabled="disabled"
        @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
      <span
        class="flex h-4 w-7 items-center rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-accent)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--color-surface)]"
        :class="
          modelValue
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)]'
            : 'border-[var(--color-line-strong)] bg-[var(--color-track)]'
        "
        aria-hidden="true"
      >
        <span
          class="h-3 w-3 rounded-full bg-white transition-transform"
          :class="modelValue ? 'translate-x-3.5' : 'translate-x-0.5'"
        />
      </span>
    </span>

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
