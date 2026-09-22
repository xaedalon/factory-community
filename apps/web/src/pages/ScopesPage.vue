<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api, type ScopesResponse } from '../api/client.js'
import { useProjects } from '../stores/projects.js'
import PageHeader from '../components/PageHeader.vue'
import AppIcon from '../components/AppIcon.vue'
import Tooltip from '../components/Tooltip.vue'
import ScopeBadge from '../components/ScopeBadge.vue'

/**
 * Where definitions are read from, in order.
 *
 * The paths are shown in full and in monospace on purpose. Path opacity was the
 * original problem — the prototype computed them from two disagreeing anchors —
 * so the answer to "where is this actually reading from" should never require
 * running a command.
 */
const data = ref<ScopesResponse | undefined>(undefined)
const error = ref<string | undefined>(undefined)
const chosen = useProjects()

// With a project selected this is that project's chain, which is the whole
// question the page answers: where its definitions come from, and where a
// write would land.
async function load(): Promise<void> {
  try {
    data.value = await api.scopes(chosen.projectId)
    error.value = undefined
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

onMounted(load)
watch(() => chosen.projectId, load)
</script>

<template>
  <PageHeader
    title="Scopes"
    :subtitle="
      chosen.current
        ? `Where ${chosen.current.name}'s definitions are read from, highest precedence first.`
        : 'Where definitions are read from, highest precedence first.'
    "
  />

  <div class="page-body">
    <div
      v-if="error"
      class="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      <AppIcon name="alert" class="mr-1 inline-block align-[-2px]" />
      {{ error }}
    </div>

    <ol v-else class="space-y-2" data-testid="scope-chain">
      <li
        v-for="(scope, index) in data?.scopes ?? []"
        :key="scope.kind"
        class="flex items-center gap-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3"
        :data-testid="`scope-row-${scope.kind}`"
      >
        <!-- The position, said out loud. "Highest precedence first" was in the
             page subtitle and nowhere in the list, so which of three rows wins
             was something to remember rather than read. -->
        <Tooltip
          :label="
            index === 0
              ? 'Searched first — a definition here hides the same name below'
              : 'Searched after the ones above'
          "
        >
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--color-line)] font-mono text-[11px] text-[var(--color-ink-faint)]"
          >
            {{ index + 1 }}
          </span>
        </Tooltip>
        <ScopeBadge :scope="scope.kind" />
        <span
          class="value min-w-0 flex-1 truncate text-[var(--color-ink-muted)]"
          :title="scope.root"
        >
          {{ scope.root }}
        </span>
        <span class="flex shrink-0 gap-3 font-mono text-[11px]">
          <Tooltip :label="scope.exists ? 'This directory is there' : 'Nothing at this path yet'">
            <span
              class="inline-flex items-center gap-1"
              :class="scope.exists ? 'text-[var(--color-ink-faint)]' : 'text-[var(--color-warn)]'"
            >
              <AppIcon :name="scope.exists ? 'check' : 'alert'" :size="10" />
              {{ scope.exists ? 'present' : 'absent' }}
            </span>
          </Tooltip>
          <Tooltip
            :label="
              scope.writable
                ? 'Definitions can be saved here'
                : 'Read-only — saving here is refused'
            "
          >
            <span class="inline-flex items-center gap-1 text-[var(--color-ink-faint)]">
              <AppIcon :name="scope.writable ? 'edit' : 'profile'" :size="10" />
              {{ scope.writable ? 'writable' : 'read-only' }}
            </span>
          </Tooltip>
        </span>
      </li>
    </ol>

    <p
      v-if="data"
      class="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]"
      data-testid="write-target"
    >
      <AppIcon name="edit" :size="13" class="text-[var(--color-ink-faint)]" />
      <span>
        New definitions are written to the
        <span class="value text-[var(--color-ink)]">{{ data.defaultWriteScope }}</span> scope.
      </span>
    </p>
  </div>
</template>
