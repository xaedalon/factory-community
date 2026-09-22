<script setup lang="ts">
import AppIcon from '../AppIcon.vue'
import Tooltip from '../Tooltip.vue'
import { computed, ref } from 'vue'
import type { StepKindEntry, TokenNamespace } from '../../api/client.js'
import SchemaFields from './SchemaFields.vue'
import SelectInput from './SelectInput.vue'
import TokenDictionary from './TokenDictionary.vue'

/**
 * The ordered steps of a phase.
 *
 * Row types come from the step-kind registry, not from a list in this file. A
 * plugin's kind appears in the dropdown and gets generated fields, and this
 * component does not know the names of the ones that ship.
 */
type Step = { uses: string } & Record<string, unknown>

const props = defineProps<{
  modelValue: Step[]
  kinds: StepKindEntry[]
  /** Values for the sets a kind's schema names but cannot contain. */
  catalogues?: Record<string, readonly string[]> | undefined
  /** What `{{ namespace.key }}` may say. Omitted, the dictionary is not shown. */
  tokens?: TokenNamespace[] | undefined
  /** The definition's own `variables:`, so the dictionary can list them. */
  declaredVariables?: Record<string, Readonly<Record<string, string>>> | undefined
}>()
const emit = defineEmits<{ 'update:modelValue': [value: Step[]] }>()

const open = ref<number | undefined>(0)
const kindIds = computed(() => props.kinds.map((kind) => kind.id))
const kindFor = (uses: string) => props.kinds.find((kind) => kind.id === uses)

function update(index: number, step: Step): void {
  emit(
    'update:modelValue',
    props.modelValue.map((existing, position) => (position === index ? step : existing)),
  )
}
function setKind(index: number, uses: string): void {
  // Fields belong to the kind that declared them, so switching kind drops them
  // rather than carrying `run:` into an agent step where it is invalid.
  update(index, { uses })
}
function setFields(index: number, fields: Record<string, unknown>): void {
  update(index, { ...fields, uses: props.modelValue[index]?.uses ?? 'shell' })
}
function add(): void {
  const uses = kindIds.value[0] ?? 'shell'
  emit('update:modelValue', [...props.modelValue, { uses }])
  open.value = props.modelValue.length
}
const remove = (index: number) =>
  emit(
    'update:modelValue',
    props.modelValue.filter((_, position) => position !== index),
  )
function move(index: number, delta: number): void {
  const next = [...props.modelValue]
  const target = index + delta
  if (target < 0 || target >= next.length) return
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved as Step)
  emit('update:modelValue', next)
  open.value = target
}

/** One line describing the step, so a collapsed row still says what it does. */
function summarise(step: Step): string {
  const kind = kindFor(step.uses)
  const sugar = kind?.sugarKey
  if (sugar !== undefined && typeof step[sugar] === 'string') return step[sugar] as string
  if (typeof step.prompt === 'string') return (step.prompt as string).split('\n')[0] ?? ''
  return kind?.summary ?? step.uses
}

const fieldsOf = (step: Step): Record<string, unknown> => {
  const { uses: _kind, ...rest } = step
  return rest
}
</script>

<template>
  <div class="space-y-2" data-testid="steps-editor">
    <p v-if="modelValue.length === 0" class="text-sm text-[var(--color-ink-faint)]">
      No steps yet. A phase with no steps does nothing.
    </p>

    <div
      v-for="(step, index) in modelValue"
      :key="index"
      class="overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]"
      :data-testid="`step-${index}`"
    >
      <div class="flex items-center gap-3 px-3 py-2">
        <!-- A drawn chevron with a name. "▾" and "▸" are characters, so this
             read as "black down-pointing small triangle" and had no state a
             screen reader could report. -->
        <button
          type="button"
          class="rounded p-0.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)]"
          :aria-expanded="open === index"
          :aria-label="open === index ? 'Hide this step' : 'Show this step'"
          :data-testid="`step-${index}-toggle`"
          @click="open = open === index ? undefined : index"
        >
          <AppIcon :name="open === index ? 'down' : 'go'" :size="12" />
        </button>
        <span class="font-mono text-label text-[var(--color-accent-text)] uppercase">
          {{ step.uses }}
        </span>
        <span class="value min-w-0 flex-1 truncate text-[var(--color-ink-muted)]">
          {{ summarise(step) }}
        </span>
        <span
          v-if="kindFor(step.uses)?.runnable === false"
          class="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--color-warn)]"
          :data-testid="`step-${index}-not-runnable`"
        >
          <AppIcon name="alert" :size="10" />
          not runnable
        </span>
        <div class="flex items-center gap-1">
          <!-- Steps run top to bottom, so these two are the order of the
               work. Disabled at the ends rather than silently doing nothing. -->
          <Tooltip :label="index === 0 ? 'Already the first step' : 'Run this step earlier'">
            <button
              type="button"
              class="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)] disabled:opacity-30"
              aria-label="Move this step earlier"
              :disabled="index === 0"
              :data-testid="`step-${index}-up`"
              @click="move(index, -1)"
            >
              <AppIcon name="up" :size="13" />
            </button>
          </Tooltip>
          <Tooltip
            :label="index === modelValue.length - 1 ? 'Already the last step' : 'Run this step later'"
          >
            <button
              type="button"
              class="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)] disabled:opacity-30"
              aria-label="Move this step later"
              :disabled="index === modelValue.length - 1"
              :data-testid="`step-${index}-down`"
              @click="move(index, 1)"
            >
              <AppIcon name="down" :size="13" />
            </button>
          </Tooltip>
          <Tooltip label="Take this step out of the phase">
            <button
              type="button"
              class="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-danger)]"
              aria-label="Remove this step"
              :data-testid="`step-${index}-remove`"
              @click="remove(index)"
            >
              <AppIcon name="close" :size="13" />
            </button>
          </Tooltip>
        </div>
      </div>

      <div v-if="open === index" class="border-t border-[var(--color-line)] px-3 pb-3">
        <div class="grid grid-cols-[9rem_1fr] items-start gap-4 py-2">
          <label
            class="pt-1.5 font-mono text-label text-[var(--color-ink-faint)] uppercase"
          >
            uses
          </label>
          <SelectInput
            :model-value="step.uses"
            :options="kindIds"
            :data-testid="`step-${index}-uses`"
            @update:model-value="setKind(index, $event)"
          />
        </div>

        <SchemaFields
          v-if="kindFor(step.uses)?.fields"
          :schema="kindFor(step.uses)!.fields!"
          :model-value="fieldsOf(step)"
          :catalogues="catalogues"
          @update:model-value="setFields(index, $event)"
        />
        <p v-else class="py-2 text-xs text-[var(--color-ink-faint)]">
          The plugin that provides “{{ step.uses }}” does not describe its fields. Edit this step in
          YAML mode.
        </p>
      </div>
    </div>

    <button
      type="button"
      class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3 py-1.5 text-sm text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
      data-testid="step-add"
      @click="add"
    >
      <AppIcon name="add" :size="12" />
      Add step
    </button>

    <!-- Once, below the steps, rather than once per step: the vocabulary is the
         same for every field of every step, and repeating it would bury the
         steps themselves. Collapsed by default — it is a reference, not part of
         the form. -->
    <TokenDictionary
      v-if="tokens && tokens.length > 0"
      :namespaces="tokens"
      :declared="declaredVariables"
    />
  </div>
</template>
