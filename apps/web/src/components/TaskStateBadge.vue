<script setup lang="ts">
import { computed } from 'vue'
import type { TaskState } from '../api/client.js'

/**
 * One place that decides what a state looks like.
 *
 * The prototype coloured states inline in four components, which is how
 * `blocked` ended up amber in one view and red in another — and a person
 * reading a board learns the colours before they read the words.
 */
const props = defineProps<{ state: TaskState | undefined }>()

const LOOKS: Record<TaskState, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'text-[var(--color-ink-muted)] bg-[var(--color-veil-strong)]' },
  queued: { label: 'Queued', tone: 'text-[#a78bfa] bg-[#a78bfa]/10' },
  running: { label: 'Running', tone: 'text-[#38bdf8] bg-[#38bdf8]/10' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'text-[#fbbf24] bg-[#fbbf24]/10' },
  blocked: { label: 'Blocked', tone: 'text-[var(--color-danger)] bg-[var(--color-danger)]/10' },
  done: { label: 'Done', tone: 'text-[#34d399] bg-[#34d399]/10' },
  cancelled: { label: 'Cancelled', tone: 'text-[var(--color-ink-faint)] bg-[var(--color-veil)]' },
  archived: { label: 'Archived', tone: 'text-[var(--color-ink-faint)] bg-[var(--color-veil)]' },
}

const look = computed(() => (props.state === undefined ? undefined : LOOKS[props.state]))
</script>

<template>
  <span
    v-if="look"
    class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase"
    :class="look.tone"
    :data-testid="`state-${state}`"
  >
    <span class="h-1.5 w-1.5 rounded-full bg-current" />
    {{ look.label }}
  </span>
</template>
