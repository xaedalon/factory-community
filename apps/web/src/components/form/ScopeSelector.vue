<script setup lang="ts">
import { computed } from 'vue'
import type { Scope, ScopeKind } from '../../api/client.js'

/**
 * Where this definition will be written.
 *
 * The absolute path is always visible, in monospace. Path opacity was the
 * original problem — the prototype computed them from two disagreeing anchors —
 * so "where does this go" should never require running a command.
 *
 * The built-in scope is shown but locked. Hiding it would leave no answer to
 * "how do I change the workflow that ships with Factory?"; showing it with a
 * Fork button answers that question in the place people ask it.
 */
const props = defineProps<{
  scopes: Scope[]
  modelValue: ScopeKind
  /** The scope a stored definition came from, when editing one. */
  origin?: ScopeKind | undefined
}>()
const emit = defineEmits<{
  'update:modelValue': [value: ScopeKind]
  fork: []
}>()

const target = computed(() => props.scopes.find((scope) => scope.kind === props.modelValue))
const path = computed(() => target.value?.root ?? '')
</script>

<template>
  <div class="space-y-1.5" data-testid="scope-selector">
    <div class="inline-flex overflow-hidden rounded-md border border-[var(--color-line)]">
      <button
        v-for="scope in scopes"
        :key="scope.kind"
        type="button"
        :disabled="!scope.writable"
        :data-testid="`scope-option-${scope.kind}`"
        class="px-3 py-1.5 font-mono text-label transition-colors"
        :class="[
          scope.kind === modelValue
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
            : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
          scope.writable ? '' : 'cursor-not-allowed opacity-50',
        ]"
        :title="scope.writable ? scope.root : 'Built-in definitions ship inside the package.'"
        @click="scope.writable && emit('update:modelValue', scope.kind)"
      >
        {{ scope.kind }}
      </button>
    </div>

    <p class="value text-[11px] text-[var(--color-ink-faint)]" data-testid="scope-path">
      {{ path }}
    </p>

    <button
      v-if="origin === 'builtin'"
      type="button"
      class="rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-3 py-1 text-xs text-[var(--color-ink)]"
      data-testid="fork-to-project"
      @click="emit('fork')"
    >
      Fork to project
    </button>
  </div>
</template>
