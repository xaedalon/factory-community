<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, type Definition, type ProviderEntry } from '../api/client.js'
import { useEditor } from '../composables/useEditor.js'
import EditorLayout from '../components/form/EditorLayout.vue'
import YamlPreview from '../components/form/YamlPreview.vue'
import ScopeSelector from '../components/form/ScopeSelector.vue'
import FieldRow from '../components/form/FieldRow.vue'
import TextInput from '../components/form/TextInput.vue'
import StringListEditor from '../components/form/StringListEditor.vue'
import ConflictPanel from '../components/form/ConflictPanel.vue'
import AppIcon from '../components/AppIcon.vue'

/**
 * A profile: which commands an agent may run here, beyond the Default profile.
 *
 * The page's job beyond the form is to be honest about two things a profile
 * cannot say for itself — that an entry may already be allowed and change
 * nothing, and that a provider may be unable to honour it at all. Both are
 * true, both are invisible in the YAML, and a profile written without knowing
 * them is a profile whose author thinks it does more than it does.
 */
const route = useRoute()
const router = useRouter()
const name = computed(() => route.params.name as string | undefined)

const blank = (): Definition => ({
  name: '',
  description: '',
  extends: 'default',
  commands: [],
  denyCommands: [],
  providers: {},
  extensions: {},
})

const editor = useEditor('profile', blank)
const view = ref<'form' | 'yaml'>('form')
const providers = ref<ProviderEntry[]>([])

const field = <T,>(key: string, fallback: T) =>
  computed({
    get: () => (editor.definition.value[key] as T | undefined) ?? fallback,
    set: (value: T) => {
      editor.definition.value = { ...editor.definition.value, [key]: value }
    },
  })

const nameField = field('name', '')
const description = field('description', '')
const commands = field<string[]>('commands', [])
const denyCommands = field<string[]>('denyCommands', [])

/**
 * Commands that run whatever they are given.
 *
 * The same list the parser warns about, shown while it is being typed rather
 * than after it is saved — `Bash(node *)` was measured writing outside the
 * workspace on the first attempt.
 */
const INTERPRETERS = [
  'sh', 'bash', 'zsh', 'fish', 'env', 'node', 'deno', 'python', 'python3',
  'ruby', 'perl', 'php', 'osascript', 'xargs', 'eval',
]
const leading = (command: string): string => (command.trim().split(/\s+/)[0] ?? '').trim()
const risky = computed(() => commands.value.filter((c) => INTERPRETERS.includes(leading(c))))

/** Providers that cannot express a command list at all, so this profile misses them. */
const cannotHonour = computed(() =>
  commands.value.length === 0
    ? []
    : providers.value.filter((entry) => entry.commandAllowFlag === undefined),
)

onMounted(async () => {
  await editor.load(name.value)
  providers.value = (await api.providers()).items
})
</script>

<template>
  <EditorLayout
    :title="name ? `Profile · ${name}` : 'New profile'"
    :saving="editor.saving.value"
    :dirty="editor.dirty.value"
    :problems="editor.problems.value"
    :save-label="editor.saveLabel.value"
    :deletable="!editor.isNew.value"
    v-model:view="view"
    @save="editor.save()"
    @remove="editor.remove()"
    @cancel="router.push('/profiles')"
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
      </FieldRow>

      <FieldRow label="Name" for="pr-name">
        <TextInput id="pr-name" v-model="nameField" mono placeholder="development" />
      </FieldRow>

      <FieldRow label="Description" for="pr-description">
        <TextInput
          id="pr-description"
          v-model="description"
          placeholder="Default, plus the build tools this repository uses."
        />
      </FieldRow>

      <FieldRow
        label="Extends"
        hint="Always the Default profile. A profile that started from Full Access would be Full Access with a friendlier name and no warning."
      >
        <p class="font-mono text-sm text-[var(--color-ink-muted)]" data-testid="profile-extends">
          default
        </p>
      </FieldRow>

      <FieldRow
        label="Allow"
        hint="Commands an agent may run here. A name — cargo — or a name and a sub-command — git push. Read-only commands are already allowed, so this is for the ones with side effects."
      >
        <StringListEditor v-model="commands" placeholder="cargo" testid="profile-commands" />
        <!-- Said while it is being typed rather than after it is saved: the
             parser warns too, but by then the decision has been made. -->
        <p
          v-if="risky.length > 0"
          class="mt-2 flex items-start gap-1.5 rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-3 py-2 text-xs text-[var(--color-warn)]"
          data-testid="profile-interpreter-warning"
        >
          <AppIcon name="alert" :size="12" class="mt-0.5" />
          <span>
            {{ risky.join(', ') }} runs whatever it is given. Confinement stops Factory's own file
            tools leaving the workspace; it cannot stop a child process doing it with its own
            syscalls. Allow it if that is the trade you mean to make.
          </span>
        </p>
        <p
          v-if="cannotHonour.length > 0"
          class="mt-2 text-xs text-[var(--color-ink-muted)]"
          data-testid="profile-unsupported"
        >
          {{ cannotHonour.map((entry) => entry.displayName).join(', ') }}
          {{ cannotHonour.length === 1 ? 'has' : 'have' }} no way to allow one command rather than
          all of them, so this list does not reach
          {{ cannotHonour.length === 1 ? 'it' : 'them' }}.
        </p>
      </FieldRow>

      <FieldRow
        label="Deny"
        hint="Taken back out, where the agent's CLI has a deny-list. git push, when you allowed git."
      >
        <StringListEditor
          v-model="denyCommands"
          placeholder="git push"
          testid="profile-deny-commands"
        />
      </FieldRow>
    </template>

    <template #preview>
      <YamlPreview :text="editor.preview.value" :stale="editor.previewPending.value" />
    </template>
  </EditorLayout>
</template>
