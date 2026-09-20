<script setup lang="ts">
import { computed } from 'vue'
import type { TaskState } from '../api/client.js'

/**
 * One place that decides what a state looks like.
 *
 * The prototype coloured states inline in four components, which is how
 * `blocked` ended up amber in one view and red in another — and a person
 * reading a board learns the colours before they read the words.
 *
 * That very nearly happened again by a different route. This table was the one
 * place, but it named its colours as Tailwind arbitrary values — a green for
 * done, a blue for running, an amber for approval — none of which were the
 * tokens they shadowed, and all three visibly different from them. So
 * the token file said one thing, the badge drew another, and four more files
 * copied the badge rather than the token. `tokens.css` is the only place a
 * colour is chosen; here it is only spent.
 */
const props = defineProps<{ state: TaskState | undefined }>()

const LOOKS: Record<TaskState, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'text-[var(--color-ink-muted)] bg-white/[0.06]' },
  queued: { label: 'Queued', tone: 'text-[var(--color-pending)] bg-[var(--color-pending)]/10' },
  running: { label: 'Running', tone: 'text-[var(--color-info)] bg-[var(--color-info)]/10' },
  awaiting_approval: {
    label: 'Awaiting approval',
    tone: 'text-[var(--color-warn)] bg-[var(--color-warn)]/10',
  },
  blocked: { label: 'Blocked', tone: 'text-[var(--color-danger)] bg-[var(--color-danger)]/10' },
  done: { label: 'Done', tone: 'text-[var(--color-ok)] bg-[var(--color-ok)]/10' },
  cancelled: { label: 'Cancelled', tone: 'text-[var(--color-ink-faint)] bg-white/[0.04]' },
  archived: { label: 'Archived', tone: 'text-[var(--color-ink-faint)] bg-white/[0.04]' },
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
