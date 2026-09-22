<script setup lang="ts">
import { computed } from 'vue'
import type { TaskState } from '../api/client.js'
import { STATE_LOOKS, fillFor } from '../states.js'

/**
 * A state, drawn.
 *
 * The prototype coloured states inline in four components, which is how
 * `blocked` ended up amber in one view and red in another — and a person
 * reading a board learns the colours before they read the words.
 *
 * That very nearly happened again by a different route. This component held the
 * one table, but it named its colours as Tailwind arbitrary values — a green
 * for done, a blue for running, an amber for approval — none of which were the
 * tokens they shadowed. Worse, a class string is not shareable, so the progress
 * bar beside the badge could not read it and drew every state in the accent.
 * The table is `states.ts` now, in custom properties, and this only spends it.
 */
const props = defineProps<{ state: TaskState | undefined }>()

const look = computed(() =>
  props.state === undefined ? undefined : STATE_LOOKS[props.state],
)
</script>

<template>
  <span
    v-if="look"
    class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-label uppercase"
    :style="{ color: look.tone, backgroundColor: fillFor(look) }"
    :data-testid="`state-${state}`"
  >
    <span class="h-1.5 w-1.5 rounded-full bg-current" />
    {{ look.label }}
  </span>
</template>
