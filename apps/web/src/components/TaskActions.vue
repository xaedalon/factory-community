<script setup lang="ts">
import AppIcon, { type IconName } from './AppIcon.vue'
import Tooltip from './Tooltip.vue'
import type { AvailableAction } from '../api/client.js'

/**
 * The buttons a task offers.
 *
 * Rendered from what the daemon sent, never from a list kept here. That is the
 * whole point of serving `actions`: the state machine is in one place, and a
 * client that decided for itself would draw an approve button on something that
 * cannot be approved the first time the rules changed.
 *
 * What is decided here is only how each one *looks*, and the daemon's own
 * `action` name is the key — a new action arrives as a plain button with its
 * label, which is a worse button than the others rather than a broken one.
 */
defineProps<{
  actions: AvailableAction[]
  busy?: boolean | undefined
  /** Actions worth showing in a crowded row. The rest stay on the detail page. */
  only?: string[] | undefined
}>()
const emit = defineEmits<{ act: [action: string] }>()

const PROMINENT = new Set(['approve', 'queue', 'retry'])

/**
 * What each action means, past its one-word label.
 *
 * `Reject` and `Cancel` sat side by side as identical grey rectangles, and the
 * difference between them — one sends the task back, the other ends it — was
 * nowhere on the screen. These are the most-pressed controls in the app and
 * several of them cannot be undone.
 */
const LOOKS: Record<string, { icon: IconName; hint: string; danger?: boolean }> = {
  queue: { icon: 'play', hint: 'Hand this to the scheduler; it starts when a lane is free' },
  retry: { icon: 'refresh', hint: 'Run the failed step again from where it stopped' },
  approve: { icon: 'check', hint: 'Accept the evidence and let the rest of the plan run' },
  reject: { icon: 'alert', hint: 'Send it back as blocked, keeping everything it produced', danger: true },
  cancel: { icon: 'stop', hint: 'Stop the task for good — agents are killed mid-sentence', danger: true },
  archive: { icon: 'export', hint: 'Take it off the board, keeping its runs and evidence' },
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5">
    <template
      v-for="entry in actions.filter((a) => only === undefined || only.includes(a.action))"
      :key="entry.action"
    >
      <Tooltip :label="LOOKS[entry.action]?.hint ?? entry.label">
        <button
          type="button"
          :disabled="busy"
          :data-testid="`action-${entry.action}`"
          class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          :class="[
            PROMINENT.has(entry.action)
              ? 'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent)]/85'
              : 'border border-[var(--color-line-strong)] text-[var(--color-ink-muted)] hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)]',
            LOOKS[entry.action]?.danger === true
              ? 'hover:border-[var(--color-danger)]/60 hover:text-[var(--color-danger)]'
              : '',
          ]"
          @click="emit('act', entry.action)"
        >
          <AppIcon v-if="LOOKS[entry.action]" :name="LOOKS[entry.action]!.icon" :size="12" />
          {{ entry.label }}
        </button>
      </Tooltip>
    </template>
  </div>
</template>
