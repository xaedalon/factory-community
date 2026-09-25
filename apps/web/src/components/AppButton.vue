<script setup lang="ts">
import { computed } from 'vue'
import AppIcon, { type IconName } from './AppIcon.vue'
import Tooltip from './Tooltip.vue'

/**
 * A button, with the icon and the explanation built in.
 *
 * Every button in the app was its own hand-written class string, so "the
 * primary one" was a colour somebody remembered and destructive actions looked
 * exactly like harmless ones — `Remove` and `Use environments` were the same
 * bordered grey rectangle, side by side, and only one of them ends a project.
 *
 * Three tones, because three is what the app actually distinguishes: the thing
 * you probably came to do, everything else, and the one that cannot be undone.
 *
 * `label` is always required even when `iconOnly` hides it, so the control is
 * never nameless to a screen reader or to a tooltip.
 */
const props = withDefaults(
  defineProps<{
    label: string
    icon?: IconName | undefined
    tone?: 'primary' | 'normal' | 'danger' | undefined
    /** The word is dropped, the meaning is not: it becomes the accessible name. */
    iconOnly?: boolean | undefined
    /** Says what the button does, beyond what its word already says. */
    hint?: string | undefined
    type?: 'button' | 'submit' | undefined
    disabled?: boolean | undefined
  }>(),
  { tone: 'normal', type: 'button' },
)

/**
 * Attributes go to the button, not to the wrapper.
 *
 * Vue's default is to put fallthrough attributes on the root element, and this
 * component's root is a tooltip — which itself has two root nodes, so they were
 * dropped on the floor with a warning nobody reads. Every `data-testid` and
 * every `class` a caller passed simply vanished, and the first thing that
 * noticed was the browser suite waiting thirty seconds for a button.
 */
defineOptions({ inheritAttrs: false })

const TONES = {
  primary:
    'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent)]/85 border border-transparent',
  normal:
    'border border-[var(--color-line-strong)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:bg-[var(--color-veil-weak)]',
  danger:
    'border border-[var(--color-line-strong)] text-[var(--color-ink-muted)] hover:border-[var(--color-danger)]/60 hover:text-[var(--color-danger)] hover:bg-[var(--color-danger)]/5',
} as const

// Only when there is something to add. A tooltip repeating the word on the
// button is noise that follows the pointer around.
const tip = computed(() => props.hint ?? (props.iconOnly ? props.label : undefined))
</script>

<template>
  <component :is="tip ? Tooltip : 'span'" v-bind="tip ? { label: tip } : {}" :class="tip ? '' : 'contents'">
    <button
      v-bind="$attrs"
      :type="type"
      :disabled="disabled"
      :aria-label="iconOnly ? label : undefined"
      class="inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      :class="[TONES[tone], iconOnly ? 'px-2' : '']"
    >
      <AppIcon v-if="icon" :name="icon" />
      <span v-if="!iconOnly">{{ label }}</span>
    </button>
  </component>
</template>
