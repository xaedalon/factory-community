<script setup lang="ts">
/**
 * How the task got to the number it is at.
 *
 * Hand-rolled SVG. There is no charting library in this application and the
 * nearest prior art is a progress bar made of two spans — one polyline with
 * points on it is not a reason to take a dependency, and `CONTRIBUTING.md`
 * asks for the sentence justifying one.
 *
 * **The line must be able to go down.** A validation that finds a regression
 * has learned something, and a graph that could only rise would be hiding the
 * most useful thing this feature produces. So the y-axis is fixed rather than
 * fitted: a range that adapted to the data would make a three-point fall look
 * like a cliff, and every task's graph would be incomparable with every other.
 */
import { computed, ref } from 'vue'
import type { ReliabilityAssessment } from '../../api/client'

const props = defineProps<{ history: readonly ReliabilityAssessment[] }>()

/** The drawing box. Viewport units, scaled by the SVG itself. */
const W = 320
const H = 120
const PAD = { left: 26, right: 8, top: 10, bottom: 20 }

const points = computed(() =>
  props.history.map((entry, index) => {
    const span = Math.max(1, props.history.length - 1)
    const x = PAD.left + ((W - PAD.left - PAD.right) * index) / span
    // Fixed 0–100, so two tasks' graphs mean the same thing and a small fall
    // looks small.
    const y = PAD.top + (H - PAD.top - PAD.bottom) * (1 - entry.score / 100)
    return { entry, x, y }
  }),
)

const line = computed(() =>
  points.value.map((point) => `${String(point.x)},${String(point.y)}`).join(' '),
)

const hovered = ref<number | undefined>(undefined)
const shown = computed(() =>
  hovered.value === undefined ? points.value.at(-1) : points.value[hovered.value],
)

/** The gridlines worth drawing: the ends and the middle. */
const marks = [0, 50, 100]
function yFor(score: number): number {
  return PAD.top + (H - PAD.top - PAD.bottom) * (1 - score / 100)
}
</script>

<template>
  <section data-testid="reliability-graph">
    <h2 class="mb-2 font-mono text-label text-[var(--color-ink-faint)] uppercase">
      How it got here
    </h2>

    <p
      v-if="history.length === 0"
      class="rounded-lg border border-dashed border-[var(--color-line)] px-6 py-8 text-center text-sm text-[var(--color-ink-muted)]"
      data-testid="reliability-graph-empty"
    >
      Nothing has judged this task yet.
    </p>

    <template v-else>
      <svg
        :viewBox="`0 0 ${W} ${H}`"
        class="w-full"
        role="img"
        :aria-label="`Reliability over ${history.length} assessments, ending at ${history.at(-1)?.score ?? 0} out of 100`"
      >
        <g>
          <line
            v-for="mark in marks"
            :key="mark"
            :x1="PAD.left"
            :x2="W - PAD.right"
            :y1="yFor(mark)"
            :y2="yFor(mark)"
            stroke="var(--color-line)"
            stroke-width="1"
          />
          <text
            v-for="mark in marks"
            :key="`label-${mark}`"
            :x="PAD.left - 5"
            :y="yFor(mark) + 3"
            text-anchor="end"
            font-size="8"
            fill="var(--color-ink-faint)"
          >
            {{ mark }}
          </text>
        </g>

        <polyline
          :points="line"
          fill="none"
          stroke="var(--color-accent)"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
          data-testid="reliability-line"
        />

        <g>
          <circle
            v-for="(point, index) in points"
            :key="point.entry.id"
            :cx="point.x"
            :cy="point.y"
            :r="hovered === index ? 5 : 3.5"
            :fill="
              point.entry.delta < 0 ? 'var(--color-danger)' : 'var(--color-accent)'
            "
            :data-testid="`reliability-point-${index}`"
            :data-score="point.entry.score"
            :data-delta="point.entry.delta"
            tabindex="0"
            role="button"
            :aria-label="`${point.entry.workflow ?? 'assessment'}: ${point.entry.score}, coverage ${point.entry.coverage} percent`"
            @mouseenter="hovered = index"
            @mouseleave="hovered = undefined"
            @focus="hovered = index"
            @blur="hovered = undefined"
          />
        </g>
      </svg>

      <!-- The detail for whichever point is under the pointer, and the last one
           otherwise. A tooltip that only appeared on hover would be invisible
           to anybody reading with a keyboard. -->
      <div v-if="shown !== undefined" class="mt-1" data-testid="reliability-point-detail">
        <p class="text-sm text-[var(--color-ink)]">
          <span class="font-mono">{{ shown.entry.workflow ?? 'assessment' }}</span>
          <span class="value ml-2">{{ shown.entry.score }}</span>
          <span
            v-if="shown.entry.delta !== 0"
            class="ml-1 font-mono text-meta"
            :style="{
              color: shown.entry.delta > 0 ? 'var(--color-ok)' : 'var(--color-danger)',
            }"
            >{{ shown.entry.delta > 0 ? `↑ +${shown.entry.delta}` : `↓ ${shown.entry.delta}` }}</span
          >
          <span class="ml-2 text-meta text-[var(--color-ink-muted)]"
            >coverage {{ shown.entry.coverage }}%</span
          >
        </p>
        <p v-if="shown.entry.summary !== ''" class="text-meta text-[var(--color-ink-muted)]">
          {{ shown.entry.summary }}
        </p>
        <ul
          v-if="shown.entry.explanation.causes.length > 0"
          class="mt-1 space-y-0.5"
          data-testid="reliability-causes"
        >
          <li
            v-for="(cause, index) in shown.entry.explanation.causes"
            :key="index"
            class="text-meta text-[var(--color-ink-muted)]"
          >
            <span
              v-if="cause.amount !== 0"
              class="font-mono"
              :style="{ color: cause.amount > 0 ? 'var(--color-ok)' : 'var(--color-danger)' }"
              >{{ cause.amount > 0 ? `+${cause.amount}` : cause.amount }}</span
            >
            {{ cause.summary }}
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
