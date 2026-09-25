<script setup lang="ts">
/**
 * What is still uncertain, and who should deal with it.
 *
 * The score is the summary; this is the product. Grouped by severity rather
 * than by arrival, because a list in arrival order buries the critical finding
 * under four notes about naming — and every row says who can resolve it, which
 * is the thing that decides whether Factory can carry on without a person.
 *
 * The actions a driver offers come from the driver's status. Which of them a
 * *person* may take and which an agent may not is the daemon's, and it refuses
 * on facts a client cannot fake.
 */
import { computed, ref } from 'vue'
import AppIcon from '../AppIcon.vue'
import type { ReliabilityDriver } from '../../api/client'

const props = defineProps<{ drivers: readonly ReliabilityDriver[]; busy?: string | undefined }>()
const emit = defineEmits<{ act: [driver: ReliabilityDriver, action: string] }>()

const ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const
const ACTIVE = ['open', 'investigating']

const active = computed(() => props.drivers.filter((d) => ACTIVE.includes(d.status)))
const settled = computed(() => props.drivers.filter((d) => !ACTIVE.includes(d.status)))

const groups = computed(() =>
  ORDER.map((severity) => ({
    severity,
    items: active.value.filter((driver) => driver.severity === severity),
  })).filter((group) => group.items.length > 0),
)

const OWNER_WORDS: Record<string, string> = {
  agent: 'the agent can resolve this',
  developer: 'needs your judgement',
  either: 'either of you',
  external: 'depends on somebody else',
}

const TONES: Record<string, string> = {
  critical: 'var(--color-danger)',
  high: 'var(--color-danger)',
  medium: 'var(--color-warn)',
  low: 'var(--color-ink-muted)',
  info: 'var(--color-ink-faint)',
}

/** Asking for a reason where one is required, rather than sending without. */
const accepting = ref<string | undefined>(undefined)
const reason = ref('')

function accept(driver: ReliabilityDriver): void {
  if (accepting.value !== driver.id) {
    accepting.value = driver.id
    reason.value = ''
    return
  }
  emit('act', driver, 'accept')
  accepting.value = undefined
}

defineExpose({ reason })
</script>

<template>
  <section data-testid="reliability-drivers">
    <h2 class="mb-2 font-mono text-label text-[var(--color-ink-faint)] uppercase">
      What is holding it back
    </h2>

    <p
      v-if="active.length === 0"
      class="rounded-lg border border-dashed border-[var(--color-line)] px-6 py-8 text-center text-sm text-[var(--color-ink-muted)]"
      data-testid="reliability-drivers-empty"
    >
      Nothing outstanding. Everything found so far has been resolved or accepted.
    </p>

    <div v-for="group in groups" :key="group.severity" class="mb-4">
      <p
        class="mb-1.5 font-mono text-label uppercase"
        :style="{ color: TONES[group.severity] }"
        :data-testid="`reliability-group-${group.severity}`"
      >
        {{ group.severity }}
      </p>

      <article
        v-for="driver in group.items"
        :key="driver.id"
        class="mb-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3"
        :data-testid="`reliability-driver-${driver.id}`"
      >
        <p class="flex items-baseline justify-between gap-3">
          <span class="text-sm text-[var(--color-ink)]">{{ driver.title }}</span>
          <span
            v-if="driver.scoreImpact !== 0"
            class="value shrink-0 tabular-nums"
            :style="{ color: driver.scoreImpact > 0 ? 'var(--color-ok)' : 'var(--color-danger)' }"
            >{{ driver.scoreImpact > 0 ? `+${driver.scoreImpact}` : driver.scoreImpact }}</span
          >
        </p>
        <p v-if="driver.description !== ''" class="mt-1 text-meta text-[var(--color-ink-muted)]">
          {{ driver.description }}
        </p>

        <p class="mt-1.5 flex items-center gap-1.5 text-meta text-[var(--color-ink-faint)]">
          <AppIcon :name="driver.owner === 'developer' ? 'profile' : 'tasks'" :size="12" />
          <span :data-testid="`reliability-owner-${driver.id}`">{{ OWNER_WORDS[driver.owner] }}</span>
        </p>

        <p
          v-if="driver.recommendedAction !== undefined"
          class="mt-1 text-meta text-[var(--color-ink-muted)]"
        >
          {{ driver.recommendedAction.label }}
        </p>

        <div class="mt-2.5 flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-lg border border-[var(--color-line)] px-2.5 py-1 text-meta text-[var(--color-ink)] hover:bg-[var(--color-raised)]"
            :disabled="busy === driver.id"
            :data-testid="`reliability-resolve-${driver.id}`"
            @click="emit('act', driver, 'resolve')"
          >
            Resolved
          </button>
          <button
            type="button"
            class="rounded-lg border border-[var(--color-line)] px-2.5 py-1 text-meta text-[var(--color-ink-muted)] hover:bg-[var(--color-raised)]"
            :disabled="busy === driver.id"
            :data-testid="`reliability-accept-${driver.id}`"
            @click="accept(driver)"
          >
            {{ accepting === driver.id ? 'Accept this risk' : 'Accept the risk' }}
          </button>
        </div>

        <!-- The reason is asked for before the acceptance is sent. An
             acceptance nobody explained is indistinguishable afterwards from
             one nobody meant. -->
        <input
          v-if="accepting === driver.id"
          v-model="reason"
          type="text"
          class="mt-2 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-base)] px-2.5 py-1 text-meta text-[var(--color-ink)]"
          placeholder="Why is this acceptable?"
          :data-testid="`reliability-reason-${driver.id}`"
        />
      </article>
    </div>

    <details v-if="settled.length > 0" class="mt-3" data-testid="reliability-settled">
      <summary class="cursor-pointer text-meta text-[var(--color-ink-faint)]">
        {{ settled.length }} already dealt with
      </summary>
      <ul class="mt-2 space-y-1">
        <li
          v-for="driver in settled"
          :key="driver.id"
          class="flex items-baseline gap-2 text-meta text-[var(--color-ink-muted)]"
          :data-testid="`reliability-settled-${driver.id}`"
        >
          <AppIcon name="check" :size="12" class="shrink-0" />
          <span>{{ driver.title }}</span>
          <span class="text-[var(--color-ink-faint)]">{{ driver.status }}</span>
          <span v-if="driver.acceptedBy !== undefined" class="text-[var(--color-ink-faint)]"
            >by {{ driver.acceptedBy }}</span
          >
        </li>
      </ul>
    </details>
  </section>
</template>
