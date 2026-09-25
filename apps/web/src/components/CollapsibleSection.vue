<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * A section that folds, over a native `<details>`.
 *
 * `<details>` rather than a `v-if` because a folded section still has to be
 * *there*: the heading is what somebody scans for, and a page whose long
 * sections vanish reads as a page missing them. The browser also gives the
 * keyboard and screen-reader behaviour for free, which the three hand-rolled
 * toggles elsewhere in this app each implement slightly differently.
 *
 * `open` seeds the state rather than binding it. Whether a section starts
 * folded is a question about the data — did a step fail, is a decision waiting
 * — and it is asked once, when the page has loaded. After that the person's own
 * toggle wins, which a bound prop would undo on the next poll.
 */
const props = defineProps<{
  title: string
  testid: string
  /** Whether it starts unfolded. Read once, when it first becomes defined. */
  open?: boolean | undefined
}>()

const unfolded = ref(props.open ?? false)
let seeded = props.open !== undefined

watch(
  () => props.open,
  (value) => {
    if (seeded || value === undefined) return
    seeded = true
    unfolded.value = value
  },
)
</script>

<template>
  <details :open="unfolded" :data-testid="testid" @toggle="unfolded = ($event.target as HTMLDetailsElement).open">
    <summary
      class="mb-2 flex cursor-pointer list-none items-center gap-2 text-title marker:content-none"
      :data-testid="`${testid}-toggle`"
    >
      <span
        class="text-[var(--color-ink-faint)] transition-transform"
        :class="unfolded ? 'rotate-90' : ''"
        aria-hidden="true"
      >›</span>
      <h2 class="text-title">{{ props.title }}</h2>
      <slot name="aside" />
    </summary>
    <slot />
  </details>
</template>
