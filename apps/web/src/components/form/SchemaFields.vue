<script setup lang="ts">
import { computed, ref } from 'vue'
import type { JsonSchema } from '../../api/client.js'
import FieldRow from './FieldRow.vue'
import TextInput from './TextInput.vue'
import SelectInput from './SelectInput.vue'
import ComboInput from './ComboInput.vue'
import StringListEditor from './StringListEditor.vue'

/**
 * Form controls generated from a step kind's own schema.
 *
 * This is what makes "a plugin adds a step kind and the builder can edit it"
 * true rather than a slogan. The daemon publishes each kind's schema as JSON
 * Schema, so a kind nobody wrote a UI for still gets real labelled controls
 * instead of a raw text box — and adding one needs no change here.
 *
 * Deliberately covers only the shapes a step field realistically takes. A kind
 * using something more exotic falls back to the raw editor rather than
 * pretending with a control that would mangle the value.
 */
const props = defineProps<{
  schema: JsonSchema
  modelValue: Record<string, unknown>
  /**
   * Values for the sets a schema names but cannot contain — see `x-options`.
   * An unknown or empty catalogue falls back to a text box, because offering
   * nothing is worse than offering free text.
   */
  catalogues?: Record<string, readonly string[]> | undefined
}>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()

interface Field {
  key: string
  schema: JsonSchema
  required: boolean
  kind: 'text' | 'enum' | 'suggested' | 'number' | 'boolean' | 'list' | 'unsupported'
  /** For 'enum' and 'suggested': what to offer. */
  options: readonly string[]
  /** The field answering for this one, when one is and this is not set. */
  supersededBy?: string
}

const has = (key: string): boolean => {
  const value = props.modelValue[key]
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== ''
}

const all = computed<Field[]>(() =>
  Object.entries(props.schema.properties ?? {}).map(([key, schema]) => {
    const named = schema['x-options']
    const offered = named === undefined ? [] : (props.catalogues?.[named] ?? [])
    const answering = schema['x-supersededBy']
    return {
      key,
      schema,
      required: (props.schema.required ?? []).includes(key),
      kind: classify(schema, offered),
      options: schema.enum ?? offered,
      // Superseded only while this field is empty. A value someone set is
      // never hidden from them — that is how a field comes to lie about what
      // the file contains.
      ...(answering !== undefined && has(answering) && !has(key)
        ? { supersededBy: answering }
        : {}),
    }
  }),
)

/** What is asked for: everything an agent is not already answering. */
const fields = computed(() => all.value.filter((field) => field.supersededBy === undefined))

/** What is not, and who is answering instead. */
const answered = computed(() => all.value.filter((field) => field.supersededBy !== undefined))
const answeredBy = computed(() => answered.value[0]?.supersededBy ?? '')
const answeredNames = computed(() => answered.value.map((field) => field.key).join(', '))

/** Revealed on request, so an override is possible without being suggested. */
const overriding = ref(false)
const shown = computed(() => (overriding.value ? all.value : fields.value))

function classify(schema: JsonSchema, offered: readonly string[]): Field['kind'] {
  if (schema.enum !== undefined) return 'enum'
  // A named catalogue with nothing in it is not a dropdown — it is a dropdown
  // you cannot pick from, which is strictly worse than typing.
  if (schema['x-options'] !== undefined && offered.length > 0) return 'suggested'
  if (schema.type === 'string') return 'text'
  if (schema.type === 'boolean') return 'boolean'
  if (schema.type === 'integer' || schema.type === 'number') return 'number'
  if (schema.type === 'array' && schema.items?.type === 'string') return 'list'
  return 'unsupported'
}

function set(key: string, value: unknown): void {
  const next = { ...props.modelValue }
  // An empty optional field is absent, not present-and-empty. Writing `effort: ""`
  // would fail validation and would not be what anyone meant by clearing it.
  if (value === '' || value === undefined) delete next[key]
  else next[key] = value
  emit('update:modelValue', next)
}

/**
 * Write a number, clear it, or do neither.
 *
 * `Number('1x')` is `NaN`, and converting unguarded wrote that into the
 * definition and from there into the YAML file. Emptying the box clears the
 * field; anything that is not a number at all is simply not written, so a
 * half-typed value is never mistaken for a decision.
 */
function setNumber(key: string, input: string): void {
  if (input.trim() === '') return set(key, undefined)
  const value = Number(input)
  if (Number.isFinite(value)) set(key, value)
}

const asString = (key: string) => String(props.modelValue[key] ?? '')
const asList = (key: string) =>
  Array.isArray(props.modelValue[key]) ? (props.modelValue[key] as string[]) : []
</script>

<template>
  <FieldRow
    v-for="field in shown"
    :key="field.key"
    :label="field.key + (field.required ? ' *' : '')"
    :hint="field.schema.description"
  >
    <TextInput
      v-if="field.kind === 'text'"
      :model-value="asString(field.key)"
      mono
      :data-testid="`field-${field.key}`"
      @update:model-value="set(field.key, $event)"
    />

    <SelectInput
      v-else-if="field.kind === 'enum'"
      :model-value="asString(field.key)"
      :options="field.options"
      :allow-empty="!field.required"
      :data-testid="`field-${field.key}`"
      @update:model-value="set(field.key, $event)"
    />

    <!-- A named catalogue is offered, not enforced: the schema said `string`,
         and a value the catalogue has not heard of is still valid. -->
    <ComboInput
      v-else-if="field.kind === 'suggested'"
      :model-value="asString(field.key)"
      :options="field.options"
      :testid="`field-${field.key}`"
      @update:model-value="set(field.key, $event)"
    />

    <input
      v-else-if="field.kind === 'boolean'"
      type="checkbox"
      :checked="modelValue[field.key] === true"
      :data-testid="`field-${field.key}`"
      class="mt-1.5 accent-[var(--color-accent)]"
      @change="set(field.key, ($event.target as HTMLInputElement).checked)"
    />

    <TextInput
      v-else-if="field.kind === 'number'"
      :model-value="asString(field.key)"
      mono
      :data-testid="`field-${field.key}`"
      @update:model-value="setNumber(field.key, $event)"
    />

    <StringListEditor
      v-else-if="field.kind === 'list'"
      :model-value="asList(field.key)"
      :testid="`field-${field.key}`"
      @update:model-value="set(field.key, $event)"
    />

    <p v-else class="pt-1.5 text-xs text-[var(--color-ink-faint)]">
      This field has a shape the form cannot render. Edit it in YAML mode.
    </p>
  </FieldRow>

  <!-- Said, not silently dropped. Six boxes vanishing with no explanation is
       its own kind of confusing, and someone does occasionally want to override
       one — so the offer is here, just not in the way. -->
  <p
    v-if="answered.length > 0"
    class="py-2 text-xs text-[var(--color-ink-faint)]"
    data-testid="superseded-note"
  >
    <template v-if="!overriding">
      <span class="value">{{ String(modelValue[answeredBy] ?? '') }}</span>
      supplies {{ answeredNames }}.
    </template>
    <template v-else>Anything left empty comes from the agent.</template>
    <button
      type="button"
      class="text-[var(--color-accent-text)] hover:underline"
      data-testid="override-superseded"
      @click="overriding = !overriding"
    >
      {{ overriding ? 'Hide them' : 'Override one' }}
    </button>
  </p>
</template>
