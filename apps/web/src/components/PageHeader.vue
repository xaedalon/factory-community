<script setup lang="ts">
defineProps<{ title: string; subtitle?: string | undefined }>()
</script>

<template>
  <header class="flex items-start gap-4 border-b border-[var(--color-line)] px-8 py-6">
    <div class="min-w-0 flex-1">
      <!-- The slot defaults to the prop, so every page that just wants a heading
           passes a string and reads no differently than before. A page whose
           title is editable puts its own control here. -->
      <h1 class="text-display">
        <slot name="title">{{ title }}</slot>
      </h1>
      <!-- Same idiom as the title: the slot defaults to the prop, so a page that
           only has a line of text still passes a string. A page whose subtitle is
           editable puts its own control here instead. -->
      <div v-if="subtitle || $slots.subtitle" class="mt-1">
        <slot name="subtitle">
          <p class="text-sm text-[var(--color-ink-muted)]">{{ subtitle }}</p>
        </slot>
      </div>
    </div>

    <!-- Named, and with no default: `DefinitionList.vue` already passes a body
         to this component that nothing renders, so adding a default slot would
         start drawing it. A page with nothing to put here renders no box. -->
    <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
