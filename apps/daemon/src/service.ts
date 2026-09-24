import {
  Engine,
  Scheduler,
  assessReliability,
  reconcile,
  runningInstallationPlugin,
  stalenessOf,
  type FailureContext,
  type ProjectFacts,
  type ReconcileReport,
  type WorkflowFacts,
} from '@factory/engine'
import { definitionPath, namesIn, planWorkflow, resolveWorkflow } from '@factory/config'
import {
  DEFAULT_RELIABILITY_POLICY,
  RELIABILITY_EVALUATOR_KIND,
  attentionSummary,
  capsFor,
  type ReliabilityDriver,
  type ReliabilityEvaluatorCapability,
  type ReliabilitySummary,
  artifactsRoot,
  resolveProfile,
  systemCanonical,
  systemGitQuery,
  taskTokenValues,
  workspaceFor,
} from '@factory/core'
import type { FAILURE_TOKENS, PROJECT_TOKENS } from '@factory/core'
import { createChains, type Chains } from './chains.js'
import {
  MIGRATIONS,
  ProjectRepository,
  ReliabilityRepository,
  RunRepository,
  TaskRepository,
  openStore,
  storePath,
  type Store,
} from '@factory/store'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutionProfile, Project, Task, TaskWorkspace } from '@factory/core'
import type { Runtime } from '@factory/runtime'
import { agentFor } from './reliability-agent.js'

/**
 * The running half of a Factory installation.
 *
 * The runtime assembles what is *installed* — scopes, host, plugins — and the
 * CLI is happy with that alone. This adds what is *happening*: the database,
 * the repositories, the engine and the scheduler. It lives in the daemon
 * because only a long-lived process should hold them; a CLI invocation that
 * opened the database to print a list would be competing with the process that
 * is writing to it.
 */
export interface Service {
  readonly store: Store
  readonly tasks: TaskRepository
  readonly runs: RunRepository
  readonly projects: ProjectRepository
  readonly reliability: ReliabilityRepository
  /**
   * What a task's reliability is right now, assembled from the history.
   *
   * On the service rather than in a route because two surfaces need it — the
   * task detail payload and the reliability routes — and two assemblies of the
   * same question is how they come to disagree.
   */
  readonly reliabilitySummary: (taskId: string) => ReliabilitySummary
  /** The workflows a project can run, so a recommendation can name a real one. */
  readonly workflowNames: (projectId?: string) => readonly string[]
  /** Which definitions each project can see. Served by the definition routes. */
  readonly chains: Chains
  /**
   * Where this task's steps run — its worktree, or its project's checkout.
   *
   * Undefined only when the project the task names is not in the database —
   * which the foreign key makes impossible through Factory, so it means a
   * database edited by hand. Read paths tolerate it so the board can still
   * draw the task and say what is wrong; anything that would *run* refuses.
   *
   * The rule is core's; what the Service adds is the repository, the
   * filesystem and the path join, so a route can ask the question without
   * assembling it again.
   */
  readonly workspace: (task: Task) => TaskWorkspace | undefined
  readonly engine: Engine
  readonly scheduler: Scheduler
  /** What the boot found left over from last time. Reported by `/api/health`. */
  readonly reconciliation: ReconcileReport
  close(): Promise<void>
}

export type { TaskWorkspace }

export interface ServiceOptions {
  /** Database file. Defaults to the writable scope's `state/factory.db`. */
  readonly file?: string
  readonly maxParallel?: number
  /**
   * Whether the scheduler reacts to events on its own. Off in tests that are
   * about the API rather than about work actually running.
   */
  readonly autoStart?: boolean
}

export async function createService(
  runtime: Runtime,
  options: ServiceOptions = {},
): Promise<Service> {
  const store = openStore({
    file: options.file ?? storePath(writableRoot(runtime)),
    migrations: MIGRATIONS,
  })

  const tasks = new TaskRepository({ db: store.db, events: runtime.events })
  const runs = new RunRepository({ db: store.db, events: runtime.events })
  const projects = new ProjectRepository({ db: store.db, events: runtime.events })
  const reliability = new ReliabilityRepository({ db: store.db, events: runtime.events })

  // Definitions are resolved from the project's own directory, not the one the
  // daemon was started in. Everything that reads or writes a workflow goes
  // through this, so the board, the planner and the scheduler cannot disagree
  // about what a name means.
  const chains = createChains({
    chain: runtime.chain,
    env: runtime.env,
    pathOf: (id) => projects.get(id)?.path,
    events: runtime.events,
  })

  /**
   * Where a task's steps run, and what it is.
   *
   * The rule itself lives in core, beside `taskDirectory` and
   * `defaultWorktreesRoot`, so the diagnostic that reports a missing worktree
   * and the engine that would run in one cannot disagree. What lives here is
   * the plumbing core must not have: which repository holds the project, which
   * filesystem to look on, and how to join a path.
   *
   * Served on the Service so a route needs none of that either. The task
   * detail draws the directory it resolves, and a third copy of these four
   * lines is exactly what moving the rule into core was for.
   */
  const workspace = (task: Task): TaskWorkspace | undefined => {
    const project = projects.get(task.projectId)
    return project === undefined ? undefined : { ...workspaceFor(task, project, existsSync, join), project }
  }

  /**
   * The project a task happens in, or an error naming what is missing.
   *
   * Every path that starts work goes through here. It used to fall back to the
   * directory the daemon was started in, which meant a task whose project
   * could not be resolved ran an agent against whatever repository that
   * happened to be — the doctor's own setup rule calls that "fine for a
   * demonstration and wrong for work". There is nothing left to fall back for:
   * a task names a project, and the database will not let go of one that still
   * has tasks. A row that is not there is corruption, and saying so is better
   * than running somewhere nobody chose.
   */
  const projectOf = (task: Task): Project => {
    const project = projects.get(task.projectId)
    if (project === undefined) {
      throw new Error(
        `Task "${task.name}" belongs to project ${task.projectId}, which is not in the database.`,
      )
    }
    return project
  }

  /** The same answer as a path the engine can be handed. */
  const workspacePathFor = (task: Task): string =>
    workspaceFor(task, projectOf(task), existsSync, join).path

  /**
   * Where this task's artifacts go.
   *
   * Under the project, deliberately — not under the workspace, which is
   * the worktree when the project uses them. A worktree is deleted when the work
   * in it ends, and an artifact that goes with it is one nobody can read
   * afterwards.
   */
  const artifactsFor = (task: Task): string =>
    artifactsRoot(projectOf(task).path, task.directory ?? 'local', join)

  /**
   * How much authority this task's run gets.
   *
   * Read per plan rather than cached: a person can change a project's profile
   * between runs, and the next run should use what the board currently says.
   */
  const profileFor = (task: Task): ExecutionProfile => {
    const project = projectOf(task)
    return resolveProfile({
      project: project.profile,
      installation: runtime.settings.current().security.profile,
    })
  }

  /** Directories this task's project has granted beyond its workspace. */
  const grantsFor = (task: Task): readonly string[] => projectOf(task).grantedDirectories ?? []

  const engine = new Engine({
    tasks,
    runs,
    events: runtime.events,
    // The daemon's own environment, handed to the engine and filtered by the
    // runner according to each plan's profile. `runtime.env` already reaches
    // availability probes, task tools and plugin registration; the runner was
    // the one thing still reading `process.env` for itself.
    env: runtime.env,
    plan: ({ workflow, task, failure, session }) =>
      planWorkflow({
        chain: chains.for(task.projectId) ?? runtime.chain,
        host: runtime.host,
        workflow,
        workspace: workspacePathFor(task),
        // The daemon has a filesystem, so the boundary check gets the answer
        // that includes symlinks rather than the lexical one core falls back to.
        canonical: systemCanonical,
        // Where the profile stops being a setting and starts being flags. One
        // resolution, one order — the project's choice, then the installation's,
        // then `default` — and `resolveProfile` is where that order is written.
        profile: profileFor(task),
        // What the project has granted beyond its workspace, standing.
        allowedDirectories: grantsFor(task),
        // Forwarded, not decided here: the engine owns the session's lifecycle
        // because it is the only thing that sees both the task's recorded one
        // and the run about to start.
        ...(session === undefined ? {} : { session }),
        // Every documented token, every time — including the empty ones, so
        // `{{ task.ticketId }}` on a task with no ticket is blank rather than
        // a warning about a key the dictionary says exists.
        task: taskTokenValues(task, artifactsFor(task)),
        artifacts: artifactsFor(task),
        // Everything a template can say about the surroundings: where the
        // repository is, what branch work starts from, where worktrees go — and,
        // for a recovery workflow, what went wrong.
        project: {
          ...projectVariables(projectOf(task)),
          ...(failure === undefined ? {} : failureVariables(failure)),
        },
      }),
    // Judged after every run that reaches a verdict. The engine assembles the
    // facts — it is the only thing that sees the plan, the outcomes, the
    // refusals and the artifacts together — and this supplies everything that
    // needs a database or a host: the repository, the evaluators, and the
    // workflows this project actually has so a recommendation can name a real
    // one.
    //
    // Evaluators come off the host rather than a list here, which is what lets
    // a plugin add one. The deterministic evaluator is a built-in and arrives
    // the same way.
    assess: async ({ taskId, facts }) => {
      const task = tasks.get(taskId)
      if (task === undefined) return []
      const project = task.projectId === undefined ? undefined : projects.get(task.projectId)
      const evaluators = runtime.host
        .list<ReliabilityEvaluatorCapability>(RELIABILITY_EVALUATOR_KIND)
        .map((entry) => entry.capability)
      const outcome = await assessReliability({
        taskId,
        task: { name: task.name, description: task.description },
        reliability,
        evaluators,
        policy: DEFAULT_RELIABILITY_POLICY,
        trigger: 'run',
        // The project's own check command, added here because the engine has a
        // run and a plan and no idea which project they belong to. A step
        // running exactly this command and exiting zero *is* the project's
        // checks passing — the one expectation Factory can satisfy without
        // being told. It was declared on `RunFacts` and never supplied, so the
        // credit existed only where a test passed it in by hand.
        facts: {
          ...facts,
          ...(project?.check === undefined ? {} : { checkCommand: project.check }),
        },
        workflows: workflowNamesFor(task.projectId),
        // Absent unless this project chose a model and a CLI is installed to
        // run it. That is the whole of the cost control: the free evaluator
        // always runs, and the one that spends money runs when somebody said so.
        ...(() => {
          const agent = agentFor({
            runtime,
            project,
            profile: profileFor(task),
            cwd: project?.path,
          })
          return agent === undefined ? {} : { agent }
        })(),
      })
      return outcome.problems
    },
  })

  // Before anything is allowed to start: rows that say "running" from a process
  // that no longer exists have to be corrected first, or the scheduler counts
  // slots that are not in use and the board shows work nobody is doing.
  const reconciliation = reconcile({ tasks, runs })

  // One answer to "what does this workflow say about being scheduled", shared
  // by the scheduler and by the doctor rule that explains why nothing started.
  /**
   * The workflows a project can actually run.
   *
   * Handed to the evaluators so a recommendation names one that exists — a
   * suggestion to run something the project does not have is worse than no
   * suggestion, because the board draws a button behind it.
   */
  const workflowNamesFor = (projectId?: string): readonly string[] => {
    const chain = chains.for(projectId) ?? runtime.chain
    // `namesIn` per scope rather than `listDefinitions`, which wants a parser:
    // this needs the names, not the definitions, and parsing every workflow to
    // answer "does this one exist" would be work nobody asked for.
    return [...new Set(chain.scopes.flatMap((scope) => namesIn(scope, 'workflow')))]
  }

  /**
   * What a task's reliability is right now.
   *
   * Assembled rather than stored — the newest assessment plus the drivers still
   * active — and assembled *here*, so the task detail payload and the
   * reliability routes cannot describe the same task differently. A stored
   * column would be a third answer.
   */
  const reliabilitySummary = (taskId: string): ReliabilitySummary => {
    const newest = reliability.newest(taskId)
    const drivers = reliability.drivers(taskId)
    const caps = (list: readonly ReliabilityDriver[]) =>
      capsFor(list, DEFAULT_RELIABILITY_POLICY, [], [])
    const attention = attentionSummary(drivers, newest?.score ?? 0, caps)
    if (newest === undefined) return { taskId, state: 'unassessed', attention }

    // Finished runs oldest first, which is the order staleness compares in.
    const finished = [...runs.forTask(taskId)]
      .reverse()
      .filter((run) => run.state !== 'running')
      .map((run) => run.id)
    const stale = stalenessOf(newest, finished)

    return {
      taskId,
      state: stale === undefined ? 'assessed' : 'stale',
      score: newest.score,
      rawScore: newest.rawScore,
      coverage: newest.coverage,
      delta: newest.delta,
      dimensions: newest.dimensions,
      caps: newest.caps,
      assessedAt: newest.createdAt,
      assessmentId: newest.id,
      ...(stale === undefined ? {} : { staleReason: stale }),
      attention,
    }
  }

  const workflow = (name: string, projectId?: string): WorkflowFacts | undefined => {
    const chain = chains.for(projectId) ?? runtime.chain
    const found = resolveWorkflow(chain, name)
    if (found?.value === undefined) return undefined
    const project = chain.scopes.find((scope) => scope.kind === 'project')
    return {
      scheduling: found.value.scheduling,
      requires: found.value.conditions?.requires ?? [],
      provides: found.value.conditions?.provides ?? [],
      needs: found.value.needs,
      // Where it came from, and — when it asks to be overridden — where the
      // project's own copy would go, so a warning can name a path rather than
      // leaving someone to work out the filename.
      scope: found.ref.scope,
      ...(found.value.override === undefined ? {} : { override: found.value.override }),
      ...(found.value.override === undefined || project === undefined
        ? {}
        : { overridePath: definitionPath(project, 'workflow', name) }),
    }
  }

  /**
   * What a project says about how much of its work can happen at once.
   *
   * The scheduler takes a lookup rather than the repository, the same way it
   * takes one for workflows: it decides, it does not fetch.
   */
  const project = (id: string): ProjectFacts | undefined => {
    const found = projects.get(id)
    return found === undefined
      ? undefined
      : { name: found.name, usesWorktrees: found.usesWorktrees }
  }

  const scheduler = new Scheduler({
    tasks,
    runs,
    events: runtime.events,
    ...(options.maxParallel === undefined ? {} : { maxParallel: options.maxParallel }),
    start: (taskId) => engine.run(taskId),
    workflow,
    project,
    // Somewhere for a failure to go when the task it belonged to has already
    // settled. Recorded as a startup problem rather than thrown: the daemon
    // keeps serving, and `GET /api/doctor` is where somebody looks.
    onError: (error) => {
      runtime.recordProblem({
        severity: 'error',
        message: error.message,
        rule: 'engine.workFailedAfterSettling',
      })
    },
  })

  // Doctor learns about tasks and runs by the same route a plugin would: it
  // registers rules. A process without a database registers none, and doctor
  // still answers about the installation.
  //
  // Through the runtime's own loader, not `host.load` directly: that is the one
  // gate the switches are applied at, and it is also what records the plugin in
  // the catalogue. Loading here would put a plugin in the host that the plugins
  // page cannot see, and a page that omits a loaded plugin is a page that lies.
  await runtime.load(
    runningInstallationPlugin({
      tasks,
      runs,
      projects,
      reconciliation,
      workflow,
      // The one rule that cannot answer its own question: only git knows what
      // git ignores. Built from the daemon's environment rather than read from
      // the process, like every other thing here that reaches outside.
      git: systemGitQuery(runtime.env),
    }),
  )

  const stopWatching = options.autoStart === false ? () => {} : scheduler.watch()
  // Always watching, even with the scheduler off: cancelling is not scheduling,
  // and a task cancelled in a test installation should still have its processes
  // stopped. The engine only acts on a transition to `cancelled`.
  const stopWatchingCancels = engine.watch()
  if (options.autoStart !== false) scheduler.tick()

  return {
    store,
    tasks,
    runs,
    projects,
    reliability,
    reliabilitySummary,
    workflowNames: workflowNamesFor,
    chains,
    workspace,
    engine,
    scheduler,
    reconciliation,
    close: async () => {
      stopWatching()
      stopWatchingCancels()
      // Before settling, not after. `scheduler.settle()` waits for in-flight
      // runs, and a step may have half an hour of deadline left — while
      // `bin.ts` gives the whole shutdown three seconds before it exits the
      // process. So a tidy shutdown used to lose that race every time and leave
      // whatever was running orphaned, with its output going nowhere.
      //
      // Stopping first makes settling quick: the steps exit, the runs record
      // themselves as cancelled, and the store closes on a consistent picture
      // rather than on rows that say "running" for a process that is gone.
      await engine.stopAll('Factory was shut down.')
      await scheduler.settle()
      store.close()
    },
  }
}

/**
 * What a recovery workflow is told about the failure that called it.
 *
 * Exposed as `{{ project.* }}` because that scope already exists and is meant
 * for facts about the surroundings rather than about the definition. The prototype
 * spelled these `{{ requirement.lastFailureReason }}`; the names are the same
 * ideas under the vocabulary this project settled on.
 */
/**
 * What a step can say about the project it is running in.
 *
 * Typed by `PROJECT_TOKENS` rather than `Record<string, string>`, so the
 * dictionary the builder shows and the values a run actually gets are the same
 * list. Adding a variable here without documenting it does not compile.
 */
const projectVariables = (
  project: Project,
): Partial<Record<keyof typeof PROJECT_TOKENS, string>> => ({
  name: project.name,
  path: project.path,
  branch: project.defaultBranch,
  worktrees: project.worktreesRoot,
  // Empty when the project has never been given one, which is what makes the
  // built-in `project-check` phase refuse to plan rather than run nothing.
  check: project.check ?? '',
})

const failureVariables = (
  failure: FailureContext,
): Record<keyof typeof FAILURE_TOKENS, string> => ({
  failedWorkflow: failure.workflow,
  failedPhase: failure.phase ?? '',
  failureReason: failure.reason,
})

/** The database belongs beside the definitions it is about. */
function writableRoot(runtime: Runtime): string {
  const writable =
    runtime.chain.scopes.find(
      (scope) => scope.writable && scope.kind === runtime.chain.defaultWriteScope,
    ) ?? runtime.chain.scopes.find((scope) => scope.writable)
  if (writable === undefined) {
    throw new Error('No writable scope: Factory has nowhere to keep its state.')
  }
  return writable.root
}
