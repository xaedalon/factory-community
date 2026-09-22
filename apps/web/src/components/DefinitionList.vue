<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ApiError, api, type DefinitionKind } from '../api/client.js'
import { download } from '../api/download.js'
import { storeToRefs } from 'pinia'
import { useDefinitions } from '../stores/definitions.js'
import { useProjects } from '../stores/projects.js'
import ScopeBadge from './ScopeBadge.vue'
import ShadowNotice from './ShadowNotice.vue'
import AppIcon from './AppIcon.vue'
import Tooltip from './Tooltip.vue'
import PageHeader from './PageHeader.vue'

const props = defineProps<{ kind: DefinitionKind; title: string; subtitle: string }>()

const store = useDefinitions()
const chosen = useProjects()
const { byKind, loading, error } = storeToRefs(store)
const items = () => byKind.value[props.kind]

/**
 * Yours first, then what ships with Factory.
 *
 * One table sorted by name put `worktree-create` between two of your own
 * workflows, and the only thing separating them was a badge. The split says the
 * thing the badge was trying to: these are yours to change, and those are the
 * ones that came with the product.
 *
 * Empty groups are dropped rather than shown as an empty table — an
 * installation with no built-ins of a kind (agents, today) should not be told
 * about a category it has nothing in.
 */
const groups = computed(() =>
  [
    { key: 'yours', title: 'Yours', rows: (items() ?? []).filter((i) => i.winner.scope !== 'builtin') },
    { key: 'builtin', title: 'Built in', rows: (items() ?? []).filter((i) => i.winner.scope === 'builtin') },
  ].filter((group) => group.rows.length > 0),
)

const exportError = ref<string | undefined>(undefined)

/**
 * What the editor said on its way here after a delete.
 *
 * The second half is the part worth carrying: removing one copy can uncover a
 * copy in a lower scope, so the name still resolves — to something else.
 * Saying only "deleted" would leave someone certain it was gone.
 */
const route = useRoute()
const justDeleted = computed(() => {
  const name = route.query['deleted']
  if (typeof name !== 'string' || name === '') return undefined
  const revealed = route.query['revealed']
  return { name, revealed: typeof revealed === 'string' ? revealed : undefined }
})

/**
 * Export gathers the workflow and every definition it needs into one file.
 *
 * It can legitimately fail — a workflow referencing a phase that no longer
 * exists cannot produce a complete bundle — and refusing is the right answer,
 * so the reason is shown rather than a half-bundle being handed over.
 */
async function exportWorkflow(name: string): Promise<void> {
  exportError.value = undefined
  try {
    const result = await api.exportWorkflow(name, chosen.projectId)
    download(`${name}.bundle.yaml`, result.text)
  } catch (caught) {
    exportError.value =
      caught instanceof ApiError && caught.problems.length > 0
        ? caught.problems.map((problem) => problem.message).join(' ')
        : caught instanceof Error
          ? caught.message
          : String(caught)
  }
}

const reload = (): void => {
  void store.load(props.kind, chosen.projectId)
}

// The rail owns the project list and its live connection; this only reads it.
onMounted(reload)
// Choosing a project in the rail changes which definitions exist, not just
// which of them are shown, so it is a reload rather than a filter.
watch(() => chosen.projectId, reload)
</script>

<template>
  <PageHeader :title="title" :subtitle="subtitle">
  </PageHeader>

  <p
    v-if="justDeleted"
    class="mx-8 mt-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2 text-sm"
    data-testid="deleted"
  >
    Deleted “{{ justDeleted.name }}”.
    <span v-if="justDeleted.revealed" class="text-[var(--color-warn)]" data-testid="deleted-revealed">
      It still resolves — from the {{ justDeleted.revealed }} scope, which was hidden until now.
    </span>
  </p>

  <div class="flex items-center justify-end gap-3 px-8 pt-6">
    <Tooltip v-if="kind === 'workflow'" label="Bring in workflows and phases from a shared bundle">
      <RouterLink
        to="/bundles/import"
        class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-ink)]"
        data-testid="go-import"
      >
        <AppIcon name="import" />
        Import a bundle
      </RouterLink>
    </Tooltip>
    <Tooltip :label="`Author a new ${kind} in a scope you choose`">
      <RouterLink
        :to="`/${kind}s/new`"
        class="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-accent)]/85"
        :data-testid="`new-${kind}`"
      >
        <AppIcon name="add" />
        New {{ kind }}
      </RouterLink>
    </Tooltip>
  </div>

  <div class="page-body pt-4">
    <div
      v-if="exportError"
      class="mb-4 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="export-error"
    >
      {{ exportError }}
    </div>

    <p v-if="loading" class="text-sm text-[var(--color-ink-muted)]" data-testid="loading">
      Loading…
    </p>

    <!-- The daemon not running is the likeliest failure by a wide margin, so it
         gets a real message rather than an empty table. -->
    <div
      v-else-if="error"
      class="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      {{ error }}
    </div>

    <p
      v-else-if="items().length === 0"
      class="text-sm text-[var(--color-ink-muted)]"
      data-testid="empty"
    >
      <template v-if="chosen.current">
        No {{ kind }}s in {{ chosen.current.name }}, and none shared with it. Run
        <code class="value">factory init</code> in the repository to give it a scope of its own.
      </template>
      <template v-else>
        No {{ kind }}s yet. Run <code class="value">factory init</code> to create a scope.
      </template>
    </p>

    <template v-else>
    <section
      v-for="group in groups"
      :key="group.key"
      class="mb-8 last:mb-0"
      :data-testid="`${kind}-group-${group.key}`"
    >
      <h2 class="mb-2 font-mono text-label text-[var(--color-ink-faint)] uppercase">
        {{ group.title }}
        <span v-if="group.key === 'builtin'" class="normal-case tracking-normal">
          — ships with Factory; saving one writes your own copy
        </span>
      </h2>
      <table class="w-full border-collapse" :data-testid="`${kind}-table-${group.key}`">
      <thead>
        <tr class="border-b border-[var(--color-line)] text-left">
          <th
            v-for="heading in ['Name', 'Scope', '', 'Location', '']"
            :key="heading"
            class="pb-2 font-mono text-label font-normal text-[var(--color-ink-faint)] uppercase"
          >
            {{ heading }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in group.rows"
          :key="item.name"
          class="border-b border-[var(--color-line)] transition-colors hover:bg-[var(--color-veil-weak)]"
          :data-testid="`row-${item.name}`"
        >
          <td class="py-3 pr-4">
            <RouterLink
              :to="`/${kind}s/${item.name}`"
              class="value hover:underline"
              :class="item.valid ? '' : 'text-[var(--color-danger)]'"
              :data-testid="`open-${item.name}`"
            >
              {{ item.name }}
            </RouterLink>
            <!-- An invalid definition is still listed. Hiding it would leave
                 someone hunting for a file the tool can see and they cannot. -->
            <span
              v-if="!item.valid"
              class="ml-2 font-mono text-[10px] text-[var(--color-danger)]"
              :data-testid="`invalid-${item.name}`"
            >
              does not validate
            </span>
            <!-- Listed, and said out loud. The file is real and editable; what
                 it cannot do is be added to a task here, and a row that simply
                 vanished from the picker with no explanation is the kind of
                 thing you end up reading the daemon to understand. -->
            <Tooltip
              v-if="item.unavailable"
              :label="`Nothing provides ${item.unavailable.flag} here, so a task cannot pick this up.`"
            >
              <span
                class="ml-2 inline-flex items-center gap-1 font-mono text-[10px] text-[var(--color-ink-faint)]"
                :data-testid="`unavailable-${item.name}`"
              >
                <AppIcon name="alert" :size="10" />
                needs {{ item.unavailable.setting }}
              </span>
            </Tooltip>
          </td>
          <td class="py-3 pr-4"><ScopeBadge :scope="item.winner.scope" /></td>
          <td class="py-3 pr-4"><ShadowNotice :shadowed="item.shadowed" /></td>
          <td class="py-3 font-mono text-[11px] text-[var(--color-ink-faint)]">
            {{ item.winner.file }}
          </td>
          <td class="py-3 pl-4 text-right">
            <Tooltip v-if="kind === 'workflow'" label="Download this workflow and its phases as a bundle">
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-veil-weak)] hover:text-[var(--color-accent-text)]"
                :data-testid="`export-${item.name}`"
                @click="exportWorkflow(item.name)"
              >
                <AppIcon name="export" :size="11" />
                export
              </button>
            </Tooltip>
          </td>
        </tr>
      </tbody>
      </table>
    </section>
    </template>
  </div>
</template>
