<script setup lang="ts">
import { ref } from 'vue'
import type { Problem } from '../../api/client.js'
import ViewToggle from './ViewToggle.vue'
import AppButton from '../AppButton.vue'
import AppIcon from '../AppIcon.vue'

/**
 * The split view every editor uses: form on the left, the file on the right.
 *
 * Two panes rather than a tab, because the point is to see the effect of a
 * field on the thing that gets written — a config editor where you have to
 * switch views to check your work is a config editor people stop trusting.
 */
defineProps<{
  title: string
  saving?: boolean | undefined
  dirty?: boolean | undefined
  problems?: Problem[] | undefined
  saveLabel?: string | undefined
  /** Absent for a definition that has not been written yet. */
  deletable?: boolean | undefined
}>()
defineEmits<{ save: []; cancel: []; remove: [] }>()

const view = defineModel<'form' | 'yaml'>('view', { default: 'form' })
const confirmingDelete = ref(false)
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex items-center gap-4 border-b border-[var(--color-line)] px-6 py-3.5"
    >
      <h1 class="text-base font-medium">{{ title }}</h1>
      <span
        v-if="dirty"
        class="flex items-center gap-1 font-mono text-[10px] tracking-wide text-[var(--color-warn)]"
        data-testid="dirty"
      >
        <AppIcon name="alert" :size="11" />
        unsaved
      </span>
      <div class="ml-auto flex items-center gap-2">
        <ViewToggle v-model="view" />

        <!-- Two clicks, because a definition can be the only copy of something
             someone spent an afternoon on and there is no undo. -->
        <template v-if="deletable">
          <AppButton
            v-if="!confirmingDelete"
            label="Delete"
            icon="remove"
            tone="danger"
            hint="Remove this file from its scope — there is no undo"
            data-testid="delete"
            @click="confirmingDelete = true"
          />
          <button
            v-else
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-danger)]/60 px-3 py-1.5 text-sm text-[var(--color-danger)]"
            data-testid="delete-confirm"
            @click="$emit('remove')"
          >
            <AppIcon name="remove" />
            Really delete?
          </button>
        </template>

        <AppButton label="Cancel" data-testid="cancel" @click="$emit('cancel')" />
        <AppButton
          :label="saving ? 'Saving…' : (saveLabel ?? 'Save')"
          icon="check"
          tone="primary"
          :disabled="saving"
          hint="Write this definition to the scope it names"
          data-testid="save"
          @click="$emit('save')"
        />
      </div>
    </header>

    <div
      v-if="problems && problems.length > 0"
      class="border-b border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-6 py-2.5"
      data-testid="problems"
    >
      <p
        v-for="(problem, index) in problems"
        :key="index"
        class="value text-xs"
        :class="
          problem.severity === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-warn)]'
        "
      >
        {{ problem.field ? `${problem.field}: ` : '' }}{{ problem.message }}
      </p>
    </div>

    <slot name="conflict" />

    <!-- Side by side while editing; the file alone when you want to read it.
         The YAML side is always a view — one editor, one source of truth. -->
    <div
      v-if="view === 'form'"
      class="grid min-h-0 flex-1 grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
    >
      <div class="overflow-auto px-6 py-4"><slot name="form" /></div>
      <slot name="preview" />
    </div>
    <div v-else class="min-h-0 flex-1"><slot name="preview" /></div>
  </div>
</template>
