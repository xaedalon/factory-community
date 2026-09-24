/**
 * The one place the browser talks to the daemon.
 *
 * The prototype had thirty-four bare `fetch` calls scattered across its
 * components, each with its own copy-pasted error handling — so an API change
 * meant finding all of them, and an error surfaced differently depending on
 * which component made the call.
 */

export interface Problem {
  severity: 'error' | 'warning'
  message: string
  file?: string
  at?: { line: number; column: number }
  field?: string
  path?: (string | number)[]
  rule?: string
}

export interface DefinitionRef {
  kind: DefinitionKind
  name: string
  scope: ScopeKind
  file: string
}

export type ScopeKind = 'project' | 'user' | 'builtin'

/**
 * Mirrors `DefinitionKind` in @factory/config.
 *
 * The browser cannot import from the daemon's packages, so this is a second
 * declaration of the same union — as it already was, spelled out inline at
 * eight call sites. One named type at least makes the duplication visible.
 */
export type DefinitionKind = 'workflow' | 'phase' | 'agent'

/** What turning a project setting on copied into the repository. */
/** Whether adding a project had to create its `.xaedalon/.factory` directory. */
export interface ScopeReport {
  created: boolean
  root: string
}

export interface ScaffoldReport {
  written: string[]
  kept: string[]
  missing: string[]
  error?: string
}

export interface DefinitionListing {
  name: string
  winner: DefinitionRef
  shadowed: DefinitionRef[]
  valid: boolean
  problems: Problem[]
  /**
   * Set on a workflow this project can never run, and why.
   *
   * A workflow whose conditions deal in `hasWorktree` is unusable where the
   * project does not use worktrees: nothing provides the flag, so it would
   * either wait for ever or build something the project has said it does not
   * want. Present on the listing rather than filtered out of it, so the
   * library can still show the file while the task picker declines to offer it.
   */
  unavailable?: { flag: string; setting: string }
  /**
   * Workflows that must come before this one. Immediate predecessors only.
   *
   * Absent when it needs nothing, so the picker's check is a presence test
   * rather than a length test on something that might not be there.
   */
  needs?: string[]
}

export interface Scope {
  kind: ScopeKind
  root: string
  writable: boolean
  exists: boolean
}

export interface ScopesResponse {
  scopes: Scope[]
  defaultWriteScope: ScopeKind
  gitRoot?: string
  startupProblems: Problem[]
}

export interface CapabilityEntry {
  id: string
  displayName?: string
  summary?: string
  plugin: string
}

export interface StepKindEntry {
  id: string
  summary: string
  runnable: boolean
  sugarKey?: string
  /** JSON Schema for the step's fields, when the kind can describe itself. */
  fields?: JsonSchema
  plugin: string
}

/** The subset of JSON Schema the builder renders controls for. */
export interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: string[]
  description?: string
  minLength?: number
  /**
   * Names a catalogue the builder fills at render time.
   *
   * Some sets are closed and belong in the schema as an `enum`; others depend
   * on what is installed or defined — the providers on this machine, the agents
   * in this project's scopes — and cannot be written down in advance. A kind
   * declares the *name* of the set and the builder supplies its contents, so a
   * plugin's step kind gets a real dropdown without the UI being taught about
   * it.
   */
  'x-options'?: string
  /**
   * Names another field that answers for this one.
   *
   * When that field has a value, this one is not asked for — a step naming an
   * agent needs only a prompt. It stays valid in the file, so a deliberate
   * override still works and is still shown.
   */
  'x-supersededBy'?: string
}

export interface Definition {
  name: string
  [key: string]: unknown
}

export interface FetchedDefinition {
  ref: DefinitionRef
  definition: Definition
  raw: string
  etag: string
  shadows: DefinitionRef[]
  problems: Problem[]
}

export type ImportAction = 'create' | 'overwrite' | 'skip' | 'conflict'
export type ConflictPolicy = 'fail' | 'skip' | 'overwrite'

export interface ImportItem {
  kind: DefinitionKind
  name: string
  targetName: string
  action: ImportAction
  targetPath: string
  conflicts: boolean
  /** Scope whose copy this would hide once written. */
  shadows?: ScopeKind
}

export interface ImportPlan {
  entry: string
  items: ImportItem[]
  problems: Problem[]
}

export interface ImportResult {
  plan: ImportPlan
  written: string[]
  problems: Problem[]
}

export interface ProviderEntry {
  id: string
  displayName: string
  supports: string[]
  models: Record<string, string>
  /** Values this provider's effort flag accepts. Empty when it has none. */
  effortValues: string[]
  provisional: boolean
  available: boolean
}

export type TaskState =
  | 'draft'
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'blocked'
  | 'done'
  | 'cancelled'
  | 'archived'

export interface AvailableAction {
  action: string
  label: string
  to: TaskState
}

export interface TokenEntry {
  key: string
  summary: string
}

/**
 * A `{{ namespace.key }}` family, as the daemon describes it.
 *
 * `source: 'definition'` means the keys are whatever the workflow or phase
 * being edited declared, so the daemon sends none and the editor fills them in
 * from what it is holding.
 */
export interface TokenNamespace {
  namespace: string
  summary: string
  source: 'factory' | 'definition'
  tokens: TokenEntry[]
}

/**
 * One workflow in a task's list, and what has happened to it.
 *
 * `enabled` is what the tickbox writes; `ran` is derived by the daemon and is
 * why an entry cannot be taken off the list. The two differ on purpose: an
 * entry you untick yourself and one the engine has finished with both end up
 * unticked, and only `ran` tells them apart.
 */
/**
 * A workflow in a list being edited.
 *
 * `id` is absent on one just added — the daemon mints it — and present on one
 * that came back from the server, which is how a reorder keeps what an entry
 * knows instead of matching on a position that just moved.
 */
export interface WorkflowChoice {
  id?: string
  workflow: string
  enabled: boolean
  ran?: boolean
}

export interface TaskWorkflowEntry {
  id: string
  workflow: string
  enabled: boolean
  ran: boolean
}

export interface Task {
  id: string
  name: string
  /** Always present — '' when nobody has written one. */
  description: string
  /** The project the work happens in. Every task has one. */
  projectId: string
  ticketId?: string
  branch?: string
  directory?: string
  state: TaskState
  workflows: TaskWorkflowEntry[]
  flags: string[]
  queuePosition?: number
  runnableAt?: string
  blockedReason?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  /**
   * Ids of the tasks this one waits for.
   *
   * Ids, because that is what the graph is keyed by and what a client sends
   * back when it edits it. `blockers` beside it carries the names and the
   * verdict to draw.
   */
  dependsOn: string[]
}

/** What this task waits for, resolved by the daemon for display. */
export interface TaskBlocker {
  id: string
  name: string
  /** `waiting` will come, `dead` never will, `met` already has. */
  status: 'met' | 'waiting' | 'dead'
}

export interface TaskListItem extends Task {
  actions: AvailableAction[]
  progress?: { completed: number; total: number }
  blockers: TaskBlocker[]
}

export interface TaskHistoryEntry {
  at: string
  action: string
  from: TaskState
  to: TaskState
  detail?: string
}

export type RunState =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'timed-out'
  | 'declined'
  | 'cancelled'
  | 'refused'

export interface Run {
  id: string
  taskId?: string
  workflow: string
  state: RunState
  attempt: number
  workflowIndex: number
  resumePhase?: number
  startedAt: string
  finishedAt?: string
  detail?: string
  /** How much authority it was given. Absent for a run from before profiles. */
  profile?: ExecutionProfile
}

export interface RunStep {
  id: number
  runId: string
  phase: string
  index: number
  describe: string
  uses: string
  /** What it actually ran. Absent for a step that ran no process. */
  command?: string
  state: 'running' | 'completed' | 'failed' | 'timed-out' | 'skipped'
  /** More than one means the step was retried. */
  attempts: number
  exitCode?: number
  startedAt: string
  finishedAt?: string
  detail?: string
}

export interface Evidence {
  id: number
  runId: string
  /** The phase the step was in. For display; the name is the identity. */
  phase: string
  /** What the step called it — `analysis` for `analysis.md`. */
  name: string
  path: string
  content?: string
  bytes: number
  truncated: boolean
  missing: boolean
  collectedAt: string
}

export interface LogView {
  lines: { at: string; stream: 'stdout' | 'stderr'; text: string }[]
  /** Bytes kept out to stay inside the budget. Shown, never hidden. */
  dropped: number
}

/** One artifact a task produced, as the list carries it — no content. */
export interface TaskArtifact {
  name: string
  phase: string
  path: string
  bytes: number
  truncated: boolean
  missing: boolean
  collectedAt: string
  /** How many runs produced it. More than one means there are earlier versions. */
  runs: number
}

export interface ArtifactVersion {
  runId: string
  collectedAt: string
  bytes: number
  truncated: boolean
  missing: boolean
  content?: string
}

export interface ArtifactDetail {
  name: string
  phase: string
  path: string
  /** Newest first, so `versions[0]` is the current one. */
  versions: ArtifactVersion[]
}

/**
 * Where a task's work is, and how to get into it.
 *
 * Resolved by the daemon, not joined here: the worktree if the task has one on
 * disk, else the project's own checkout. The ingredients used to be served on
 * two different routes and no client put them together.
 */
/** How much authority a run gets. The daemon's own vocabulary. */
export type ExecutionProfile = 'default' | 'full-access'

/**
 * Light, dark, or the OS's own preference.
 *
 * Declared here rather than imported from `@factory/config`, for the same
 * reason `ExecutionProfile` is: the board talks HTTP, and this is the shape
 * the daemon sends.
 */
export type UiTheme = 'light' | 'dark' | 'system'

/**
 * What a person is shown before Factory runs an agent for them.
 *
 * Declared here rather than imported from core: the board talks HTTP, and this
 * is the shape the daemon sends. The wording itself is core's, served with the
 * settings, so there is one text and the board cannot drift from what somebody
 * actually agreed to.
 */
export interface Disclaimer {
  version: number
  title: string
  summary: string
  points: string[]
  caveat: string
}

/** What the person using Factory has chosen. Served by the daemon. */
export interface FactorySettings {
  ui: { scale: number; theme: UiTheme }
  plugins: { disabled: string[] }
  security: { acceptedVersion?: number; profile: ExecutionProfile }
}

/** One plugin Factory knows about, whether or not it is loaded. */
export interface PluginEntry {
  /** How settings name it: a built-in's name, or a declared specifier. */
  id: string
  name?: string
  version?: string
  source: 'builtin' | 'scope' | 'unknown'
  scope?: string
  specifier?: string
  /** Without it nothing parses or runs, so it has no switch. */
  essential: boolean
  enabled: boolean
  loaded: boolean
  error?: string
  /** Switched off but still in this process. The host has no unload. */
  restartRequired: boolean
  provides: { kind: string; id: string; summary?: string }[]
}

/** One button a plugin offers on a task. */
export interface TaskTool {
  id: string
  label: string
  summary?: string
  /** Which plugin provided it, so the row can say where a button came from. */
  plugin: string
  run: 'terminal' | 'detached'
  /** Whether anything installed here can perform it. */
  runnable: boolean
  /** Why it cannot be used — drawn disabled with this as its reason. */
  unavailable?: string
  /** The line to run there, built by the daemon so quoting is never ours. */
  command: string
}

export interface TaskWorkspace {
  /** Absolute. Where steps actually run. */
  path: string
  /** True when `path` is the task's own worktree rather than the repository. */
  inWorktree: boolean
  project: { id: string; name: string; path: string }
}

export interface TaskDetail {
  task: Task
  actions: AvailableAction[]
  history: TaskHistoryEntry[]
  runs: Run[]
  /** Phases carried out over phases planned. Absent when there is no plan yet. */
  progress?: { completed: number; total: number }
  blockers: TaskBlocker[]
  artifacts: TaskArtifact[]
  /**
   * Absent only when the task's project is missing from the database, which
   * takes a hand-edited one: every task has a project.
   */
  workspace?: TaskWorkspace
  /**
   * The buttons this task offers, in the order the plugins asked for.
   *
   * Beside `actions`, not inside `workspace`: a tool that needs no directory
   * — a ticket system, say — would be unreachable nested inside one.
   */
  tools: TaskTool[]
}

export interface SetupAction {
  label: string
  command?: string
  config?: string
  url?: string
}

export interface SetupItem {
  id: string
  title: string
  summary: string
  done: boolean
  detail?: string
  actions?: SetupAction[]
  /** Factory cannot run work until this is done. */
  essential?: boolean
}

export interface SetupReport {
  items: SetupItem[]
  ready: boolean
  remaining: number
}

export interface Project {
  id: string
  name: string
  path: string
  defaultBranch: string
  worktreesRoot: string
  isRepository: boolean
  /** False when work happens in the repository itself, one task at a time. */
  usesWorktrees: boolean
  /** Whether each task gets an environment of its own. Off unless asked for. */
  usesEnvironments: boolean
  /**
   * The hue this project's square uses, 1 to 6, when it has chosen one.
   *
   * Absent means derived from the name — see `identity.ts`, which is still the
   * default and still the argument. Read through `markTone`, never directly,
   * so a chosen square and a derived one look the same at the call site.
   */
  tone?: number
  /** The letters on the square, when chosen. Absent means derived. */
  initials?: string
  /**
   * How much authority its runs get. Absent means it follows the installation.
   *
   * Absent is not the same as `default`: a project that has never chosen
   * follows the installation's setting, so changing that setting changes it.
   */
  profile?: ExecutionProfile
  /**
   * The command that says whether this project's work is sound.
   *
   * Absent means nobody has said. The built-in `project-check` phase then
   * refuses to plan rather than running an empty command and reporting
   * success, which is the whole reason this is a field and not a convention.
   */
  check?: string
  /** Directories its agents may reach beyond the workspace, granted for good. */
  grantedDirectories: string[]
  createdAt: string
  /** How many tasks are pointed at it. */
  tasks: number
}

export interface NewTask {
  name: string
  description?: string
  ticketId?: string
  branch?: string
  /** Required: it decides where the work happens. */
  projectId: string
  workflows?: string[]
}

/** An error carrying whatever the daemon said, so a page can render specifics. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems: Problem[] = [],
    readonly body: unknown = undefined,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const UNREACHABLE = 'Cannot reach the Factory daemon. Is `factory-daemon` running?'

/**
 * Gateway statuses mean the daemon is down, not that the request was wrong.
 *
 * In development the browser talks to Vite, which proxies to the daemon and
 * answers 502 when nothing is listening — so "daemon not running" arrives as a
 * *successful* fetch with a bad status, and only looks like a network error in
 * production where the daemon serves the app itself. Both have to produce the
 * same message, because they are the same problem.
 */
const GATEWAY = new Set([502, 503, 504])

const isImportResult = (body: unknown): body is ImportResult =>
  typeof body === 'object' && body !== null && 'plan' in body && 'problems' in body

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      // Only declare a JSON body when there is one. A bodyless DELETE carrying
      // `content-type: application/json` is rejected by the server as an empty
      // JSON document — a 400 that looks like the request was wrong rather than
      // the header being spurious.
      headers: {
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    // A bare "Failed to fetch" tells nobody what to do about it.
    throw new ApiError(0, UNREACHABLE)
  }

  if (GATEWAY.has(response.status)) throw new ApiError(response.status, UNREACHABLE)

  // Not every error body is JSON — a proxy or a crash can answer with HTML, and
  // parsing it blindly would replace a useful status with a SyntaxError.
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }

  if (!response.ok) {
    const payload = (body ?? {}) as { error?: string; problems?: Problem[] }
    throw new ApiError(
      response.status,
      payload.error ?? `Request failed (${response.status})`,
      payload.problems ?? [],
      body,
    )
  }
  return body as T
}

/**
 * A query string, or nothing at all.
 *
 * Every definition call takes an optional project, because a name only means
 * something inside a scope chain and each project has its own. Omitting it asks
 * about the installation, which is what the pages that are about the
 * installation want.
 */
const query = (parts: Record<string, string | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(parts)) {
    if (value !== undefined) search.append(key, value)
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

export const api = {
  scopes: (project?: string) => request<ScopesResponse>(`/api/scopes${query({ project })}`),
  providers: () => request<{ items: ProviderEntry[] }>('/api/registries/providers'),
  stepKinds: () => request<{ items: StepKindEntry[] }>('/api/registries/step-kinds'),
  tokens: () => request<{ items: TokenNamespace[] }>('/api/registries/tokens'),

  /**
   * The list with whatever it needs filled in.
   *
   * Asked of the daemon rather than worked out here: the walk is core's, and a
   * copy in the browser would be a second answer to what a workflow needs.
   */
  resolveNeeds: (workflows: string[], project?: string) =>
    request<{ order: string[]; added: string[]; problems: Problem[] }>(
      `/api/workflows/resolve${query({ project })}`,
      { method: 'POST', body: JSON.stringify({ workflows }) },
    ),
  list: (kind: DefinitionKind, project?: string) =>
    request<{ items: DefinitionListing[] }>(`/api/${kind}s${query({ project })}`),
  doctor: () => request<{ problems: Problem[]; checked: Record<string, number> }>('/api/doctor'),

  get: (kind: DefinitionKind, name: string, project?: string) =>
    request<FetchedDefinition>(
      `/api/${kind}s/${encodeURIComponent(name)}${query({ project })}`,
    ),

  create: (
    kind: DefinitionKind,
    definition: Definition,
    scope: ScopeKind,
    project?: string,
  ) =>
    request<{ status: string; file: string; etag: string }>(`/api/${kind}s${query({ project })}`, {
      method: 'POST',
      body: JSON.stringify({ definition, scope }),
    }),

  update: (
    kind: DefinitionKind,
    definition: Definition,
    scope: ScopeKind,
    etag: string,
    project?: string,
  ) =>
    request<{ status: string; file: string; etag: string }>(
      `/api/${kind}s/${encodeURIComponent(definition.name)}${query({ project })}`,
      { method: 'PUT', body: JSON.stringify({ definition, scope, etag }) },
    ),

  exportWorkflow: (name: string, project?: string) =>
    request<{ text: string; problems: Problem[] }>(
      `/api/workflows/${encodeURIComponent(name)}/export${query({ project })}`,
      { method: 'POST' },
    ),

  /**
   * Plan or apply an import.
   *
   * The same call either way — `dryRun` only decides whether the writes happen.
   * A preview produced by a different code path is a preview that can be wrong
   * about what the real one will do.
   */
  importBundle: async (
    text: string,
    options: {
      scope: ScopeKind
      policy?: ConflictPolicy
      prefix?: string
      dryRun: boolean
      project?: string
    },
  ): Promise<ImportResult> => {
    const url = `/api/bundles/import${query({
      dryRun: String(options.dryRun),
      project: options.project,
    })}`
    try {
      return await request<ImportResult>(url, {
        method: 'POST',
        body: JSON.stringify({
          text,
          scope: options.scope,
          ...(options.policy === undefined ? {} : { policy: options.policy }),
          ...(options.prefix === undefined || options.prefix === ''
            ? {}
            : { prefix: options.prefix }),
        }),
      })
    } catch (caught) {
      // A 409 is a *result*, not a failure: the body carries the full plan,
      // with the clashing rows marked. Discarding it would leave the page able
      // to say only "that did not work" when it could show exactly what is in
      // the way and which option resolves it.
      if (caught instanceof ApiError && caught.status === 409 && isImportResult(caught.body)) {
        return caught.body
      }
      throw caught
    }
  },

  remove: (kind: DefinitionKind, name: string, scope: ScopeKind, project?: string) =>
    request<{ deleted: boolean; file: string; nowResolvesFrom?: DefinitionRef }>(
      `/api/${kind}s/${encodeURIComponent(name)}${query({ scope, project })}`,
      { method: 'DELETE' },
    ),

  /**
   * The canonical rendering, from the daemon.
   *
   * Deliberately not a second copy of the serializer running in the browser.
   * Two implementations of "what will be written" can disagree, and the one the
   * user is looking at would be the wrong one; a debounced call to the process
   * that actually writes the file cannot drift from it. On a loopback socket
   * the latency is not perceptible.
   */
  setup: () => request<SetupReport>('/api/setup'),

  projects: () => request<{ items: Project[] }>('/api/projects'),

  /**
   * Change a project. Everything editable goes through the one route.
   *
   * `name` and `defaultBranch` are here because the alternative was removing
   * the project and adding it again, which orphans every task that ever ran in
   * it. `path` is not editable by design — see the route.
   */
  setProjectSetting: (
    id: string,
    // `profile: null` clears it, which is how a project returns to following
    // the installation. Distinct from choosing `default`.
    setting: {
      name?: string
      defaultBranch?: string
      usesWorktrees?: boolean
      usesEnvironments?: boolean
      profile?: ExecutionProfile | null
      // `null` for either means derive it from the name, which is where a
      // project starts and what it returns to.
      tone?: number | null
      initials?: string | null
      // `null` clears the check command, which is a real answer: a project
      // whose gate should not run is better off saying so.
      check?: string | null
    },
  ) =>
    request<{ project: Project; scaffolded: ScaffoldReport }>(
      `/api/projects/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(setting) },
    ),

  addProject: (input: {
    name: string
    path: string
    defaultBranch?: string
    usesWorktrees?: boolean
    usesEnvironments?: boolean
    /** Omit entirely and the daemon detects it from the repository. */
    check?: string
  }) =>
    request<{ project: Project; scope: ScopeReport; scaffolded: ScaffoldReport }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  removeProject: (id: string) =>
    request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  tasks: (options: { includeArchived?: boolean } = {}) =>
    request<{ items: TaskListItem[] }>(
      `/api/tasks${options.includeArchived === true ? '?archived=true' : ''}`,
    ),

  task: (id: string) => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),

  createTask: (input: NewTask) =>
    request<{ task: Task; actions: AvailableAction[] }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  assignWorkflows: (id: string, workflows: WorkflowChoice[]) =>
    request<{ task: Task; actions: AvailableAction[] }>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ workflows }),
    }),

  renameTask: (id: string, name: string) =>
    request<{ task: Task; actions: AvailableAction[] }>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  /**
   * Queue every task in a project that can be queued, in dependency order.
   *
   * One request rather than one per task. `skipped` says which were left and
   * why — a draft with nothing ticked has nothing to run — and a 409 either
   * carries the disclaimer or names a ring.
   */
  queueProject: (id: string) =>
    request<{
      queued: Task[]
      skipped: { task: Task; reason: string }[]
    }>(`/api/projects/${encodeURIComponent(id)}/queue`, { method: 'POST' }),

  /** Cancel everything in flight or in line in a project, and kill its processes. */
  stopProject: (id: string) =>
    request<{ cancelled: Task[]; signalled: number; killed: number }>(
      `/api/projects/${encodeURIComponent(id)}/stop`,
      { method: 'POST' },
    ),

  /**
   * Make a task wait for another, or stop it waiting.
   *
   * One edge at a time rather than sending the whole list: a picker adds and
   * removes one at a time, and a whole-list write would let two people editing
   * the same task overwrite each other. A refusal comes back as a 400 carrying
   * the daemon's sentence, which is the store's sentence.
   */
  dependOn: (id: string, dependsOn: string) =>
    request<{ task: Task; actions: AvailableAction[]; blockers: TaskBlocker[] }>(
      `/api/tasks/${encodeURIComponent(id)}/dependencies`,
      { method: 'POST', body: JSON.stringify({ dependsOn }) },
    ),

  independ: (id: string, dependsOn: string) =>
    request<{ task: Task; actions: AvailableAction[]; blockers: TaskBlocker[] }>(
      `/api/tasks/${encodeURIComponent(id)}/dependencies/${encodeURIComponent(dependsOn)}`,
      { method: 'DELETE' },
    ),

  /**
   * Do what one of a task's tools offers.
   *
   * Sends a tool id and no path: the directory and the argv come from the tool,
   * which got them from the task. A 501 means nothing installed can perform it,
   * and its body carries the command to copy.
   */
  runTool: (taskId: string, tool: string) =>
    request<{ ran: 'terminal' | 'detached'; command: string }>(
      `/api/tasks/${encodeURIComponent(taskId)}/tools/${encodeURIComponent(tool)}`,
      { method: 'POST' },
    ),

  plugins: () => request<{ plugins: PluginEntry[] }>('/api/plugins'),

  setPluginEnabled: (id: string, enabled: boolean) =>
    request<{ plugin: PluginEntry; restartRequired: boolean }>(
      `/api/plugins/${encodeURIComponent(id)}`,
      { method: 'POST', body: JSON.stringify({ enabled }) },
    ),

  settings: () =>
    request<{
      settings: FactorySettings
      file?: string
      disclaimer: Disclaimer
      accepted: boolean
    }>('/api/settings'),

  saveSettings: (patch: {
    ui?: { scale?: number; theme?: UiTheme }
    security?: { profile?: ExecutionProfile }
  }) =>
    request<{ settings: FactorySettings; file?: string }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /**
   * Record that the disclaimer has been read.
   *
   * No body: the version recorded is the daemon's, so that a board showing an
   * older copy cannot accept on behalf of a newer one.
   */
  acceptDisclaimer: () =>
    request<{ settings: FactorySettings; accepted: boolean; version: number }>(
      '/api/settings/accept',
      { method: 'POST' },
    ),

  /** Stop every agent Factory started. */
  stopEverything: () =>
    request<{ stopped: string[]; signalled: number; killed: number }>('/api/runs/stop', {
      method: 'POST',
    }),

  artifact: (taskId: string, name: string) =>
    request<ArtifactDetail>(
      `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(name)}`,
    ),

  describeTask: (id: string, description: string) =>
    request<{ task: Task; actions: AvailableAction[] }>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ description }),
    }),

  /**
   * Ask for an action by name.
   *
   * The names come from the task's own `actions` list rather than from
   * anything hard-coded here: the state machine decides what is possible, and a
   * button the daemon did not offer is a button that will be refused.
   */
  actOnTask: (id: string, action: string, reason?: string) =>
    request<{ task: Task; actions: AvailableAction[] }>(
      `/api/tasks/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
      { method: 'POST', body: JSON.stringify(reason === undefined ? {} : { reason }) },
    ),

  deleteTask: (id: string) =>
    request<void>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  run: (id: string) =>
    request<{ run: Run; steps: RunStep[]; evidence: Evidence[] }>(
      `/api/runs/${encodeURIComponent(id)}`,
    ),

  runLogs: (id: string, stepId?: number) =>
    request<LogView>(
      `/api/runs/${encodeURIComponent(id)}/logs${stepId === undefined ? '' : `?step=${stepId}`}`,
    ),

  preview: (kind: DefinitionKind, definition: Definition) =>
    request<{ text: string }>('/api/definitions/preview', {
      method: 'POST',
      body: JSON.stringify({ kind, definition }),
    }),
}
