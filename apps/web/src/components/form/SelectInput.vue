<script setup lang="ts">
/**
 * One of a closed set.
 *
 * Shares `.field-control` with `ComboInput`, and monospace with every other
 * value that ends up in a YAML file — `approval: none` and `uses: agent` are
 * as much file content as a path or a command.
 */
defineProps<{
  modelValue: string
  options: readonly string[]
  id?: string | undefined
  allowEmpty?: boolean | undefined
  /**
   * What the empty option is called, when "nothing chosen" is a real position.
   *
   * It was always an em dash, which is fine for a field that may simply be
   * blank and wrong for one where not choosing *means* something. The project
   * profile is the case that proved it: unset means "follow the installation",
   * which is a different thing from `default`, and a dash says neither.
   */
  emptyLabel?: string | undefined
}>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <select
    :id="id"
    :value="modelValue"
    class="value field-control"
    @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-if="allowEmpty" value="">{{ emptyLabel ?? '—' }}</option>
    <option v-for="option in options" :key="option" :value="option">{{ option }}</option>
  </select>
</template>
