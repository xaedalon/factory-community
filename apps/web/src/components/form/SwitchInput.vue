<script setup lang="ts">
/**
 * The switch itself, with no label and no card around it.
 *
 * Pulled out of `ToggleField` when the plugins list needed the same control in
 * a table row: a full field with a heading and two descriptions is right for a
 * settings form and far too much for one cell. One drawn switch, used by both,
 * so an on/off control is the same object wherever it appears.
 *
 * A real checkbox underneath, transparent and laid exactly over the graphic.
 * `sr-only` clips an input to a 1px box tucked behind whatever replaces it,
 * which nothing can hit — not a pointer, and not a browser suite calling
 * `check()`. That cost an afternoon once already.
 */
withDefaults(
  defineProps<{
    modelValue: boolean
    disabled?: boolean | undefined
    id?: string | undefined
    /** The accessible name, when there is no visible label beside it. */
    label?: string | undefined
  }>(),
  { disabled: false },
)
defineEmits<{ 'update:modelValue': [value: boolean] }>()

/**
 * Attributes reach the checkbox, not the span around it.
 *
 * The same trap `AppButton` fell into: Vue puts fallthrough attributes on the
 * root, and the root here is a positioning wrapper. A `data-testid` landing on
 * it points at something nothing can click — which is exactly how the plugins
 * list ended up with a switch a test could find and not throw.
 */
defineOptions({ inheritAttrs: false })
</script>

<template>
  <span class="relative inline-flex h-4 w-7 shrink-0 items-center">
    <input
      :id="id"
      v-bind="$attrs"
      type="checkbox"
      class="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      :checked="modelValue"
      :disabled="disabled"
      :aria-label="label"
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
</template>
