<script setup lang="ts">
import AppIcon from '../AppIcon.vue'
import Tooltip from '../Tooltip.vue'
import { computed, ref } from 'vue'
import type { DefinitionListing } from '../../api/client.js'
import ScopeBadge from '../ScopeBadge.vue'
import ComboInput from './ComboInput.vue'

/**
 * The phases a workflow runs, in order.
 *
 * A plain text list would let someone type a name that does not exist and only
 * find out when the workflow failed to plan. Here each entry says which scope
 * it resolves from, or says plainly that nothing resolves it — and offers to
 * create it, because that is what you were about to go and do anyway.
 */
const props = defineProps<{ modelValue: string[]; available: DefinitionListing[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const draft = ref('')
const known = computed(() => new Map(props.available.map((item) => [item.name, item])))
const suggestions = computed(() =>
  props.available.filter((item) => !props.modelValue.includes(item.name)).map((item) => item.name),
)

function add(name: string): void {
  const value = name.trim()
  if (value === '' || props.modelValue.includes(value)) return
  emit('update:modelValue', [...props.modelValue, value])
  draft.value = ''
}
const remove = (index: number) =>
  emit('update:modelValue', props.modelValue.filter((_, position) => position !== index))
function move(index: number, delta: number): void {
  const next = [...props.modelValue]
  const target = index + delta
  if (target < 0 || target >= next.length) return
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved as string)
  emit('update:modelValue', next)
}
</script>

<template>
  <div class="space-y-1.5" data-testid="phases">
    <div
      v-for="(name, index) in modelValue"
      :key="`${name}-${index}`"
      class="flex items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-base)] px-3 py-1.5"
      :data-testid="`phase-${name}`"
    >
      <span class="font-mono text-meta text-[var(--color-ink-faint)]">{{ index + 1 }}</span>
      <span class="value flex-1">{{ name }}</span>

      <ScopeBadge v-if="known.get(name)" :scope="known.get(name)!.winner.scope" />
      <template v-else>
        <Tooltip label="Nothing in this project's scope chain defines it, so the workflow cannot run">
          <span
            class="inline-flex items-center gap-1 font-mono text-meta text-[var(--color-danger)]"
            :data-testid="`phase-${name}-missing`"
          >
            <AppIcon name="alert" :size="10" />
            no such phase
          </span>
        </Tooltip>
        <!-- A new tab, deliberately. Following this link mid-edit would
             otherwise mean abandoning unsaved changes to the workflow that sent
             you here — and being warned about it is not much better than losing
             them. Make the phase, come back, the workflow is as you left it. -->
        <a
          :href="`/phases/new?name=${encodeURIComponent(name)}`"
          target="_blank"
          rel="noopener"
          class="inline-flex items-center gap-1 font-mono text-meta text-[var(--color-accent-text)] hover:underline"
          :data-testid="`phase-${name}-create`"
        >
          create
          <AppIcon name="link" :size="10" />
        </a>
      </template>

      <!-- Three arrows and a times sign, typed as text, was the whole control
           set for reordering a workflow: no names for a screen reader, and a
           target the width of one character each. Order matters here — this is
           the sequence the phases run in — so the two that change it say which
           way they go. -->
      <Tooltip :label="index === 0 ? `${name} already runs first` : `Run ${name} earlier`">
        <button
          type="button"
          class="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)] disabled:opacity-30"
          :aria-label="`Move ${name} earlier`"
          :disabled="index === 0"
          :data-testid="`phase-${name}-up`"
          @click="move(index, -1)"
        >
          <AppIcon name="up" :size="13" />
        </button>
      </Tooltip>
      <Tooltip
        :label="index === modelValue.length - 1 ? `${name} already runs last` : `Run ${name} later`"
      >
        <button
          type="button"
          class="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)] disabled:opacity-30"
          :aria-label="`Move ${name} later`"
          :disabled="index === modelValue.length - 1"
          :data-testid="`phase-${name}-down`"
          @click="move(index, 1)"
        >
          <AppIcon name="down" :size="13" />
        </button>
      </Tooltip>
      <Tooltip :label="`Take ${name} out of this workflow`">
        <button
          type="button"
          class="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-danger)]"
          :aria-label="`Remove ${name}`"
          :data-testid="`phase-${name}-remove`"
          @click="remove(index)"
        >
          <AppIcon name="close" :size="13" />
        </button>
      </Tooltip>
    </div>

    <!-- A ComboInput, not a bare `<input list>`. Chromium hides a datalist's
         arrow until the pointer is over it, so a raw one is a plain text box
         that happens to have a dropdown — and nothing on screen says the phases
         you already have are on offer. Same control, same chevron, as every
         other field that suggests values. -->
    <!-- The wrapper carries the width and the Enter handler, because ComboInput
         has two root nodes (the input and its datalist) and Vue applies a
         fallthrough class or listener to neither. Keydown bubbles, so listening
         here is the same thing without the trap. -->
    <div class="flex gap-2">
      <div class="flex-1" @keydown.enter.prevent="add(draft)">
        <ComboInput
          v-model="draft"
          :options="suggestions"
          placeholder="phase name"
          testid="phases-input"
        />
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3 text-sm text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
        data-testid="phases-add"
        @click="add(draft)"
      >
        <AppIcon name="add" :size="12" />
        Add
      </button>
    </div>
  </div>
</template>
