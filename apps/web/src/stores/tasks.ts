import { defineStore } from 'pinia'
import { useSettings } from './settings.js'
import { computed, reactive, ref } from 'vue'
import {
  ApiError,
  api,
  type NewTask,
  type Project,
  type TaskListItem,
  type TaskState,
  type WorkflowChoice,
} from '../api/client.js'
import { live, type LiveConnection } from '../api/live.js'
import { useProjects } from './projects.js'

/** What a whole-project action did, in the words the board shows. */
export interface BatchReport {
  readonly action: 'queued' | 'stopped'
  readonly count: number
  /** Tasks the daemon left alone, and why each one. */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[]
}

/**
 * The board's state.
 *
 * One store rather than per-page fetching, because the board, the filters and
 * the live stream are three views of the same list — and because a task acted
 * on from the detail page has to be right on the board when you go back.
 *
 * Updates are a reload, not a patch. The daemon is on loopback and the list is
 * small; an incrementally patched client is how a board ends up disagreeing
 * with the database about what state something is in.
 */
export const useTasks = defineStore('tasks', () => {
  const chosen = useProjects()
  const items = ref<TaskListItem[]>([])
  const projects = ref<Project[]>([])
  const loading = ref(false)
  const error = ref<string | undefined>(undefined)
  const acting = ref<string | undefined>(undefined)
  /** A whole-project action in flight. Separate from `acting`, which is an id. */
  const batching = ref(false)
  /**
   * What the last whole-project action did.
   *
   * Kept because a batch can legitimately do **nothing** — every draft in the
   * project may have an empty plan — and a button that answers silence is a
   * button that looks broken. The daemon says which tasks it left and why; this
   * is where that answer is held so the board can draw it.
   */
  const batch = ref<BatchReport | undefined>(undefined)

  const filters = reactive({
    query: '',
    state: 'all' as TaskState | 'all',
    workflow: 'all' as string,
    includeArchived: false,
  })
  const view = ref<'list' | 'board'>('list')

  let connection: LiveConnection | undefined
  let pending: ReturnType<typeof setTimeout> | undefined

  async function load(): Promise<void> {
    loading.value = true
    error.value = undefined
    try {
      const [result, known] = await Promise.all([
        api.tasks({ includeArchived: filters.includeArchived }),
        api.projects(),
      ])
      items.value = result.items
      projects.value = known.items
    } catch (caught) {
      error.value = caught instanceof ApiError ? caught.message : String(caught)
    } finally {
      loading.value = false
    }
  }

  /**
   * Follow the daemon.
   *
   * Coalesced: a single run emits a step event per step, and reloading the list
   * for each one would be a request per line of output.
   */
  function connect(): void {
    if (connection !== undefined) return
    connection = live(() => {
      if (pending !== undefined) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = undefined
        void load()
      }, 120)
    })
  }

  function disconnect(): void {
    if (pending !== undefined) clearTimeout(pending)
    pending = undefined
    connection?.close()
    connection = undefined
  }

  async function act(id: string, action: string): Promise<void> {
    acting.value = id
    error.value = undefined
    try {
      await api.actOnTask(id, action)
      await load()
    } catch (caught) {
      // The board queues tasks too, so it needs the same answer the task page
      // gives: a refusal for want of an acceptance becomes the panel, not a red
      // message. One decision, in the settings store, two callers.
      if (
        useSettings().handledRefusal(caught, async () => {
          await api.actOnTask(id, action)
          await load()
        })
      ) {
        return
      }
      error.value = caught instanceof ApiError ? caught.message : String(caught)
    } finally {
      acting.value = undefined
    }
  }

  /**
   * Queue everything in the chosen project, in dependency order.
   *
   * One request, not one per task: this store holds one `error` and one
   * `acting` id, so a loop here would have nowhere to put a partial refusal —
   * and the disclaimer would be answered ten times over.
   *
   * Nothing happens with "All" chosen. The graph belongs to a project, and
   * queueing every task in every repository from one button is not something
   * anybody means.
   */
  async function queueProject(): Promise<void> {
    const projectId = chosen.projectId
    if (projectId === undefined) return
    batching.value = true
    error.value = undefined
    batch.value = undefined
    // Named so the retry after an acceptance is the same call, not a copy of it.
    const queue = async (): Promise<void> => {
      const result = await api.queueProject(projectId)
      batch.value = {
        action: 'queued',
        count: result.queued.length,
        skipped: result.skipped.map((entry) => ({ name: entry.task.name, reason: entry.reason })),
      }
      await load()
    }
    try {
      await queue()
    } catch (caught) {
      // The same answer a single queue gives, for the same reason: a refusal
      // for want of an acceptance is the panel, not a red line.
      if (useSettings().handledRefusal(caught, queue)) return
      error.value = caught instanceof ApiError ? caught.message : String(caught)
    } finally {
      batching.value = false
    }
  }

  /** Stop everything in flight in the chosen project. Never gated. */
  async function stopProject(): Promise<void> {
    const projectId = chosen.projectId
    if (projectId === undefined) return
    batching.value = true
    error.value = undefined
    batch.value = undefined
    try {
      const result = await api.stopProject(projectId)
      batch.value = { action: 'stopped', count: result.cancelled.length, skipped: [] }
      await load()
    } catch (caught) {
      error.value = caught instanceof ApiError ? caught.message : String(caught)
    } finally {
      batching.value = false
    }
  }

  async function create(input: NewTask): Promise<string | undefined> {
    error.value = undefined
    try {
      const result = await api.createTask(input)
      await load()
      return result.task.id
    } catch (caught) {
      error.value = caught instanceof ApiError ? caught.message : String(caught)
      return undefined
    }
  }

  /**
   * Replace a task's workflows.
   *
   * Here rather than a bare `api` call at the call site, so the board reloads
   * and errors surface the same way every other action's do.
   */
  async function assign(id: string, workflows: WorkflowChoice[]): Promise<boolean> {
    error.value = undefined
    try {
      await api.assignWorkflows(id, workflows)
      await load()
      return true
    } catch (caught) {
      error.value = caught instanceof ApiError ? caught.message : String(caught)
      return false
    }
  }

  /**
   * The workflow a task will run next: the first one still ticked.
   *
   * Nothing, once they are all done. Falling back to the first was never
   * honest — a finished task is not "on" its first workflow.
   */
  const currentWorkflow = (task: TaskListItem): string | undefined =>
    task.workflows.find((entry) => entry.enabled)?.workflow

  /**
   * What to put in the Workflow column, whatever state the task is in.
   *
   * Every finished row drew an em dash, because the current workflow is the
   * *next* one and a finished task has none — so the column read as missing
   * data on exactly the rows where the answer is most obvious. A task with
   * nothing left to run shows the last one it ran instead, and only a task
   * with no workflows at all has nothing to say.
   */
  const workflowLabel = (task: TaskListItem): string | undefined =>
    currentWorkflow(task) ?? task.workflows.at(-1)?.workflow

  /**
   * The tasks the board is about.
   *
   * The project is not one of the filter controls: it is chosen in the rail and
   * applies to every page, so it narrows the board before they do rather than
   * sitting alongside them.
   */
  const inProject = computed(() =>
    chosen.projectId === undefined
      ? items.value
      : items.value.filter((task) => task.projectId === chosen.projectId),
  )

  const visible = computed(() =>
    inProject.value.filter((task) => {
      if (filters.state !== 'all' && task.state !== filters.state) return false
      if (
        filters.workflow !== 'all' &&
        !task.workflows.some((entry) => entry.workflow === filters.workflow)
      ) {
        return false
      }
      const query = filters.query.trim().toLowerCase()
      if (query === '') return true
      return (
        task.name.toLowerCase().includes(query) ||
        (task.ticketId ?? '').toLowerCase().includes(query)
      )
    }),
  )

  // The cards deliberately ignore the search box and the status dropdown — they
  // are what you check those against — but not the project, which is not a
  // filter so much as which board you are looking at.
  const countOf = (state: TaskState) =>
    inProject.value.filter((task) => task.state === state).length

  const summary = computed(() => ({
    total: inProject.value.length,
    running: countOf('running'),
    waiting: countOf('awaiting_approval'),
    blocked: countOf('blocked'),
    done: countOf('done'),
  }))

  const workflows = computed(() =>
    [
      ...new Set(inProject.value.flatMap((task) => task.workflows.map((e) => e.workflow))),
    ].sort(),
  )

  const projectName = (task: TaskListItem): string | undefined =>
    projects.value.find((project) => project.id === task.projectId)?.name

  return {
    items,
    projects,
    projectName,
    loading,
    error,
    acting,
    batching,
    batch,
    filters,
    view,
    inProject,
    visible,
    summary,
    workflows,
    currentWorkflow,
    workflowLabel,
    load,
    connect,
    disconnect,
    act,
    assign,
    create,
    queueProject,
    stopProject,
    dismissBatch: () => {
      batch.value = undefined
    },
  }
})
