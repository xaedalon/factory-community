<script setup lang="ts">
import AppIcon from '../AppIcon.vue'
import Tooltip from '../Tooltip.vue'
import { ref } from 'vue'
import TextInput from './TextInput.vue'

/** An ordered list of plain strings — conditions, arguments, and the like. */
const props = defineProps<{
  modelValue: string[]
  placeholder?: string | undefined
  testid?: string | undefined
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const draft = ref('')

function add(): void {
  const value = draft.value.trim()
  if (value === '') return
  emit('update:modelValue', [...props.modelValue, value])
  draft.value = ''
}
const remove = (index: number) =>
  emit(
    'update:modelValue',
    props.modelValue.filter((_, position) => position !== index),
  )
</script>

<template>
  <div class="space-y-1.5" :data-testid="testid">
    <div v-for="(item, index) in modelValue" :key="index" class="flex items-center gap-2">
      <span class="value flex-1 rounded-md bg-[var(--color-base)] px-3 py-1.5">{{ item }}</span>
      <!-- A drawn mark with a name, not a "×" typed as text. A screen reader
           read the old one as "times", and the target was the width of one
           character. -->
      <Tooltip :label="`Remove ${item}`">
        <button
          type="button"
          class="rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-danger)]"
          :aria-label="`Remove ${item}`"
          :data-testid="testid ? `${testid}-remove-${index}` : undefined"
          @click="remove(index)"
        >
          <AppIcon name="close" :size="13" />
        </button>
      </Tooltip>
    </div>
    <div class="flex gap-2">
      <TextInput
        v-model="draft"
        :placeholder="placeholder"
        mono
        :data-testid="testid ? `${testid}-input` : undefined"
        @keydown.enter.prevent="add"
      />
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3 text-sm text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
        :data-testid="testid ? `${testid}-add` : undefined"
        @click="add"
      >
        <AppIcon name="add" :size="12" />
        Add
      </button>
    </div>
  </div>
</template>
