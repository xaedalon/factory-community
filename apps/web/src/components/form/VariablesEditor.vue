<script setup lang="ts">
import AppIcon from '../AppIcon.vue'
import Tooltip from '../Tooltip.vue'
import { computed } from 'vue'
import TextInput from './TextInput.vue'

/** Key/value pairs substituted into commands and prompts. */
const props = defineProps<{ modelValue: Record<string, string> }>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, string>] }>()

const entries = computed(() => Object.entries(props.modelValue))

function rename(from: string, to: string): void {
  const next: Record<string, string> = {}
  // Rebuilt in order rather than deleted and re-added, so renaming a key does
  // not move the row to the bottom while someone is typing in it.
  for (const [key, value] of entries.value) next[key === from ? to : key] = value
  emit('update:modelValue', next)
}
const setValue = (key: string, value: string) =>
  emit('update:modelValue', { ...props.modelValue, [key]: value })
function remove(key: string): void {
  const next = { ...props.modelValue }
  delete next[key]
  emit('update:modelValue', next)
}
const add = () => emit('update:modelValue', { ...props.modelValue, '': '' })
</script>

<template>
  <div class="space-y-1.5" data-testid="variables">
    <div v-for="[key, value] in entries" :key="key" class="flex items-center gap-2">
      <TextInput
        :model-value="key"
        placeholder="name"
        mono
        class="w-40"
        @update:model-value="rename(key, $event)"
      />
      <TextInput
        :model-value="value"
        placeholder="value"
        mono
        @update:model-value="setValue(key, $event)"
      />
      <Tooltip :label="`Remove ${key}`">
        <button
          type="button"
          class="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-danger)]"
          :aria-label="`Remove ${key}`"
          @click="remove(key)"
        >
          <AppIcon name="close" :size="13" />
        </button>
      </Tooltip>
    </div>
    <button
      type="button"
      class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3 py-1 text-sm text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
      data-testid="variables-add"
      @click="add"
    >
      <AppIcon name="add" :size="12" />
      Add variable
    </button>
  </div>
</template>
