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
import AppButton from '../components/AppButton.vue'
import AppIcon from '../components/AppIcon.vue'
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
    <FieldRow
      label="File"
      icon="import"
      hint="A bundle is one YAML file carrying a workflow and every phase and agent it references."
    >
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

    <FieldRow label="Or paste" icon="edit" hint="The same thing, if it came to you as text rather than a file.">
      <textarea
        v-model="text"
        rows="6"
        placeholder="kind: factory.bundle/v1"
        data-testid="bundle-text"
        class="value w-full rounded-md border border-[var(--color-line)] bg-[var(--color-base)] px-3 py-2 text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] focus:outline-none"
      />
    </FieldRow>

    <FieldRow label="Into" icon="folder" hint="Which scope the definitions are written to. The Scopes page says which one wins when a name exists twice.">
      <SelectInput
        v-model="targetScope"
        :options="scopes.map((scope) => scope.kind)"
        id="import-scope"
      />
    </FieldRow>

    <FieldRow
      label="On conflict"
      icon="alert"
      hint="Fail leaves everything untouched. Skip takes only what is new. Overwrite replaces, keeping the previous version in .trash."
    >
      <SelectInput
        v-model="policy"
        :options="['fail', 'skip', 'overwrite']"
        id="import-policy"
      />
    </FieldRow>

    <FieldRow
      label="Prefix"
      icon="edit"
      hint="Renames everything on the way in and rewrites the references between them. Use it when a name is already taken."
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
        class="flex items-start gap-1.5 text-xs leading-relaxed"
        :class="
          problem.severity === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-warn)]'
        "
      >
        <AppIcon name="alert" :size="12" class="mt-0.5" />
        {{ problem.message }}
      </p>
    </div>

    <section v-if="result && result.plan.items.length > 0">
      <h2 class="mb-2 font-mono text-labelst text-[var(--color-ink-faint)] uppercase">
        {{ imported ? 'Imported' : 'Would import' }} · {{ result.plan.entry }}
      </h2>
      <ImportPlanTable :items="result.plan.items" />
    </section>

    <div
      v-if="imported"
      class="flex items-center gap-2 rounded-xl border border-[var(--color-ok)]/40 bg-[var(--color-ok)]/5 px-4 py-3 text-sm text-[var(--color-ok)]"
      data-testid="imported"
    >
      <AppIcon name="check" />
      <span class="flex-1">Wrote {{ result?.written.length ?? 0 }} file(s).</span>
      <RouterLink
        to="/workflows"
        class="inline-flex items-center gap-1.5 text-[var(--color-accent-text)] hover:underline"
      >
        Back to workflows
        <AppIcon name="go" :size="12" />
      </RouterLink>
    </div>

    <AppButton
      v-else
      :label="busy ? 'Working…' : 'Import'"
      icon="import"
      tone="primary"
      :disabled="busy || result === undefined || blocked()"
      hint="Write these definitions into the chosen scope"
      data-testid="import-apply"
      @click="apply"
    />
  </div>
</template>
