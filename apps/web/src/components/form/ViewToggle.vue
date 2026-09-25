<script setup lang="ts">
/**
 * Form or file.
 *
 * The YAML side is a view, not an editor. Two ways to change the same document
 * means two sources of truth to reconcile every time someone switches, and the
 * reconciliation is exactly where a hand-written comment or an unrecognised key
 * gets quietly dropped. One editor, and an honest window onto what it produces.
 */
defineProps<{ modelValue: 'form' | 'yaml' }>()
defineEmits<{ 'update:modelValue': [value: 'form' | 'yaml'] }>()
</script>

<template>
  <div
    class="inline-flex overflow-hidden rounded-md border border-[var(--color-line)]"
    data-testid="view-toggle"
  >
    <button
      v-for="view in (['form', 'yaml'] as const)"
      :key="view"
      type="button"
      :data-testid="`view-${view}`"
      class="px-3 py-1 font-mono text-label transition-colors"
      :class="
        view === modelValue
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
          : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
      "
      @click="$emit('update:modelValue', view)"
    >
      {{ view === 'form' ? 'Form' : 'YAML' }}
    </button>
  </div>
</template>
