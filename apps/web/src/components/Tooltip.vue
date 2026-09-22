<script setup lang="ts">
import { ref } from 'vue'

/**
 * What a control does, on hover — and on focus, which is the half everyone
 * forgets.
 *
 * `title` was doing this job in twenty-odd places. It is free and accessible,
 * and it is also a second-long wait, unstyleable, and invisible to anyone
 * arriving by keyboard. Once controls started carrying icons instead of words
 * that stopped being good enough: an icon with a `title` is a guessing game
 * with a delay.
 *
 * Positioned `fixed` off the trigger's own rectangle rather than absolutely
 * inside it. Half these controls sit in a table cell or the horizontally
 * scrolling task list, and an absolutely positioned bubble is clipped by the
 * first ancestor with `overflow: hidden` — which is exactly where a tooltip is
 * most needed and least likely to be tested.
 *
 * The label is not announced from here. Assistive tech reads the trigger, which
 * carries `aria-label` when it has no text of its own, so repeating it would
 * say everything twice.
 */
const props = defineProps<{ label: string; placement?: 'top' | 'bottom' | undefined }>()

const shown = ref(false)
const x = ref(0)
const y = ref(0)
const anchor = ref<HTMLElement | undefined>(undefined)

/**
 * Measure the control, not the wrapper.
 *
 * The wrapper is `display: contents` so it cannot disturb the layout it sits
 * in — which also means it has no box of its own, and
 * `getBoundingClientRect()` on it is all zeros. Reading that put every tooltip
 * at the top-left corner of the window, a long way from whatever was hovered.
 * The slotted element is the thing with a position.
 */
const show = (): void => {
  const target = anchor.value?.firstElementChild ?? anchor.value
  const box = target?.getBoundingClientRect()
  if (box === undefined || (box.width === 0 && box.height === 0)) return
  x.value = box.left + box.width / 2
  y.value = props.placement === 'bottom' ? box.bottom + 8 : box.top - 8
  shown.value = true
}
const hide = (): void => {
  shown.value = false
}
</script>

<template>
  <span
    ref="anchor"
    class="contents"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
    @click="hide"
  >
    <slot />
  </span>

  <!-- To `body`, so no ancestor's `overflow` or stacking context can clip it. -->
  <Teleport to="body">
    <span
      v-if="shown"
      role="tooltip"
      data-testid="tooltip"
      class="pointer-events-none fixed z-50 max-w-[18rem] rounded-md border border-[var(--color-line-strong)] bg-[var(--color-overlay)] px-2 py-1 text-xs whitespace-nowrap text-[var(--color-ink)] shadow-lg"
      :style="{
        left: `${x}px`,
        top: `${y}px`,
        transform: placement === 'bottom' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
      }"
    >
      {{ label }}
    </span>
  </Teleport>
</template>
