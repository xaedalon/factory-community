<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  ApiError,
  api,
  type ConflictPolicy,
  type ImportResult,
  type Problem,
  type Scope,
  type ScopeKind,
} from '../api/client.js'
import { useProjects } from '../stores/projects.js'
import PageHeader from '../components/PageHeader.vue'
import FieldRow from '../components/form/FieldRow.vue'
import SelectInput from '../components/form/SelectInput.vue'
import TextInput from '../components/form/TextInput.vue'
import ImportPlanTable from '../components/form/ImportPlanTable.vue'

/**
 * Bringing someone else's workflow in.
 *
 * Always previewed first. An import touches several files at once, and the
 * interesting outcomes — a name already taken, a name that would hide a copy in
 * a lower scope — are not visible from the file itself. Nothing is written
 * until the plan on screen is the plan that was approved.
 */
// An import writes into a scope chain, so it goes into the chain the rail is
// showing — otherwise the workflow you imported while looking at a project
// lands somewhere that project cannot see.
const chosen = useProjects()
const text = ref('')
const filename = ref('')
const scopes = ref<Scope[]>([])
const targetScope = ref<ScopeKind>('project')
const policy = ref<ConflictPolicy>('fail')
const prefix = ref('')

const result = ref<ImportResult | undefined>(undefined)
const problems = ref<Problem[]>([])
const imported = ref(false)
const busy = ref(false)

onMounted(async () => {
  const chain = await api.scopes(chosen.projectId)
  scopes.value = chain.scopes.filter((scope) => scope.writable)
  targetScope.value = chain.defaultWriteScope
})

async function readFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file === undefined) return
  filename.value = file.name
  text.value = await file.text()
}

async function plan(): Promise<void> {
  if (text.value.trim() === '') return
  busy.value = true
  problems.value = []
  imported.value = false
  try {
    result.value = await api.importBundle(text.value, {
      scope: targetScope.value,
      policy: policy.value,
      prefix: prefix.value,
      dryRun: true,
      ...(chosen.projectId === undefined ? {} : { project: chosen.projectId }),
    })
    problems.value = result.value.problems
  } catch (caught) {
    result.value = undefined
    problems.value =
      caught instanceof ApiError && caught.problems.length > 0
        ? caught.problems
        : [{ severity: 'error', message: caught instanceof Error ? caught.message : String(caught) }]
  } finally {
    busy.value = false
  }
}

async function apply(): Promise<void> {
  busy.value = true
  try {
    result.value = await api.importBundle(text.value, {
      scope: targetScope.value,
      policy: policy.value,
      prefix: prefix.value,
      dryRun: false,
      ...(chosen.projectId === undefined ? {} : { project: chosen.projectId }),
    })
    problems.value = result.value.problems
    imported.value = result.value.problems.length === 0
  } catch (caught) {
    problems.value =
      caught instanceof ApiError && caught.problems.length > 0
        ? caught.problems
        : [{ severity: 'error', message: caught instanceof Error ? caught.message : String(caught) }]
  } finally {
    busy.value = false
  }
}

// Re-plan whenever an option changes: the plan depends on all of them, and a
// table that no longer matches the settings above it is worse than none.
watch([text, targetScope, policy, prefix], () => {
  void plan()
})

const blocked = () => problems.value.some((problem) => problem.severity === 'error')
</script>

<template>
  <PageHeader
    title="Import a bundle"
    subtitle="One file carrying a workflow and everything it needs."
  />

  <div class="max-w-4xl space-y-6 px-8 py-6">
    <FieldRow label="File">
      <input
        type="file"
        accept=".yaml,.yml,text/yaml"
        data-testid="bundle-file"
        class="block w-full text-sm text-[var(--color-ink-muted)] file:mr-3 file:rounded-md file:border file:border-[var(--color-line)] file:bg-[var(--color-surface)] file:px-3 file:py-1.5 file:text-sm file:text-[var(--color-ink)]"
        @change="readFile"
      />
      <p v-if="filename" class="value mt-1 text-[11px] text-[var(--color-ink-faint)]">
        {{ filename }}
      </p>
    </FieldRow>

    <FieldRow label="Or paste">
      <textarea
        v-model="text"
        rows="6"
        placeholder="kind: factory.bundle/v1"
        data-testid="bundle-text"
        class="value w-full rounded-md border border-[var(--color-line)] bg-[var(--color-base)] px-3 py-2 text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] focus:outline-none"
      />
    </FieldRow>

    <FieldRow label="Into" hint="Where the definitions will be written.">
      <SelectInput
        v-model="targetScope"
        :options="scopes.map((scope) => scope.kind)"
        id="import-scope"
      />
    </FieldRow>

    <FieldRow
      label="On conflict"
      hint="Fail leaves everything untouched. Overwrite keeps the previous version in .trash."
    >
      <SelectInput
        v-model="policy"
        :options="['fail', 'skip', 'overwrite']"
        id="import-policy"
      />
    </FieldRow>

    <FieldRow
      label="Prefix"
      hint="Rename everything on the way in, rewriting references between them. Use it when a name is already taken."
    >
      <TextInput v-model="prefix" mono placeholder="acme-" id="import-prefix" />
    </FieldRow>

    <div
      v-if="problems.length > 0"
      class="rounded-lg border px-4 py-3"
      :class="
        blocked()
          ? 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5'
          : 'border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5'
      "
      data-testid="import-problems"
    >
      <p
        v-for="(problem, index) in problems"
        :key="index"
        class="text-xs"
        :class="
          problem.severity === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-warn)]'
        "
      >
        {{ problem.message }}
      </p>
    </div>

    <section v-if="result && result.plan.items.length > 0">
      <h2 class="mb-2 font-mono text-[11px] tracking-widest text-[var(--color-ink-faint)] uppercase">
        {{ imported ? 'Imported' : 'Would import' }} · {{ result.plan.entry }}
      </h2>
      <ImportPlanTable :items="result.plan.items" />
    </section>

    <div v-if="imported" class="text-sm text-[var(--color-ok)]" data-testid="imported">
      Wrote {{ result?.written.length ?? 0 }} file(s).
      <RouterLink to="/workflows" class="ml-2 text-[var(--color-accent-text)] hover:underline">
        Back to workflows
      </RouterLink>
    </div>

    <button
      v-else
      type="button"
      :disabled="busy || result === undefined || blocked()"
      class="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
      data-testid="import-apply"
      @click="apply"
    >
      {{ busy ? 'Working…' : 'Import' }}
    </button>
  </div>
</template>
