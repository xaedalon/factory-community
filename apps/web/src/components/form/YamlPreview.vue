<script setup lang="ts">
defineProps<{ text: string; stale?: boolean | undefined }>()
</script>

<template>
  <div class="flex h-full flex-col border-l border-[var(--color-line)] bg-[var(--color-surface)]">
    <div
      class="flex items-center gap-2 border-b border-[var(--color-line)] px-4 py-2 font-mono text-label text-[var(--color-ink-faint)] uppercase"
    >
      <span>Preview</span>
      <span v-if="stale" class="text-[var(--color-ink-faint)]" data-testid="preview-stale">…</span>
    </div>
    <pre
      class="value flex-1 overflow-auto px-4 py-3 leading-relaxed text-[var(--color-ink-muted)]"
      data-testid="yaml-preview"
    >{{ text }}</pre>
  </div>
</template>
