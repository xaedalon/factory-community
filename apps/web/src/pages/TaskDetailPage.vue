<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  ApiError,
  api,
  type DefinitionListing,
  type Evidence,
  type LogView,
  type RunStep,
  type TaskDetail,
  type TaskListItem,
  type TaskTool,
  type WorkflowChoice,
} from '../api/client.js'
import { live, type LiveConnection } from '../api/live.js'
import { useSettings } from '../stores/settings.js'
import PageHeader from '../components/PageHeader.vue'
import TaskStateBadge from '../components/TaskStateBadge.vue'
import TaskActions from '../components/TaskActions.vue'
import WorkflowPicker from '../components/WorkflowPicker.vue'
import { useClipboard } from '../composables/useClipboard.js'

/**
 * One task: what it is, what it has done, and what it printed.
 *
 * This is the page the prototype could not have. Its runs lived in log files
 * named after the time they started, so answering "what did the agent actually
 * do?" began with finding the right file. Here the steps are rows and the
 * output is attached to the step that produced it.
 */
const route = useRoute()
const router = useRouter()
const settings = useSettings()
const detail = ref<TaskDetail | undefined>(undefined)
const steps = ref<RunStep[]>([])
const evidence = ref<Evidence[]>([])
const openRun = ref<string | undefined>(undefined)
/** The run the page is showing, so its own detail and profile can be read. */
const openedRun = computed(() =>
  detail.value?.runs.find((run) => run.id === openRun.value),
)
const openStep = ref<number | undefined>(undefined)
const log = ref<LogView | undefined>(undefined)
const error = ref<string | undefined>(undefined)
const busy = ref(false)
const available = ref<DefinitionListing[]>([])
/**
 * The list being edited, held apart from the task.
 *
 * A live event reloads this page, and a reload that wrote straight into the
 * task would wipe out a plan someone was halfway through rearranging.
 */
const plan = ref<WorkflowChoice[]>([])
/** Whose plan is in `plan`, so the first load of a task fills it. */
const planFor = ref<string | undefined>(undefined)
const saving = ref(false)

/**
 * The name being edited, held apart from the task for the same reason the plan
 * is: `load()` runs on every event behind a 120 ms debounce, and writing
 * straight into `detail` would delete whatever was half-typed.
 */
/**
 * Getting to where the work is.
 *
 * The row this drives is the first thing on the page because "which directory
 * is this happening in" is the first thing anybody wants when a task needs
 * looking at by hand — and until now the answer was only inside the daemon.
 */
const { copied, copy } = useClipboard()
const opening = ref<string | undefined>(undefined)

/**
 * Do what a tool offers, or fall back to copying its command.
 *
 * One function for every button on the row, because what differs between them
 * is data the daemon resolved — not a code path here. The two that used to be
 * written into this page each had their own branch; now the page does not know
 * what a terminal is.
 *
 * The 501 branch is still handled: whatever performs a tool could have gone
 * away between the load and the click, and copying is a better answer than an
 * error about a plugin.
 */
async function runTool(tool: TaskTool): Promise<void> {
  if (!tool.runnable) {
    await copy(tool.command)
    return
  }
  opening.value = tool.id
  try {
    await api.runTool(id.value, tool.id)
    error.value = undefined
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 501) {
      await copy(tool.command)
    } else {
      error.value = caught instanceof ApiError ? caught.message : String(caught)
    }
  } finally {
    opening.value = undefined
  }
}

/**
 * Whether the last copy was one of these commands.
 *
 * One confirmation for the row rather than one per button: which was pressed is
 * obvious from having just pressed it, and three "copied" labels on a busy line
 * is noise.
 */
const justCopied = computed(
  () => detail.value?.tools.some((tool) => tool.command === copied.value) === true,
)

const renaming = ref(false)
const nameDraft = ref('')
const renamingBusy = ref(false)
const describing = ref(false)
const descriptionDraft = ref('')
const describingBusy = ref(false)

/**
 * A plan can be changed right up until the task starts carrying it out.
 *
 * Running and awaiting approval are both in flight: the engine has read the
 * list and is counting a cursor through it, and a task at a gate is holding a
 * paused run partway down it. The daemon refuses in both cases too — the same
 * rule said twice on purpose, because a disabled button is a courtesy and the
 * refusal is the guarantee.
 */
const editable = computed(
  () =>
    detail.value !== undefined &&
    !['running', 'awaiting_approval'].includes(detail.value.task.state),
)
/**
 * Only what the person can actually change.
 *
 * Comparing the whole entry would leave the form permanently dirty: `ran` is
 * the daemon's, it changes under a live reload, and a form that is always
 * dirty is a plan that never refreshes — the guard in `load` only takes a new
 * list when nothing is being edited.
 */
const editableShape = (entries: readonly WorkflowChoice[]): string =>
  JSON.stringify(entries.map((entry) => [entry.id, entry.workflow, entry.enabled]))
const dirty = computed(
  () => editableShape(plan.value) !== editableShape(detail.value?.task.workflows ?? []),
)

/**
 * The ticks outlive the rest of the form.
 *
 * Calling off a later stage while an earlier one runs is a reasonable thing to
 * want; rearranging the list under a running engine is not. The entry actually
 * running cannot be unticked either — the engine has already read it — which
 * the daemon enforces and this only reflects.
 */
const tickable = computed(() => detail.value !== undefined)
/** The same sum the board draws, from the same served numbers. */
const percent = computed(() => {
  const progress = detail.value?.progress
  return progress === undefined || progress.total === 0
    ? 0
    : Math.round((progress.completed / progress.total) * 100)
})

/** Nothing left to run, so the Queue button is withheld and this offers a way back. */
const nothingTicked = computed(
  () => plan.value.length > 0 && !plan.value.some((entry) => entry.enabled),
)
const tickEverything = (): void => {
  plan.value = plan.value.map((entry) => ({ ...entry, enabled: true }))
}

/**
 * What this task could be made to wait for.
 *
 * Its own project's tasks, itself excluded. Cross-project dependencies are
 * refused by the store — a graph spanning two repositories has no owner, and
 * the buttons that act on one are project-level — so offering them would be
 * offering a refusal.
 *
 * Tasks it already waits for are left out of the list rather than shown
 * ticked: adding an edge twice does nothing, so a menu entry that does nothing
 * is worse than no entry.
 */
const candidates = ref<TaskListItem[]>([])
const blocking = ref(false)
/**
 * A refusal from the graph, shown beside the picker.
 *
 * Its own line rather than the page's error banner: "that would make a ring"
 * is an answer to the control that was just used, and it belongs next to it.
 */
const dependencyError = ref<string | undefined>(undefined)
const addBlocker = ref('')

const waitsFor = computed(() => detail.value?.blockers ?? [])

async function loadCandidates(): Promise<void> {
  const task = detail.value?.task
  if (task === undefined) return
  try {
    const all = await api.tasks({ includeArchived: false })
    const already = new Set(task.dependsOn)
    candidates.value = all.items.filter(
      (other) =>
        other.id !== task.id && other.projectId === task.projectId && !already.has(other.id),
    )
  } catch {
    // The page still works without it; you simply cannot add an edge.
    candidates.value = []
  }
}

async function dependOn(): Promise<void> {
  const blocker = addBlocker.value
  if (blocker === '') return
  blocking.value = true
  dependencyError.value = undefined
  try {
    await api.dependOn(id.value, blocker)
    addBlocker.value = ''
    await load()
  } catch (caught) {
    // The daemon's sentence, which is the store's sentence. Rewording it here
    // would be a second explanation of one rule.
    dependencyError.value = caught instanceof ApiError ? caught.message : String(caught)
  } finally {
    blocking.value = false
  }
}

async function independ(blockerId: string): Promise<void> {
  blocking.value = true
  dependencyError.value = undefined
  try {
    await api.independ(id.value, blockerId)
    await load()
  } catch (caught) {
    dependencyError.value = caught instanceof ApiError ? caught.message : String(caught)
  } finally {
    blocking.value = false
  }
}

let connection: LiveConnection | undefined
let pending: ReturnType<typeof setTimeout> | undefined

const id = computed(() => String(route.params.id))

async function load(): Promise<void> {
  try {
    detail.value = await api.task(id.value)
    // Always on the first load of a task — an empty plan against a task with
    // workflows reads as "edited", and inferring from that alone would leave
    // the list permanently blank. After that, only when nothing is being
    // edited: see `plan`.
    if (planFor.value !== id.value || !dirty.value) {
      plan.value = detail.value.task.workflows.map((entry) => ({ ...entry }))
      planFor.value = id.value
    }
    void loadWorkflows()
    void loadCandidates()
    error.value = undefined
    // Keep whichever run was open; otherwise show the newest, which is what
    // someone opening a task almost always wants to see.
    const chosen = openRun.value ?? detail.value.runs[0]?.id
    if (chosen !== undefined) await openTheRun(chosen)
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  }
}

async function openTheRun(runId: string): Promise<void> {
  openRun.value = runId
  const result = await api.run(runId)
  steps.value = result.steps
  evidence.value = result.evidence
  if (openStep.value !== undefined && !result.steps.some((step) => step.id === openStep.value)) {
    openStep.value = undefined
    log.value = undefined
  }
  if (openStep.value !== undefined) await showLog(openStep.value)
}

async function showLog(stepId: number): Promise<void> {
  openStep.value = stepId
  log.value = await api.runLogs(openRun.value as string, stepId)
}

async function act(action: string): Promise<void> {
  busy.value = true
  try {
    await api.actOnTask(id.value, action)
    await load()
  } catch (caught) {
    // A 409 carrying a disclaimer is the daemon saying nobody has been told
    // what a run can reach. It becomes the panel rather than a red message, so
    // it appears where the button was pressed — which is the point of gating in
    // the daemon and not on first load.
    if (
      settings.handledRefusal(caught, async () => {
        await api.actOnTask(id.value, action)
        await load()
      })
    ) {
      return
    }
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  } finally {
    busy.value = false
  }
}


/** What this task's project can run, which is not what the installation can. */
async function loadWorkflows(): Promise<void> {
  try {
    available.value = (await api.list('workflow', detail.value?.task.projectId)).items
  } catch {
    // The page still works without it; you simply cannot click a name in.
    available.value = []
  }
}

function startRename(): void {
  nameDraft.value = detail.value?.task.name ?? ''
  renaming.value = true
}

async function saveName(): Promise<void> {
  const wanted = nameDraft.value.trim()
  if (wanted === '' || wanted === detail.value?.task.name) {
    renaming.value = false
    return
  }
  renamingBusy.value = true
  try {
    await api.renameTask(id.value, wanted)
    renaming.value = false
    await load()
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  } finally {
    renamingBusy.value = false
  }
}

function startDescribe(): void {
  descriptionDraft.value = detail.value?.task.description ?? ''
  describing.value = true
}

/**
 * Save the description, or stop editing if nothing changed.
 *
 * Unlike a name, '' is a value here — it is how you clear one — so the guard is
 * "did it change", not "is it empty".
 */
async function saveDescription(): Promise<void> {
  const wanted = descriptionDraft.value.trim()
  if (wanted === (detail.value?.task.description ?? '')) {
    describing.value = false
    return
  }
  describingBusy.value = true
  try {
    await api.describeTask(id.value, wanted)
    describing.value = false
    await load()
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  } finally {
    describingBusy.value = false
  }
}

async function savePlan(): Promise<void> {
  saving.value = true
  try {
    await api.assignWorkflows(id.value, [...plan.value])
    await load()
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : String(caught)
  } finally {
    saving.value = false
  }
}

const discardPlan = (): void => {
  plan.value = (detail.value?.task.workflows ?? []).map((entry) => ({ ...entry }))
}

async function remove(): Promise<void> {
  await api.deleteTask(id.value)
  await router.push('/tasks')
}

onMounted(() => {
  void load()
  connection = live(() => {
    if (pending !== undefined) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = undefined
      void load()
    }, 120)
  })
})
onUnmounted(() => {
  if (pending !== undefined) clearTimeout(pending)
  connection?.close()
})
watch(id, () => {
  openRun.value = undefined
  openStep.value = undefined
  void load()
})

const stepTone: Record<string, string> = {
  completed: 'text-[var(--color-ok)]',
  running: 'text-[var(--color-info)]',
  failed: 'text-[var(--color-danger)]',
  'timed-out': 'text-[var(--color-warn)]',
  skipped: 'text-[var(--color-ink-faint)]',
}
</script>

<template>
  <PageHeader
    :title="detail?.task.name ?? 'Task'"
    :subtitle="detail?.task.ticketId ?? undefined"
  >
    <template #title>
      <!-- The name is edited where it is read. A separate field further down
           the page would show it twice and make you look for it. -->
      <input
        v-if="renaming"
        v-model="nameDraft"
        data-testid="task-name-input"
        class="w-full max-w-xl rounded-md border border-[var(--color-accent)] bg-[var(--color-base)] px-2 py-1 text-xl font-medium focus:outline-none"
        :disabled="renamingBusy"
        autofocus
        @keydown.enter.prevent="saveName"
        @keydown.esc.prevent="renaming = false"
        @blur="saveName"
      />
      <button
        v-else-if="editable"
        type="button"
        data-testid="rename-task"
        class="rounded-md px-1 text-left hover:bg-white/[0.04]"
        title="Rename"
        @click="startRename"
      >
        {{ detail?.task.name ?? 'Task' }}
      </button>
      <template v-else>{{ detail?.task.name ?? 'Task' }}</template>
    </template>

    <!-- The brief, edited where it is read, exactly like the name above it.
         It is also a token, so this box is the one place the wording that
         reaches an agent's prompt gets written. -->
    <template #subtitle>
      <p
        v-if="detail?.task.ticketId"
        class="mb-1 text-sm text-[var(--color-ink-muted)]"
        data-testid="task-ticket"
      >
        {{ detail.task.ticketId }}
      </p>
      <textarea
        v-if="describing"
        v-model="descriptionDraft"
        data-testid="task-description-input"
        rows="3"
        placeholder="What is this task for?"
        class="w-full max-w-3xl resize-y rounded-md border border-[var(--color-accent)] bg-[var(--color-base)] px-2 py-1.5 text-sm focus:outline-none"
        :disabled="describingBusy"
        autofocus
        @keydown.esc.prevent="describing = false"
        @keydown.enter.meta.prevent="saveDescription"
        @blur="saveDescription"
      />
      <button
        v-else-if="editable"
        type="button"
        data-testid="describe-task"
        class="block max-w-3xl whitespace-pre-wrap rounded-md px-1 text-left text-sm hover:bg-white/[0.04]"
        :class="
          (detail?.task.description ?? '') === ''
            ? 'text-[var(--color-ink-faint)] italic'
            : 'text-[var(--color-ink-muted)]'
        "
        title="Describe this task"
        @click="startDescribe"
      >
        {{ detail?.task.description || 'What is this task for?' }}
      </button>
      <p
        v-else-if="(detail?.task.description ?? '') !== ''"
        data-testid="task-description"
        class="max-w-3xl whitespace-pre-wrap px-1 text-sm text-[var(--color-ink-muted)]"
      >
        {{ detail?.task.description }}
      </p>
    </template>
  </PageHeader>

  <div class="px-8 py-6">
    <p
      v-if="error"
      class="mb-4 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
      data-testid="error"
    >
      {{ error }}
    </p>

    <div v-if="detail" class="space-y-6">
      <!-- First, before the badges: where the work is happening is what
           somebody opening this page by hand came for, and the path never used
           to leave the daemon at all. -->
      <section
        v-if="detail.workspace"
        class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--color-line)] px-3 py-2"
        data-testid="task-workspace"
      >
        <span class="text-sm" aria-hidden="true">{{
          detail.workspace.inWorktree ? '🌱' : '📁'
        }}</span>
        <RouterLink
          :to="`/projects`"
          class="text-xs text-[var(--color-accent-text)] hover:underline"
          data-testid="workspace-project"
        >
          {{ detail.workspace.project.name }}
        </RouterLink>
        <!-- Said out loud, because it changes what the path means: a worktree
             is this task's alone, the repository is shared with every other
             task in the project. -->
        <span
          v-if="detail.workspace.inWorktree"
          class="rounded-md bg-[var(--color-ok)]/10 px-2 py-0.5 font-mono text-[10px] text-[var(--color-ok)]"
          data-testid="workspace-worktree"
        >
          worktree
        </span>
        <button
          type="button"
          class="min-w-0 flex-1 truncate rounded px-1 text-left font-mono text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          :title="detail.workspace.path"
          data-testid="workspace-path"
          @click="copy(detail.workspace.path)"
        >
          {{ detail.workspace.path }}
        </button>
        <span
          v-if="copied === detail.workspace.path"
          class="font-mono text-[10px] text-[var(--color-ink-faint)]"
          data-testid="workspace-copied"
        >
          copied
        </span>
        <!-- Every button here comes from a plugin, in the order the plugins
             asked for. Two of them used to be written into this file with
             their commands resolved by name in a route; being a registry is
             what made room for the third and for one that will not be ours. -->
        <button
          v-for="tool in detail.tools"
          :key="tool.id"
          type="button"
          class="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:text-[var(--color-ink-faint)] disabled:hover:text-[var(--color-ink-faint)]"
          :disabled="opening !== undefined || tool.unavailable !== undefined"
          :title="
            tool.unavailable ??
            (tool.runnable ? tool.command : `Copies: ${tool.command}`)
          "
          :data-testid="`tool-${tool.id}`"
          @click="runTool(tool)"
        >
          {{ tool.label }}
          <!-- The label stays the tool's own either way. Nothing installed here
               can perform it, so pressing it copies the line instead — said
               with a mark and in the tooltip rather than by rewriting the
               button into "Copy open terminal", which reads like a stutter. -->
          <span v-if="!tool.runnable" aria-label="copies the command">&#8203;⧉</span>
        </button>
        <span
          v-if="justCopied"
          class="font-mono text-[10px] text-[var(--color-ink-faint)]"
          data-testid="workspace-command-copied"
        >
          copied
        </span>
      </section>

      <section class="flex flex-wrap items-center gap-3">
        <TaskStateBadge :state="detail.task.state" />
        <span
          v-for="flag in detail.task.flags"
          :key="flag"
          class="rounded-md bg-[var(--color-ok)]/10 px-2 py-0.5 font-mono text-[11px] text-[var(--color-ok)]"
          :data-testid="`flag-${flag}`"
        >
          {{ flag }}
        </span>
        <div class="ml-auto flex items-center gap-2">
          <TaskActions :actions="detail.actions" :busy="busy" @act="act" />
          <button
            type="button"
            data-testid="delete-task"
            class="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-danger)]"
            @click="remove"
          >
            Delete
          </button>
        </div>
      </section>

      <section data-testid="task-plan">
        <div class="mb-2 flex items-baseline gap-3">
          <h2 class="font-mono text-[10px] tracking-wider text-[var(--color-ink-faint)] uppercase">
            Workflows
          </h2>
          <!-- On the page someone actually watches a task from, which is the one
               place progress was never served. -->
          <span
            v-if="detail.progress"
            class="flex items-center gap-2"
            data-testid="task-progress"
          >
            <span class="h-1 w-20 overflow-hidden rounded-full bg-white/10">
              <span
                class="block h-full bg-[var(--color-accent)]"
                :style="{ width: `${percent}%` }"
              />
            </span>
            <span class="font-mono text-[10px] text-[var(--color-ink-muted)]">
              {{ detail.progress.completed }}/{{ detail.progress.total }} phases · {{ percent }}%
            </span>
          </span>
        </div>
        <WorkflowPicker
          v-model="plan"
          :available="available"
          :editable="editable"
          :tickable="tickable"
          :project="detail?.task.projectId"
        />

        <p
          v-if="!editable"
          class="mt-2 text-xs text-[var(--color-ink-faint)]"
          data-testid="plan-locked"
        >
          The task is {{ detail.task.state.replace('_', ' ') }}, so its workflows cannot be
          reordered — but you can still untick one that has not started.
        </p>

        <!-- Everything has run, so there is nothing to queue until something is
             ticked. Offered as one button because re-ticking five boxes to run
             a pipeline again is a chore, and refused-by-default is what stops
             it happening by accident. -->
        <button
          v-if="nothingTicked && !dirty"
          type="button"
          class="mt-3 rounded-md border border-[var(--color-line)] px-3 py-1.5 text-sm text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
          data-testid="tick-all"
          @click="tickEverything"
        >
          Tick them all to run again
        </button>

        <div v-if="dirty" class="mt-3 flex items-center gap-3">
          <button
            type="button"
            data-testid="save-workflows"
            class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            :disabled="saving"
            @click="savePlan"
          >
            Save workflows
          </button>
          <button
            type="button"
            data-testid="discard-workflows"
            class="text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            @click="discardPlan"
          >
            Discard
          </button>
        </div>
      </section>

      <!-- Beside the plan, which is the other "what will happen" control: the
           plan says what this task will do, this says when it may start.

           Not gated on having a project: the store lets two tasks that belong
           to no project wait for each other — they are equally unowned — and a
           control the daemon would accept has to be here, or the rule has two
           different answers depending on where you ask. -->
      <section data-testid="task-dependencies">
        <h2 class="mb-2 font-mono text-[10px] tracking-wider text-[var(--color-ink-faint)] uppercase">
          Waits for
        </h2>

        <ul v-if="waitsFor.length > 0" class="mb-2 space-y-1" data-testid="blockers">
          <li
            v-for="blocker in waitsFor"
            :key="blocker.id"
            class="flex items-center gap-2 text-sm"
            :data-testid="`blocker-${blocker.name}`"
          >
            <RouterLink :to="`/tasks/${blocker.id}`" class="hover:text-[var(--color-accent-text)]">
              {{ blocker.name }}
            </RouterLink>
            <!-- The verdict, not the blocker's state: what matters here is
                 whether this task can ever start, and "done" and "archived
                 after finishing" are the same answer. -->
            <span
              class="font-mono text-[10px] tracking-wide"
              :class="{
                'text-[var(--color-ink-faint)]': blocker.status === 'met',
                'text-[var(--color-warn)]': blocker.status === 'waiting',
                'text-[var(--color-danger)]': blocker.status === 'dead',
              }"
              :data-testid="`blocker-${blocker.name}-status`"
            >
              {{
                blocker.status === 'met'
                  ? 'done'
                  : blocker.status === 'waiting'
                    ? 'not yet'
                    : 'never will be'
              }}
            </span>
            <button
              type="button"
              :disabled="blocking"
              class="ml-auto text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-danger)] disabled:opacity-40"
              :data-testid="`unblock-${blocker.name}`"
              @click="independ(blocker.id)"
            >
              Remove
            </button>
          </li>
        </ul>
        <p v-else class="mb-2 text-sm text-[var(--color-ink-muted)]" data-testid="waits-for-nothing">
          Nothing. It can start as soon as it is queued.
        </p>

        <div v-if="candidates.length > 0" class="flex items-center gap-2">
          <select
            v-model="addBlocker"
            class="rounded-md border border-[var(--color-line)] bg-[var(--color-raised)] px-2 py-1.5 text-sm"
            data-testid="blocker-choice"
          >
            <option value="">Choose a task…</option>
            <option v-for="other in candidates" :key="other.id" :value="other.id">
              {{ other.name }}
            </option>
          </select>
          <button
            type="button"
            :disabled="addBlocker === '' || blocking"
            class="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-sm text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-40"
            data-testid="add-blocker"
            @click="dependOn()"
          >
            Wait for it
          </button>
        </div>

        <p
          v-if="dependencyError"
          class="mt-2 text-xs text-[var(--color-danger)]"
          data-testid="dependency-error"
        >
          {{ dependencyError }}
        </p>
      </section>

      <p
        v-if="detail.task.blockedReason"
        class="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-sm text-[var(--color-danger)]"
        data-testid="blocked-reason"
      >
        {{ detail.task.blockedReason }}
      </p>

      <!-- Between the plan and the runs, because that is the order the page
           reads in: what this task will do, what it produced, then the
           machinery that produced it. An artifact belongs to the task and
           outlives any one run of it, so it does not belong down among them —
           and somebody looking for "what did the analysis say" should not have
           to scroll past a run list and guess which one to open. -->
      <section v-if="detail.artifacts.length > 0" data-testid="artifacts">
        <h2 class="mb-2 font-mono text-[10px] tracking-wider text-[var(--color-ink-faint)] uppercase">
          Artifacts
        </h2>
        <RouterLink
          v-for="item in detail.artifacts"
          :key="item.name"
          :to="`/tasks/${id}/artifacts/${encodeURIComponent(item.name)}`"
          class="mb-1.5 flex items-center gap-3 rounded-lg border border-[var(--color-line)] px-3 py-2 hover:border-[var(--color-line-strong)]"
          :data-testid="`artifact-${item.name}`"
        >
          <span class="value flex-1 text-[var(--color-accent-text)]">{{ item.name }}</span>
          <span class="font-mono text-[10px] text-[var(--color-ink-faint)]">{{ item.phase }}</span>
          <span
            v-if="item.missing"
            class="rounded-md bg-[var(--color-warn)]/10 px-2 py-0.5 font-mono text-[10px] text-[var(--color-warn)]"
          >
            never produced
          </span>
          <template v-else>
            <span
              v-if="item.runs > 1"
              class="font-mono text-[10px] text-[var(--color-ink-faint)]"
              :data-testid="`artifact-${item.name}-runs`"
            >
              {{ item.runs }} versions
            </span>
            <span class="font-mono text-[10px] text-[var(--color-ink-muted)]">
              {{ Math.round(item.bytes / 1024) }} KB
            </span>
          </template>
        </RouterLink>
      </section>

      <section>
        <h2 class="mb-2 font-mono text-[10px] tracking-wider text-[var(--color-ink-faint)] uppercase">
          Runs
        </h2>
        <p v-if="detail.runs.length === 0" class="text-sm text-[var(--color-ink-muted)]" data-testid="no-runs">
          Nothing has run yet.
        </p>
        <div v-else class="flex flex-wrap gap-1.5" data-testid="runs">
          <button
            v-for="run in detail.runs"
            :key="run.id"
            type="button"
            :data-testid="`run-${run.workflow}-${run.attempt}`"
            class="rounded-md border px-2.5 py-1 text-xs"
            :class="
              openRun === run.id
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                : 'border-[var(--color-line-strong)] text-[var(--color-ink-muted)]'
            "
            @click="openTheRun(run.id)"
          >
            <span class="font-mono">{{ run.workflow }}</span>
            <span class="ml-1.5 text-[var(--color-ink-faint)]">#{{ run.attempt }}</span>
            <span class="ml-1.5">{{ run.state }}</span>
            <!-- What authority it had. Recorded per run, so a run that happened
                 under Full Access still says so after the project moved on. -->
            <span
              v-if="run.profile === 'full-access'"
              class="ml-1.5 font-mono text-[10px] tracking-wider text-[var(--color-warn)] uppercase"
              :data-testid="`run-profile-${run.workflow}-${run.attempt}`"
            >
              full access
            </span>
          </button>
        </div>

        <!-- The run's own last word, which the page has never shown. It is
             where the reason for a pause lives — including "the agent was
             refused this path" — and the alternative was reading the log. -->
        <p
          v-if="openedRun?.detail"
          class="mt-2 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-4 py-3 text-xs leading-relaxed text-[var(--color-ink)]"
          data-testid="run-detail"
        >
          {{ openedRun.detail }}
        </p>
      </section>

      <section v-if="openRun">
        <h2 class="mb-2 font-mono text-[10px] tracking-wider text-[var(--color-ink-faint)] uppercase">
          Steps
        </h2>
        <ul class="divide-y divide-[var(--color-line)]/60 rounded-lg border border-[var(--color-line)]">
          <li v-for="step in steps" :key="step.id" class="px-3 py-2">
            <button
              type="button"
              class="flex w-full items-center gap-3 text-left"
              :data-testid="`step-${step.describe}`"
              @click="showLog(step.id)"
            >
              <span class="font-mono text-[10px] text-[var(--color-ink-faint)]">{{ step.phase }}</span>
              <span class="text-xs">{{ step.describe }}</span>
              <span
                v-if="step.attempts > 1"
                class="font-mono text-[10px] text-[var(--color-warn)]"
                :data-testid="`attempts-${step.describe}`"
              >
                {{ step.attempts }} attempts
              </span>
              <span class="ml-auto font-mono text-[10px]" :class="stepTone[step.state]">
                {{ step.state }}<template v-if="step.exitCode !== undefined && step.exitCode !== 0">
                  · exit {{ step.exitCode }}</template>
              </span>
            </button>

            <div v-if="openStep === step.id && log" class="mt-2" :data-testid="`log-${step.describe}`">
              <pre
                class="max-h-72 overflow-auto rounded-md bg-[var(--color-base)] p-3 font-mono text-[11px] whitespace-pre-wrap text-[var(--color-ink-muted)]"
              ><template v-for="(line, index) in log.lines" :key="index"><span :class="line.stream === 'stderr' ? 'text-[var(--color-warn)]' : ''">{{ line.text }}</span></template></pre>
              <p
                v-if="log.dropped > 0"
                class="mt-1 text-[11px] text-[var(--color-warn)]"
                data-testid="log-dropped"
              >
                {{ log.dropped }} bytes were dropped from the middle to stay inside the log budget.
              </p>
              <p v-if="log.lines.length === 0" class="text-[11px] text-[var(--color-ink-faint)]">
                This step printed nothing.
              </p>
            </div>
          </li>
        </ul>
      </section>

      <!-- Evidence above history: it is why someone opens a run they did not
           watch, and an approval gate is decided on it. -->
      <section v-if="evidence.length > 0" data-testid="evidence">
        <h2 class="mb-2 font-mono text-[10px] tracking-wider text-[var(--color-ink-faint)] uppercase">
          Evidence
        </h2>
        <div
          v-for="item in evidence"
          :key="item.id"
          class="mb-2 rounded-lg border border-[var(--color-line)]"
          :data-testid="`evidence-${item.name}`"
        >
          <header class="flex items-center gap-2 px-3 py-2">
            <span class="font-mono text-[11px]">{{ item.name }}</span>
            <span class="font-mono text-[10px] text-[var(--color-ink-faint)]">{{ item.phase }}</span>
            <!-- Was inert truncated text. The path is the one thing in this
                 header that names something you might want to open, so it is
                 the link to the readable version. -->
            <RouterLink
              :to="`/tasks/${id}/artifacts/${encodeURIComponent(item.name)}`"
              class="truncate font-mono text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-accent-text)] hover:underline"
              :title="`Read ${item.name}`"
              :data-testid="`evidence-${item.name}-open`"
            >
              {{ item.path }}
            </RouterLink>
            <span
              v-if="item.missing"
              class="ml-auto rounded-md bg-[var(--color-warn)]/10 px-2 py-0.5 font-mono text-[10px] text-[var(--color-warn)]"
            >
              never produced
            </span>
          </header>
          <pre
            v-if="item.content"
            class="max-h-72 overflow-auto border-t border-[var(--color-line)] p-3 font-mono text-[11px] whitespace-pre-wrap text-[var(--color-ink-muted)]"
          >{{ item.content }}</pre>
          <p v-if="item.truncated" class="px-3 pb-2 text-[11px] text-[var(--color-warn)]">
            Showing the first part; the file on disk is {{ item.bytes }} bytes.
          </p>
        </div>
      </section>

      <section>
        <h2 class="mb-2 font-mono text-[10px] tracking-wider text-[var(--color-ink-faint)] uppercase">
          History
        </h2>
        <ol class="space-y-1" data-testid="history">
          <li
            v-for="(entry, index) in detail.history"
            :key="index"
            class="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]"
          >
            <span class="font-mono text-[10px] text-[var(--color-ink-faint)]">{{ entry.at }}</span>
            <span class="font-mono">{{ entry.action }}</span>
            <span class="text-[var(--color-ink-faint)]">{{ entry.from }} → {{ entry.to }}</span>
            <span v-if="entry.detail">· {{ entry.detail }}</span>
          </li>
          <li v-if="detail.history.length === 0" class="text-xs text-[var(--color-ink-faint)]">
            Nothing has happened to this task yet.
          </li>
        </ol>
      </section>

      <RouterLink to="/tasks" class="inline-block text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">
        ← All tasks
      </RouterLink>
    </div>
  </div>
</template>
