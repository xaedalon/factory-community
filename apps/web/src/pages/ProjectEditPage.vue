<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError, api, type ExecutionProfile, type Project } from '../api/client.js'
import { markInitials, markTone } from '../identity.js'
import PageHeader from '../components/PageHeader.vue'
import AppButton from '../components/AppButton.vue'
import AppIcon from '../components/AppIcon.vue'
import Tooltip from '../components/Tooltip.vue'
import FieldRow from '../components/form/FieldRow.vue'
import TextInput from '../components/form/TextInput.vue'
import SelectInput from '../components/form/SelectInput.vue'
import ToggleField from '../components/form/ToggleField.vue'
import MarkPicker from '../components/form/MarkPicker.vue'

/**
 * A project, on a page of its own.
 *
 * It was a seven-control strip above the list, and then the same settings again
 * as buttons *inside* each row — buttons labelled with the state they would
 * move to, so "Use worktrees" meant worktrees were off. Nothing said what a
 * path was for, the profile select sat unlabelled between two toggles, and
 * Remove destroyed a project on one click with no confirmation.
 *
 * The board already made this decision once: `New task` became a page in
 * increment 4 for exactly these reasons. This is the same move.
 *
 * One component for both new and existing, because the two forms differ by two
 * fields and a verb, and the alternative is two files that drift.
 */
const route = useRoute()
const router = useRouter()

const id = computed(() => (route.params.id as string | undefined) ?? undefined)
const isNew = computed(() => id.value === undefined)

const name = ref('')
const path = ref('')
const branch = ref('main')
/**
 * The command that says whether this project's work is sound.
 *
 * Blank is a real answer — "no gate here" — so it is never filled in from the
 * name or guessed on this side. The daemon detects it once, when the project
 * is added, from what is actually in the repository.
 */
const check = ref('')
const usesWorktrees = ref(true)
const usesEnvironments = ref(false)
const profile = ref('')
const tone = ref<number | undefined>(undefined)
const letters = ref<string | undefined>(undefined)

const loaded = ref<Project | undefined>(undefined)
const loading = ref(false)
const saving = ref(false)
const error = ref<string | undefined>(undefined)
const fieldErrors = ref<Record<string, string | undefined>>({})
const scaffolded = ref<string[]>([])
const confirmingRemove = ref(false)

/**
 * What the daemon said, put against the box it is about.
 *
 * The API answers in sentences meant for a person — "A project called X already
 * exists." — and a banner at the top of a form makes you check every field to
 * find out which one it meant.
 */
function placeError(message: string): void {
  const lower = message.toLowerCase()
  fieldErrors.value = {}
  if (lower.includes('already exists') || lower.includes('needs a name')) {
    fieldErrors.value.name = message
  } else if (lower.includes('branch')) {
    fieldErrors.value.branch = message
  } else if (
    lower.includes('path') ||
    lower.includes('directory') ||
    lower.includes('not a git repository') ||
    lower.includes('nothing at')
  ) {
    fieldErrors.value.path = message
  } else {
    error.value = message
  }
}

async function load(): Promise<void> {
  if (isNew.value) return
  loading.value = true
  try {
    const found = (await api.projects()).items.find((project) => project.id === id.value)
    if (found === undefined) {
      error.value = 'That project is not here any more.'
      return
    }
    loaded.value = found
    name.value = found.name
    path.value = found.path
    branch.value = found.defaultBranch
    check.value = found.check ?? ''
    usesWorktrees.value = found.usesWorktrees
    usesEnvironments.value = found.usesEnvironments
    profile.value = found.profile ?? ''
    tone.value = found.tone
    letters.value = found.initials
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  } finally {
    loading.value = false
  }
}

/**
 * Worktrees need a repository, and the daemon is the only side that can look.
 *
 * Known for a project that already exists, because the daemon said so when it
 * was added. Unknowable while typing a path, so the switch stays live and the
 * refusal arrives from the daemon against the path field.
 */
const cannotUseWorktrees = computed(() => loaded.value !== undefined && !loaded.value.isRepository)
watch(cannotUseWorktrees, (blocked) => {
  if (blocked) usesWorktrees.value = false
})

async function save(): Promise<void> {
  error.value = undefined
  fieldErrors.value = {}
  scaffolded.value = []
  saving.value = true
  try {
    if (isNew.value) {
      const created = await api.addProject({
        name: name.value.trim(),
        path: path.value.trim(),
        ...(branch.value.trim() === '' ? {} : { defaultBranch: branch.value.trim() }),
        usesWorktrees: usesWorktrees.value,
        usesEnvironments: usesEnvironments.value,
        // Only when typed. Omitting it entirely is what asks the daemon to
        // look in the repository, and a blank string would mean "no gate".
        ...(check.value.trim() === '' ? {} : { check: check.value.trim() }),
      })
      // Back to the list, the way the definition editors do it. The list is
      // where the change is visible — the badges, the branch, the name — and
      // "I added it, there it is" is the whole confirmation anyone wants.
      // The scope directory counts as something written into somebody's
      // repository, and it is the one the rest of the list goes inside.
      await leaveWith(
        created.scaffolded?.written ?? [],
        created.scope?.created === true ? created.scope.root : undefined,
      )
      return
    }
    const result = await api.setProjectSetting(id.value as string, {
      name: name.value.trim(),
      defaultBranch: branch.value.trim(),
      usesWorktrees: usesWorktrees.value,
      usesEnvironments: usesEnvironments.value,
      profile: profile.value === '' ? null : (profile.value as ExecutionProfile),
      tone: tone.value ?? null,
      initials: letters.value ?? null,
      check: check.value.trim() === '' ? null : check.value.trim(),
    })
    // A scaffold *error* is a reason to stay: it is about this form, and the
    // person is mid-edit. A scaffold *report* is a result, and travels.
    if (result.scaffolded.error !== undefined) {
      error.value = result.scaffolded.error
      scaffolded.value = result.scaffolded.written
      await load()
      return
    }
    await leaveWith(result.scaffolded.written)
  } catch (caught) {
    placeError(caught instanceof ApiError ? caught.message : String(caught))
  } finally {
    saving.value = false
  }
}

/**
 * Back to the list, carrying anything Factory just wrote into the repository.
 *
 * Through history state rather than a store or a query string: it is a result
 * of one navigation and belongs to it, so it should not survive a reload or
 * show up in a shared URL. The next thing that happens to this person is a
 * `git status` they were not expecting, and they should have been told which
 * files before they get there.
 */
async function leaveWith(written: readonly string[], scopeRoot?: string): Promise<void> {
  const files = scopeRoot === undefined ? [...written] : [scopeRoot, ...written]
  await router.push({
    path: '/projects',
    // `hidden` only when Factory created the directory: that is the one case
    // where "git ignores all of it" is true, because Factory never writes an
    // ignore file over a scope somebody may already be sharing.
    ...(files.length > 0
      ? { state: { scaffolded: files, hidden: scopeRoot !== undefined } }
      : {}),
  })
}

async function remove(): Promise<void> {
  try {
    await api.removeProject(id.value as string)
    await router.push('/projects')
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  }
}

const canSave = computed(
  () => name.value.trim() !== '' && (isNew.value ? path.value.trim() !== '' : true),
)

onMounted(load)
</script>

<template>
  <PageHeader
    :title="isNew ? 'New project' : (loaded?.name ?? 'Project')"
    :subtitle="
      isNew
        ? 'A repository on this machine, and how Factory should work inside it.'
        : 'What this project is called, where work starts, and how much room its agents get.'
    "
  >
    <template #actions>
      <AppButton
        label="Back to projects"
        icon="back"
        icon-only
        hint="Back to projects"
        @click="router.push('/projects')"
      />
    </template>
  </PageHeader>

  <div class="px-8 py-6">
    <form class="max-w-2xl" data-testid="project-form" @submit.prevent="save">
      <div v-if="!isNew && loaded" class="mb-5 flex items-center gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-medium text-white"
          :style="{ backgroundColor: markTone(loaded) }"
          aria-hidden="true"
        >
          {{ markInitials(loaded) }}
        </span>
        <div class="min-w-0">
          <p class="truncate text-sm">{{ loaded.name }}</p>
          <p class="text-xs text-[var(--color-ink-muted)]">
            {{ loaded.tasks }} task{{ loaded.tasks === 1 ? '' : 's' }}
          </p>
        </div>
      </div>

      <FieldRow
        label="Name"
        icon="project"
        required
        for="project-name"
        hint="What this repository is called on the board. The rail derives its square and colour from it."
        :error="fieldErrors.name"
      >
        <TextInput id="project-name" v-model="name" data-testid="project-name" placeholder="factory" />
      </FieldRow>

      <FieldRow
        label="Path"
        icon="folder"
        :required="isNew"
        for="project-path"
        :hint="
          isNew
            ? 'The absolute path to the repository on this machine. The daemon checks it, because the browser cannot.'
            : 'Where this project lives. Changing it would orphan every run that recorded the old path, so a moved repository is added as a new project.'
        "
        :error="fieldErrors.path"
      >
        <TextInput
          v-if="isNew"
          id="project-path"
          v-model="path"
          mono
          data-testid="project-path"
          placeholder="/Users/you/projects/thing"
        />
        <p
          v-else
          class="value flex items-center gap-2 rounded-md border border-dashed border-[var(--color-line)] px-3 py-1.5 text-[var(--color-ink-muted)]"
          data-testid="project-path-fixed"
        >
          <AppIcon name="folder" :size="12" />
          <span class="truncate">{{ path }}</span>
        </p>
      </FieldRow>

      <FieldRow
        label="Branch"
        icon="branch"
        for="project-branch"
        hint="Where work starts from, and what merges aim at. Pointing this somewhere other than your published default is how you keep that branch clean."
        :error="fieldErrors.branch"
      >
        <TextInput id="project-branch" v-model="branch" mono data-testid="project-branch" placeholder="main" />
      </FieldRow>

      <FieldRow
        label="Checked by"
        icon="check"
        for="project-check"
        hint="One command that says whether the work is sound — whatever this repository already runs in CI. The built-in project-check phase is exactly this command, so a workflow ending in a real gate is one word in its phase list. Left empty, that phase refuses to run rather than passing on nothing."
      >
        <TextInput
          id="project-check"
          v-model="check"
          mono
          data-testid="project-check"
          placeholder="pnpm test"
        />
      </FieldRow>

      <FieldRow
        label="Square"
        icon="project"
        hint="What the rail shows for this project. Left automatic it follows the name — which means a rename changes it, and two projects can land on the same hue."
      >
        <MarkPicker
          v-model:tone="tone"
          v-model:initials="letters"
          :name="name"
        />
      </FieldRow>

      <div class="mt-5 space-y-2">
        <p class="font-mono text-label text-[var(--color-ink-faint)] uppercase">
          How work runs here
        </p>

        <ToggleField
          v-model="usesWorktrees"
          label="A worktree per task"
          icon="worktree"
          data-testid="project-worktrees-field"
          when-on="Each task gets a checkout of its own, beside the project and never inside it. Tasks can run at the same time."
          when-off="Work happens in the repository itself, so this project runs one task at a time — two agents in one working copy overwrite each other."
          :disabled="cannotUseWorktrees"
          disabled-reason="There is no .git directory at that path, so there is nothing to make a worktree from."
        />

        <ToggleField
          v-model="usesEnvironments"
          label="An environment per task"
          icon="environment"
          data-testid="project-environments-field"
          when-on="Environment workflows are copied into the repository for you to edit."
          when-off="Tasks run against whatever is already installed in the workspace."
        />
      </div>

      <div v-if="!isNew" class="mt-5">
        <FieldRow
          label="Authority"
          icon="profile"
          for="project-profile"
          hint="How much an agent in this project may reach. Following the installation means this project changes when the installation does — choosing one pins it."
        >
          <!-- Three positions, and the third is the one that matters: a project
               that states nothing follows the installation, so changing the
               installation changes it. Without an empty option the control
               showed "default" for a project that had chosen nothing — which
               is not a display detail, because `default` pins the project
               against an installation that later switches to Full Access. -->
          <SelectInput
            id="project-profile"
            v-model="profile"
            data-testid="project-profile"
            allow-empty
            empty-label="Follows the installation"
            :options="['default', 'full-access']"
          />
          <p
            v-if="profile === 'full-access'"
            class="mt-1 flex items-start gap-1.5 text-xs text-[var(--color-warn)]"
            data-testid="full-access-warning"
          >
            <AppIcon name="alert" :size="12" class="mt-0.5" />
            Agents in this project are not confined to the workspace and keep the daemon's
            environment.
          </p>
        </FieldRow>
      </div>

      <p
        v-if="error"
        class="mt-5 flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
        data-testid="error"
      >
        <AppIcon name="alert" class="mt-0.5" />
        {{ error }}
      </p>

      <!-- Factory has just written into a working copy. Say which files,
           because the next thing that happens is a `git status` nobody was
           expecting. -->
      <div
        v-if="scaffolded.length > 0"
        class="mt-5 rounded-lg border border-[var(--color-info)]/40 bg-[var(--color-info)]/5 px-4 py-3 text-sm text-[var(--color-info)]"
        data-testid="scaffolded"
      >
        <p class="flex items-center gap-2">
          <AppIcon name="info" />
          Copied into the project:
        </p>
        <ul class="mt-1 space-y-0.5">
          <li v-for="file in scaffolded" :key="file" class="font-mono text-xs">{{ file }}</li>
        </ul>
      </div>

      <div class="mt-6 flex items-center gap-2 border-t border-[var(--color-line)] pt-5">
        <AppButton
          :label="isNew ? 'Add project' : 'Save changes'"
          :icon="isNew ? 'add' : 'check'"
          tone="primary"
          type="submit"
          :disabled="!canSave || saving || loading"
          :hint="isNew ? 'Register this repository with Factory' : 'Write these settings back to the project'"
          data-testid="save-project"
        />
        <AppButton label="Cancel" @click="router.push('/projects')" />

        <!-- Two clicks, and the second one says what it will cost. The same
             idiom the definition editor uses for delete, for the same reason:
             there is no undo, and the tasks that ran here lose their project. -->
        <template v-if="!isNew">
          <AppButton
            v-if="!confirmingRemove"
            label="Remove"
            icon="remove"
            tone="danger"
            class="ml-auto"
            hint="Take this project out of Factory"
            data-testid="remove-project"
            @click="confirmingRemove = true"
          />
          <Tooltip
            v-else
            :label="`${loaded?.tasks ?? 0} task${loaded?.tasks === 1 ? '' : 's'} will be left without a project`"
          >
            <button
              type="button"
              class="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--color-danger)]/60 px-3 py-1.5 text-sm text-[var(--color-danger)]"
              data-testid="remove-project-confirm"
              @click="remove"
            >
              <AppIcon name="remove" />
              Really remove {{ loaded?.name }}?
            </button>
          </Tooltip>
        </template>
      </div>
    </form>
  </div>
</template>
