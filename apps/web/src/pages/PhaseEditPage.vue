<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  api,
  type Definition,
  type DefinitionListing,
  type ProviderEntry,
  type StepKindEntry,
  type TokenNamespace,
} from '../api/client.js'
import { useProjects } from '../stores/projects.js'
import { useEditor } from '../composables/useEditor.js'
import EditorLayout from '../components/form/EditorLayout.vue'
import YamlPreview from '../components/form/YamlPreview.vue'
import ScopeSelector from '../components/form/ScopeSelector.vue'
import FieldRow from '../components/form/FieldRow.vue'
import TextInput from '../components/form/TextInput.vue'
import SelectInput from '../components/form/SelectInput.vue'
import VariablesEditor from '../components/form/VariablesEditor.vue'
import StepsEditor from '../components/form/StepsEditor.vue'
import ConflictPanel from '../components/form/ConflictPanel.vue'

const route = useRoute()
const router = useRouter()
const name = computed(() => route.params.name as string | undefined)

const blank = (): Definition => ({
  name: '',
  description: '',
  approval: 'none',
  variables: {},
  steps: [],
  extensions: {},
})

const chosen = useProjects()
const editor = useEditor('phase', blank)
const view = ref<'form' | 'yaml'>('form')
const stepKinds = ref<StepKindEntry[]>([])
const tokens = ref<TokenNamespace[]>([])
const providers = ref<ProviderEntry[]>([])
const agents = ref<DefinitionListing[]>([])

/**
 * What a step's `x-options` fields offer.
 *
 * None of these can live in a schema: which providers are installed is a fact
 * about this machine, and which agents exist is a fact about this project's
 * scopes. The kind names the set, this fills it.
 */
const catalogues = computed<Record<string, readonly string[]>>(() => ({
  providers: providers.value.map((entry) => entry.id),
  agents: agents.value.map((entry) => entry.name),
  models: [
    'strong',
    'balanced',
    'fast',
    ...providers.value.flatMap((entry) => Object.values(entry.models)),
  ],
  // Every value any installed provider understands. A step is not tied to one
  // provider until it names one, so narrowing further here would hide options
  // that are perfectly valid once the agent is chosen.
  effort: [...new Set(providers.value.flatMap((entry) => entry.effortValues))],
}))

const field = <T,>(key: string, fallback: T) =>
  computed({
    get: () => (editor.definition.value[key] as T | undefined) ?? fallback,
    set: (value: T) => {
      editor.definition.value = { ...editor.definition.value, [key]: value }
    },
  })

const optional = (key: string) =>
  computed({
    get: () => (editor.definition.value[key] as string | undefined) ?? '',
    set: (value: string) => {
      const next = { ...editor.definition.value }
      if (value === '') delete next[key]
      else next[key] = value
      editor.definition.value = next
    },
  })

const nameField = field('name', '')
const description = field('description', '')
const approval = field('approval', 'none')
const workingDir = optional('workingDir')
const variables = field<Record<string, string>>('variables', {})
const steps = field<({ uses: string } & Record<string, unknown>)[]>('steps', [])

onMounted(async () => {
  await editor.load(name.value)
  // Arriving from a workflow's "create this missing phase" link: pre-fill the
  // name so the reason you came here is already filled in.
  const suggested = route.query.name
  if (name.value === undefined && typeof suggested === 'string') {
    editor.definition.value = { ...editor.definition.value, name: suggested }
  }
  stepKinds.value = (await api.stepKinds()).items
  tokens.value = (await api.tokens()).items
  providers.value = (await api.providers()).items
  agents.value = (await api.list('agent', chosen.projectId)).items
})
</script>

<template>
  <EditorLayout
    :title="name ? `Phase · ${name}` : 'New phase'"
    :saving="editor.saving.value"
    :dirty="editor.dirty.value"
    :problems="editor.problems.value"
    :save-label="editor.saveLabel.value"
    :deletable="!editor.isNew.value"
    v-model:view="view"
    @save="editor.save()"
    @remove="editor.remove()"
    @cancel="router.push('/phases')"
  >
    <template #conflict>
      <ConflictPanel
        v-if="editor.conflict.value"
        :raw="editor.conflict.value.raw"
        @reload="editor.reload()"
        @overwrite="editor.overwrite()"
      />
    </template>
    <template #form>
      <FieldRow label="Scope">
        <ScopeSelector
          v-model="editor.targetScope.value"
          :scopes="editor.scopes.value"
          :origin="editor.origin.value"
          @fork="editor.fork()"
        />
        <p
          v-if="editor.willShadow.value.length > 0"
          class="mt-2 rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-3 py-2 text-xs text-[var(--color-warn)]"
          data-testid="will-shadow"
        >
          Saving here will hide the
          {{ editor.willShadow.value.map((ref) => ref.scope).join(', ') }} copy.
        </p>
      </FieldRow>

      <FieldRow label="Name" for="ph-name">
        <TextInput id="ph-name" v-model="nameField" mono placeholder="analysis" />
      </FieldRow>

      <FieldRow label="Description" for="ph-description">
        <TextInput id="ph-description" v-model="description" placeholder="What this does." />
      </FieldRow>

      <FieldRow
        label="Approval"
        for="ph-approval"
        hint="Required means the workflow pauses here until someone approves it."
      >
        <SelectInput id="ph-approval" v-model="approval" :options="['none', 'required']" />
      </FieldRow>

      <FieldRow label="Working dir" for="ph-workdir" hint="Relative to the workspace. Applies to every step.">
        <TextInput id="ph-workdir" v-model="workingDir" mono placeholder="web" />
      </FieldRow>

      <FieldRow label="Variables">
        <VariablesEditor v-model="variables" />
      </FieldRow>

      <div class="pt-4">
        <p class="mb-2 font-mono text-label text-[var(--color-ink-faint)] uppercase">
          Steps
        </p>
        <StepsEditor
          v-model="steps"
          :kinds="stepKinds"
          :catalogues="catalogues"
          :tokens="tokens"
          :declared-variables="{ phase: variables }"
        />
      </div>
    </template>

    <template #preview>
      <YamlPreview :text="editor.preview.value" :stale="editor.previewPending.value" />
    </template>
  </EditorLayout>
</template>
