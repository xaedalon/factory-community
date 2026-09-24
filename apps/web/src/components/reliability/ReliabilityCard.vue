<script setup lang="ts">
/**
 * How much to trust this task, in the rail.
 *
 * Two numbers, always together. Either alone misleads: a 93 with 20% coverage
 * is not the same claim as a 93 with 96%, and showing only the first is how a
 * confidence number becomes flattery.
 *
 * Nothing here computes anything. The score, the coverage, the dimensions and
 * the ceilings all arrive judged — a component that did arithmetic would be a
 * second implementation of the scoring engine, and the wrong one.
 */
import { computed, ref } from 'vue'
import AppIcon from '../AppIcon.vue'
import type { ReliabilitySummary } from '../../api/client'

const props = defineProps<{ reliability: ReliabilitySummary; assessing?: boolean | undefined }>()
defineEmits<{ assess: [] }>()

const waiting = computed(() => {
  const a = props.reliability.attention
  return a.agent + a.developer + a.either + a.external
})

const open = ref(false)

/** `regressionSafety` reads badly under a number. */
function label(name: string): string {
  return name.replace(/([A-Z])/g, ' $1').toLowerCase()
}

/**
 * The tone a score is drawn in.
 *
 * Never the only signal — the number is right there, and the delta carries an
 * arrow. This is emphasis, not information.
 */
const tone = computed(() => {
  const score = props.reliability.score ?? 0
  if (score >= 90) return 'var(--color-ok)'
  if (score >= 75) return 'var(--color-info)'
  if (score >= 60) return 'var(--color-warn)'
  return 'var(--color-danger)'
})
</script>

<template>
  <section
    class="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-3.5"
    data-testid="reliability-card"
  >
    <h2 class="mb-2 font-mono text-label text-[var(--color-ink-faint)] uppercase">Reliability</h2>

    <template v-if="reliability.state === 'unassessed'">
      <p class="text-sm text-[var(--color-ink-muted)]" data-testid="reliability-unassessed">
        Not assessed yet. Run a workflow, or ask for a judgement now.
      </p>
      <button
        type="button"
        class="mt-3 w-full rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm text-[var(--color-ink)] hover:bg-[var(--color-raised)]"
        data-testid="reliability-assess"
        :disabled="assessing"
        @click="$emit('assess')"
      >
        {{ assessing ? 'Assessing…' : 'Assess now' }}
      </button>
    </template>

    <template v-else>
      <p class="flex items-baseline gap-1.5">
        <span
          class="font-mono text-metric tabular-nums"
          :style="{ color: tone }"
          data-testid="reliability-score"
          >{{ reliability.score }}</span
        >
        <span class="text-sm text-[var(--color-ink-faint)]">/ 100</span>
      </p>

      <!-- Written, not drawn: the arrow carries the sign, so nothing here
           depends on telling red from green. -->
      <p
        v-if="reliability.delta !== undefined && reliability.delta !== 0"
        class="mt-0.5 font-mono text-meta"
        :style="{ color: reliability.delta > 0 ? 'var(--color-ok)' : 'var(--color-danger)' }"
        data-testid="reliability-delta"
      >
        {{ reliability.delta > 0 ? `↑ +${reliability.delta}` : `↓ ${reliability.delta}` }}
        since the last judgement
      </p>

      <p class="mt-2 text-sm text-[var(--color-ink-muted)]" data-testid="reliability-coverage">
        Evidence coverage
        <span class="value text-[var(--color-ink)]">{{ reliability.coverage }}%</span>
      </p>
      <span
        class="mt-1 block h-1 w-full overflow-hidden rounded-full bg-[var(--color-track)]"
        aria-hidden="true"
      >
        <span
          class="block h-full bg-[var(--color-accent)]"
          :style="{ width: `${reliability.coverage ?? 0}%` }"
        />
      </span>

      <p
        v-if="reliability.state === 'stale'"
        class="mt-2.5 flex items-start gap-1.5 text-meta text-[var(--color-warn)]"
        data-testid="reliability-stale"
      >
        <AppIcon name="alert" :size="12" class="mt-0.5 shrink-0" />
        <span>{{ reliability.staleReason }}</span>
      </p>

      <p
        v-for="cap in reliability.caps ?? []"
        :key="cap.type"
        class="mt-2.5 flex items-start gap-1.5 text-meta text-[var(--color-warn)]"
        data-testid="reliability-cap"
      >
        <AppIcon name="alert" :size="12" class="mt-0.5 shrink-0" />
        <span>Held at {{ cap.value }} — {{ cap.reason }}</span>
      </p>

      <p
        class="mt-2.5 text-meta text-[var(--color-ink-muted)]"
        data-testid="reliability-attention"
      >
        <template v-if="waiting === 0">Nothing outstanding.</template>
        <template v-else>
          {{ waiting }} needing attention ·
          <span class="text-[var(--color-ink)]">{{ reliability.attention.agent }}</span> the agent
          can resolve ·
          <span class="text-[var(--color-ink)]">{{ reliability.attention.developer }}</span> for you
        </template>
      </p>

      <button
        type="button"
        class="mt-2.5 flex w-full items-center justify-between text-meta text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
        :aria-expanded="open"
        data-testid="reliability-breakdown-toggle"
        @click="open = !open"
      >
        <span>{{ open ? 'Hide' : 'Show' }} the breakdown</span>
        <AppIcon :name="open ? 'up' : 'down'" :size="12" />
      </button>

      <dl v-if="open" class="mt-2 space-y-1" data-testid="reliability-breakdown">
        <div
          v-for="(value, name) in reliability.dimensions ?? {}"
          :key="name"
          class="flex items-baseline justify-between gap-2"
        >
          <dt class="text-meta text-[var(--color-ink-muted)]">{{ label(String(name)) }}</dt>
          <dd class="value text-[var(--color-ink)] tabular-nums">{{ value }}</dd>
        </div>
        <div
          v-if="reliability.rawScore !== undefined && reliability.rawScore !== reliability.score"
          class="flex items-baseline justify-between gap-2 border-t border-[var(--color-line)] pt-1"
        >
          <dt class="text-meta text-[var(--color-ink-faint)]">before the ceiling</dt>
          <dd class="value text-[var(--color-ink-faint)] tabular-nums">
            {{ reliability.rawScore }}
          </dd>
        </div>
      </dl>
    </template>
  </section>
</template>
