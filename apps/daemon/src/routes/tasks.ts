import type { FastifyInstance } from 'fastify'
import {
  DISCLAIMER,
  NOT_ACCEPTED,
  dependencyStatus,
  TASK_ACTIONS,
  TASK_STATES,
  TASK_TOOL_KIND,
  TERMINAL_KIND,
  hasAccepted,
  knownToolDirectories,
  requestFor,
  systemDetachedLauncher,
  taskToolOffers,
  type DependencyState,
  type Evidence,
  type Task,
  type TaskEdge,
  type TaskAction,
  type TaskState,
  type TaskToolCapability,
  type TaskToolOffer,
  type TaskToolView,
  type DetachedLauncher,
  type TerminalCapability,
  type TerminalOutcome,
} from '@factory/core'
import { resolveWorkflow } from '@factory/config'
import { WorkflowHasRunError, type Blocker, type WorkflowSelection } from '@factory/store'
import type { Service } from '../service.js'
import type { Runtime } from '@factory/runtime'

/**
 * Tasks, runs and their output over HTTP.
 *
 * Thin, like every other route here: the rules about what a task may do next
 * live in @factory/core and the writing-down lives in @factory/store, so a
 * client gets the same answers the CLI and the scheduler get. In particular
 * `actions` is served rather than derived — the board renders buttons from it,
 * and a client that decided for itself would drift from the machine the moment
 * either changed.
 */
export function registerTaskRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  service: Service,
  options: { launch?: DetachedLauncher } = {},
): void {
  // Injected the way Pro injects its terminal launcher, so a scenario can
  // assert what would have been started without starting it.
  const launch = options.launch ?? systemDetachedLauncher
  const { tasks, runs, chains } = service

  /**
   * Whether this installation has been told what an agent run can reach.
   *
   * Read fresh each time rather than captured, for the reason
   * `disabledPluginNames` gives: accepting it has to take effect without a
   * restart, and the holder is the one live copy.
   */
  const accepted = (): boolean => hasAccepted(runtime.settings.current().security.acceptedVersion)

  /**
   * Phases carried out over phases the plan contains.
   *
   * It used to be steps of the newest run, which was right when a task had one
   * workflow and has been wrong ever since it became a list of them: each
   * workflow is a fresh run, so the count never climbed past that run's own
   * steps however much of the task was done — `0/1` for a five-stage pipeline.
   * Worse, a plan-time refusal writes no step rows at all, so a task that had
   * finished one workflow and stumbled on the next reported nothing whatever.
   *
   * Phases, because that is what the interface reference counts in, and
   * show ("0/7 phases"), and because it is the only unit that moves smoothly:
   * workflows jump a fifth at a time and steps are inflated by retries.
   *
   * Absent when the plan has no phases to count — a task with no workflows, or
   * one whose only workflow no longer resolves. Zero-of-something is a fact
   * worth drawing; nothing-at-all is not a fraction.
   */
  const progressOf = (task: Task): { completed: number; total: number } | undefined => {
    // Memoised per call, not per request: resolving a workflow reads and parses
    // a file, and a board of twenty tasks sharing five workflows would
    // otherwise do it a hundred times for five answers. Per call also means
    // there is nothing to invalidate — someone editing a workflow in their
    // editor emits no event, so a longer-lived cache would go quietly stale.
    const phases = phaseNames(task.projectId)
    const carried = runs.completedPhases(task.id)
    const finished = new Set(
      runs.completedEntries(task.id).map((entry) => `${entry.entryId}\u0000${entry.workflow}`),
    )

    let completed = 0
    let total = 0
    for (const entry of task.workflows) {
      const names = phases(entry.workflow)
      total += names.size
      if (finished.has(`${entry.id}\u0000${entry.workflow}`)) {
        completed += names.size
        continue
      }
      // Intersected with the names the definition actually lists, so a phase a
      // run recorded under a name since removed from the workflow cannot push
      // the count past the total. Clamping the sum afterwards would hide that
      // rather than attribute it.
      completed += carried.filter(
        (row) => row.entryId === entry.id && names.has(row.phase),
      ).length
    }

    if (total === 0) return undefined
    return { completed, total }
  }

  /**
   * What a task waits for, resolved for display.
   *
   * Derived per request, the way progress is: the scheduler and this route both
   * call `dependencyStatus`, so there is one rule about what counts as done and
   * no column to go stale. The task itself carries the ids — lossless, and
   * still the thing a client sends back when it edits the graph — and this adds
   * the names and the verdict a person reads.
   *
   * `status` per blocker rather than one answer per task, because the two a
   * board draws differently sit side by side: what it is still waiting for, and
   * what it will now never get.
   */
  const dependencyView = (
    edges: readonly TaskEdge[],
  ): ((task: Task) => readonly { id: string; name: string; status: DependencyState }[]) => {
    // Memoised per request for the same reason `phaseNames` is: a board of
    // twenty tasks waiting on five usually asks about the same five.
    const seen = new Map<string, Blocker | undefined>()
    const blockerOf = (id: string): Blocker | undefined => {
      if (!seen.has(id)) seen.set(id, tasks.blocker(id))
      return seen.get(id)
    }
    return (task: Task) => {
      if (task.dependsOn.length === 0) return []
      const status = dependencyStatus(task.id, edges, blockerOf)
      const waiting = new Set(status.waitingFor)
      const dead = new Set(status.dead.map((entry) => entry.id))
      return task.dependsOn.map((id) => ({
        id,
        // A blocker nobody can find needs a hand-edited database to reach —
        // deleting a task takes its edges with it — but naming it by id beats
        // drawing an empty label.
        name: blockerOf(id)?.name ?? id,
        status: (waiting.has(id) ? 'waiting' : dead.has(id) ? 'dead' : 'met') as DependencyState,
      }))
    }
  }

  /**
   * The phase names of each workflow, for one project, remembered.
   *
   * A **set of names**, not a count: `run_steps` records a phase's name and
   * nothing else, so a workflow listing the same phase twice — which the schema
   * allows with only a warning — can never have it counted twice. Taking the
   * length instead would leave such a workflow reading two of three for ever.
   *
   * A workflow that does not resolve, or resolves to a file that does not
   * validate, contributes nothing: doctor already reports the name, and a
   * count that quietly shrinks is better than one claiming phases nobody can
   * find.
   */
  const phaseNames = (projectId?: string): ((workflow: string) => ReadonlySet<string>) => {
    // `chains.own` rather than nothing: `for()` returns undefined only for an
    // id naming no project, and the installation's own chain is the honest
    // answer there — the same fallback `service.ts` spells out.
    const chain = chains.for(projectId) ?? chains.own
    const seen = new Map<string, ReadonlySet<string>>()
    return (workflow: string): ReadonlySet<string> => {
      const remembered = seen.get(workflow)
      if (remembered !== undefined) return remembered
      const names = new Set(
        chain === undefined ? [] : (resolveWorkflow(chain, workflow)?.value?.phases ?? []),
      )
      seen.set(workflow, names)
      return names
    }
  }

  app.get<{ Querystring: { state?: string; archived?: string } }>(
    '/api/tasks',
    async (request, reply) => {
      const state = request.query.state
      if (state !== undefined && !isState(state)) {
        return reply.code(400).send({ error: `"${state}" is not a task state.` })
      }
      const items = tasks.list({
        ...(state === undefined ? {} : { state }),
        ...(request.query.archived === 'true' ? { includeArchived: true } : {}),
      })
      // One read for the whole board, not one per row.
      const blockers = dependencyView(tasks.dependencies())
      return {
        items: items.map((task) => ({
          ...task,
          actions: tasks.actions(task.id),
          // Computed here rather than in the browser, which would need a
          // request per row to do the same sum.
          progress: progressOf(task),
          blockers: blockers(task),
        })),
      }
    },
  )

  /**
   * One entry per artifact a task has produced, newest first.
   *
   * Without the content, deliberately: a task detail is refetched on every live
   * event behind a short debounce, and five artifacts of Markdown is tens of
   * kilobytes a time for a list that needs names and sizes. The content is one
   * request away, on the page that shows it.
   */
  const artifactsOf = (taskId: string) => {
    const byName = new Map<string, { runs: number; newest: ReturnType<typeof first> }>()
    for (const row of runs.artifactsForTask(taskId)) {
      const seen = byName.get(row.name)
      if (seen === undefined) byName.set(row.name, { runs: 1, newest: first(row) })
      else seen.runs += 1
    }
    return [...byName.values()].map((entry) => ({ ...entry.newest, runs: entry.runs }))
  }
  const first = (row: Evidence) => ({
    name: row.name,
    phase: row.phase,
    path: row.path,
    bytes: row.bytes,
    truncated: row.truncated,
    missing: row.missing,
    collectedAt: row.collectedAt,
  })

  /**
   * Where this task's work is, and how to get into it.
   *
   * The path was already computed on every run — it is what the engine spawns
   * steps in — and never left the daemon. The ingredients were served
   * separately (`task.directory` here, `project.worktreesRoot` on the projects
   * route) and no client joined them, so the one question people actually ask
   * about a running task had no answer on screen.
   *
   * Absent for a task with no project: there is no directory to show and
   * nothing to open. The daemon's own cwd is where such a task would *run*, but
   * offering to open it would be offering a directory nobody chose.
   */
  const workspaceOf = (task: Task) => {
    const workspace = service.workspace(task)
    if (workspace === undefined) return undefined
    return {
      path: workspace.path,
      inWorktree: workspace.inWorktree,
      project: {
        id: workspace.project.id,
        name: workspace.project.name,
        path: workspace.project.path,
      },
    }
  }

  /**
   * The buttons this task offers, and what each would do.
   *
   * Every one comes from a plugin — including the two that used to be written
   * into the board with their commands resolved by name right here. What is
   * left in the route is the part a plugin must not do: knowing which tools the
   * installation has switched off, and performing what they ask for.
   *
   * On the detail only, never the list. Resolving them asks every tool, and a
   * tool may go looking for a binary; a board of twenty rows would do that
   * twenty times over for answers no list view draws.
   */
  const toolsOf = (task: Task): Promise<readonly TaskToolView[]> => {
    const workspace = service.workspace(task)
    return taskToolOffers({
      context: {
        task,
        ...(workspace === undefined ? {} : { workspace }),
        host: runtime.host,
        env: runtime.env,
        // Assembled once per request and shared. Building it lists every
        // version manager's directory, which is not work to repeat per tool.
        extraDirectories: knownToolDirectories(runtime.env),
      },
      disabledPlugins: disabledPluginNames(),
    })
  }

  /**
   * Plugin names the installation has switched off.
   *
   * Names, because that is what the host knows a plugin by. Settings hold
   * *ids* — a built-in's name, or the specifier a declared plugin was written
   * as — so the catalogue translates, being the only thing that knows both.
   *
   * Read fresh from the one holder each time. A cached copy here would be the
   * second meaning of "disabled", and the two drift into "the button is gone
   * but the code still runs", or the reverse.
   */
  const disabledPluginNames = (): ReadonlySet<string> => {
    const disabled = new Set(runtime.settings.current().plugins.disabled)
    const names = new Set<string>()
    for (const candidate of runtime.plugins) {
      if (disabled.has(candidate.id)) names.add(candidate.name ?? candidate.id)
    }
    return names
  }

  /**
   * One artifact, with its content and every version of it.
   *
   * Read out of the evidence rows rather than off disk, which is the whole
   * reason evidence is copied into the database — and it means this route takes
   * a task and a name rather than a path, so there is no traversal to guard
   * against. The prototype's equivalent took `?path=` and read any file on the
   * machine.
   */
  app.get<{ Params: { id: string; name: string } }>(
    '/api/tasks/:id/artifacts/:name',
    async (request, reply) => {
      const task = tasks.get(request.params.id)
      if (task === undefined) return notFound(reply, request.params.id)
      const versions = runs
        .artifactsForTask(task.id)
        .filter((row) => row.name === request.params.name)
      if (versions.length === 0) {
        return reply.code(404).send({ error: `"${request.params.name}" is not one of its artifacts.` })
      }
      return {
        name: request.params.name,
        phase: versions[0]?.phase,
        path: versions[0]?.path,
        versions: versions.map((row) => ({
          runId: row.runId,
          collectedAt: row.collectedAt,
          bytes: row.bytes,
          truncated: row.truncated,
          missing: row.missing,
          ...(row.content === undefined ? {} : { content: row.content }),
        })),
      }
    },
  )

  app.post<{ Body: CreateBody }>('/api/tasks', async (request, reply) => {
    const body = request.body ?? {}
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return reply.code(400).send({ error: 'A task needs a name.' })
    }
    // A task decides nothing about where it runs; its project does. Refused
    // here rather than defaulted, because the default this used to have was
    // the directory the daemon happened to be started in.
    if (typeof body.projectId !== 'string' || body.projectId.trim() === '') {
      return reply
        .code(400)
        .send({ error: 'A task needs a project: it decides where the work happens.' })
    }
    if (service.projects.get(body.projectId) === undefined) {
      return reply.code(400).send({ error: `No project ${body.projectId}.` })
    }
    const task = tasks.create({
      name: body.name.trim(),
      projectId: body.projectId,
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.ticketId === undefined ? {} : { ticketId: body.ticketId }),
      ...(body.branch === undefined ? {} : { branch: body.branch }),
      ...(body.directory === undefined ? {} : { directory: body.directory }),
      ...(body.workflows === undefined ? {} : { workflows: body.workflows as WorkflowSelection[] }),
    })
    return reply.code(201).send({ task, actions: tasks.actions(task.id) })
  })

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const task = tasks.get(request.params.id)
    if (task === undefined) return notFound(reply, request.params.id)
    return {
      task,
      actions: tasks.actions(task.id),
      history: tasks.history(task.id),
      runs: runs.forTask(task.id),
      // The detail page never had this, so the page someone actually watches a
      // task on was the one place that could not say how far it had got.
      progress: progressOf(task),
      blockers: dependencyView(tasks.dependencies())(task),
      artifacts: artifactsOf(task.id),
      // Only on the detail: one string per task that no list view draws, and
      // resolving it reads the project row.
      workspace: workspaceOf(task),
      // Beside `actions`, not inside `workspace`: a workspace is absent for a
      // task with no project, and a tool that needs no directory — a ticket
      // system, say — would be unreachable nested in one.
      tools: await toolsOf(task),
    }
  })

  /**
   * Do what one of this task's tools offers.
   *
   * Takes a **tool id and no path**. The directory and the argv come from the
   * tool, which got them from the task — so nothing a client sends reaches a
   * process, and "repository path validation" has nothing to validate. The
   * claim is stronger than it was when this route took `{ session: true }`:
   * even the choice between two commands is now the server's.
   *
   * 501 rather than an error when nothing can perform it: that is a capability
   * being absent, not a fault, and the body carries the command so the board
   * can offer it to copy. Only `terminal` tools can take that branch —
   * `detached` ones the daemon starts itself, which is why Diffity works in
   * Community.
   */
  app.post<{ Params: { id: string; tool: string } }>(
    '/api/tasks/:id/tools/:tool',
    async (request, reply) => {
      const task = tasks.get(request.params.id)
      if (task === undefined) return notFound(reply, request.params.id)

      // Resolved the same way the page resolved them, through the same
      // function, so what was drawn and what runs cannot disagree — including
      // about a plugin switched off since the page loaded.
      const view = (await toolsOf(task)).find((tool) => tool.id === request.params.tool)
      if (view === undefined) {
        return reply
          .code(404)
          .send({ error: `No tool "${request.params.tool}" for this task.` })
      }
      // Refused rather than done anyway. The board draws it disabled with this
      // very reason, so a request for it came from a page that has gone stale.
      if (view.unavailable !== undefined) {
        return reply.code(409).send({ error: view.unavailable, command: view.command })
      }

      const offer = await offerOf(task, view.id)
      if (offer === undefined) {
        return reply
          .code(409)
          .send({ error: `"${view.label}" is no longer offered for this task.` })
      }
      const workspace = service.workspace(task)
      const wanted = requestFor(offer, workspace?.path ?? runtime.cwd)

      if (view.run === 'detached') {
        return report(reply, await launch(wanted), view)
      }

      // `list` rather than `get`: `get` returns nothing when several of a kind
      // are registered, and "two terminals installed" must not be reported as
      // "none installed". First registered wins, which is a rule somebody can
      // predict.
      const terminal = runtime.host.list<TerminalCapability>(TERMINAL_KIND)[0]?.capability
      if (terminal === undefined) {
        return reply.code(501).send({
          error: `Nothing installed here can open a terminal. Run this instead.`,
          command: view.command,
        })
      }
      return report(reply, await terminal.open(wanted), view)
    },
  )

  /** The offer behind a view, asked again so the route performs what it read. */
  const offerOf = async (task: Task, id: string): Promise<TaskToolOffer | undefined> => {
    const tool = runtime.host
      .list<TaskToolCapability>(TASK_TOOL_KIND)
      .find((entry) => entry.capability.id === id)
    if (tool === undefined) return undefined
    const workspace = service.workspace(task)
    return (
      (await tool.capability.offer({
        task,
        ...(workspace === undefined ? {} : { workspace }),
        host: runtime.host,
        env: runtime.env,
        extraDirectories: knownToolDirectories(runtime.env),
      })) ?? undefined
    )
  }

  /**
   * One way of reporting what happened, for both performers.
   *
   * Reported, not swallowed. The notifications capability is deliberately
   * silent when it cannot deliver; a button that appears to do nothing is a
   * different matter.
   */
  const report = (
    reply: { code: (n: number) => { send: (body: unknown) => unknown } },
    outcome: TerminalOutcome,
    view: TaskToolView,
  ) =>
    outcome.opened
      ? { ran: view.run, command: outcome.command }
      : reply.code(500).send({
          error: outcome.reason ?? `"${view.label}" could not be started, and said no more.`,
          command: outcome.command,
        })

  /**
   * Change a task: what it is called, what it will run, or both.
   *
   * Refused once the work is in flight, the same way an action it cannot take
   * is refused. For the workflow list the reason is the cursor: the engine
   * reads the list at the top of a run and counts through it, so editing
   * underneath means counting positions in a list that no longer exists. For
   * the name the reason is templates — `{{ task.name }}` is substituted into
   * every plan, so a rename mid-run would change what a later phase renders
   * and the run's own history would stop matching what it says it did.
   *
   * A task waiting for approval is in flight too: it is holding a paused run
   * partway through.
   */
  const IN_FLIGHT: readonly TaskState[] = ['running', 'awaiting_approval']

  app.patch<{
    Params: { id: string }
    Body: { name?: string; description?: string; workflows?: unknown }
  }>(
    '/api/tasks/:id',
    async (request, reply) => {
      const existing = tasks.get(request.params.id)
      if (existing === undefined) return notFound(reply, request.params.id)

      const body = request.body ?? {}
      const wantsName = body.name !== undefined
      const wantsDescription = body.description !== undefined
      const wantsWorkflows = body.workflows !== undefined
      if (!wantsName && !wantsDescription && !wantsWorkflows) {
        return reply
          .code(400)
          .send({ error: 'Send { name }, { description } or { workflows: [...] }.' })
      }
      if (wantsWorkflows && !isSelection(body.workflows)) {
        return reply
          .code(400)
          .send({ error: 'workflows must be a list of names, or of { workflow, id?, enabled? }.' })
      }
      if (wantsName && (typeof body.name !== 'string' || body.name.trim() === '')) {
        return reply.code(400).send({ error: 'A task needs a name.' })
      }
      // Empty is how a description is cleared, so '' is valid where a name's
      // would not be. Only the type is checked.
      if (wantsDescription && typeof body.description !== 'string') {
        return reply.code(400).send({ error: 'A description is text.' })
      }
      if (IN_FLIGHT.includes(existing.state)) {
        return reply.code(409).send({
          error: `Cannot change a task that is ${existing.state}.`,
          state: existing.state,
        })
      }

      // Name first, so the task that comes back carries both changes.
      if (wantsName) tasks.rename(request.params.id, body.name as string)
      if (wantsDescription) tasks.describe(request.params.id, body.description as string)
      let task = tasks.get(request.params.id) as typeof existing
      if (wantsWorkflows) {
        try {
          task = tasks.assign(request.params.id, body.workflows as WorkflowSelection[])
        } catch (error) {
          // A state conflict, like the in-flight refusal above — the request is
          // well formed, the task simply will not let go of a workflow it has
          // already run. The entries are named so a client can say which.
          if (error instanceof WorkflowHasRunError) {
            return reply.code(409).send({
              error: error.message,
              entries: error.entries.map((entry) => ({ id: entry.id, workflow: entry.workflow })),
            })
          }
          throw error
        }
      }
      return { task, actions: tasks.actions(task.id) }
    },
  )

  app.post<{ Params: { id: string; action: string }; Body: { reason?: string } }>(
    '/api/tasks/:id/actions/:action',
    async (request, reply) => {
      const task = tasks.get(request.params.id)
      if (task === undefined) return notFound(reply, request.params.id)

      const action = request.params.action
      if (!isAction(action)) {
        return reply.code(400).send({ error: `"${action}" is not an action.` })
      }
      // Internal moves belong to the engine and the scheduler. Letting a client
      // start a task by hand would put it past the concurrency cap, and the
      // cap is the only thing keeping a laptop usable.
      if (!tasks.actions(task.id).some((entry) => entry.action === action)) {
        return reply.code(409).send({
          error: `Cannot ${action} a task that is ${task.state}.`,
          state: task.state,
          actions: tasks.actions(task.id),
        })
      }

      // The one gate, and it is here rather than in the browser because the
      // browser is not the only client: the CLI and `curl` start runs too, and
      // a disclaimer only the web app enforces is advice rather than a gate.
      //
      // On `queue` and `retry` alone — the two actions that lead to an agent
      // running. Cancelling, archiving or approving something already under way
      // must never be blocked by this: that would trap a person who most needs
      // to stop what is happening.
      if ((action === 'queue' || action === 'retry') && !accepted()) {
        return reply.code(409).send({
          error: NOT_ACCEPTED,
          disclaimer: DISCLAIMER,
        })
      }

      const updated = tasks.act(task.id, action, {
        ...(request.body?.reason === undefined ? {} : { reason: request.body.reason }),
      })
      return { task: updated, actions: tasks.actions(updated.id) }
    },
  )

  /**
   * Make this task wait for another, or stop it waiting.
   *
   * Two routes rather than a whole-list PUT: a picker adds and removes one edge
   * at a time, and a PUT would make two people editing the same task's
   * dependencies silently overwrite each other.
   *
   * Every refusal the store makes — itself, a blocker in another project, a
   * ring — comes back as a 400 carrying the store's own sentence. Rewording it
   * here would mean two explanations of one rule, and the one nobody reads
   * would be the one in the interface.
   */
  app.post<{ Params: { id: string }; Body: { dependsOn?: string } }>(
    '/api/tasks/:id/dependencies',
    async (request, reply) => {
      const task = tasks.get(request.params.id)
      if (task === undefined) return notFound(reply, request.params.id)
      const blockerId = request.body?.dependsOn
      if (typeof blockerId !== 'string' || blockerId.trim() === '') {
        return reply.code(400).send({ error: 'Which task should it wait for?' })
      }
      try {
        const updated = tasks.dependOn(task.id, blockerId.trim())
        return {
          task: updated,
          actions: tasks.actions(updated.id),
          blockers: dependencyView(tasks.dependencies())(updated),
        }
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message })
      }
    },
  )

  app.delete<{ Params: { id: string; blockerId: string } }>(
    '/api/tasks/:id/dependencies/:blockerId',
    async (request, reply) => {
      const task = tasks.get(request.params.id)
      if (task === undefined) return notFound(reply, request.params.id)
      const updated = tasks.independ(task.id, request.params.blockerId)
      return {
        task: updated,
        actions: tasks.actions(updated.id),
        blockers: dependencyView(tasks.dependencies())(updated),
      }
    },
  )

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    if (!tasks.delete(request.params.id)) return notFound(reply, request.params.id)
    return reply.code(204).send()
  })

  /**
   * Stop every agent Factory started. The kill switch.
   *
   * A POST with no body and no target, because "stop everything" takes no
   * arguments and the moment somebody wants it is not the moment to make them
   * name things. The engine does the work — process trees first, then the task
   * transitions — so the API, the CLI and a desktop menu item cannot differ
   * about what it leaves behind.
   *
   * Never gated on the disclaimer. Refusing to *stop* work because nobody has
   * agreed to a notice would be the most hostile possible reading of a safety
   * feature.
   */
  app.post('/api/runs/stop', async () => {
    const before = service.engine.running()
    const report = await service.engine.stopAll('Stopped by request.')
    return { stopped: before, ...report }
  })

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = runs.get(request.params.id)
    if (run === undefined) {
      return reply.code(404).send({ error: `No run ${request.params.id}.` })
    }
    // Evidence with the run, not behind another request: it is the reason
    // someone opens a run they did not watch.
    return { run, steps: runs.steps(run.id), evidence: runs.evidence(run.id) }
  })

  app.get<{ Params: { id: string }; Querystring: { step?: string } }>(
    '/api/runs/:id/logs',
    async (request, reply) => {
      const run = runs.get(request.params.id)
      if (run === undefined) {
        return reply.code(404).send({ error: `No run ${request.params.id}.` })
      }
      const step = request.query.step
      // `dropped` travels with the lines: a log that quietly lost its middle
      // reads like a complete one, and the reader has to be told.
      return runs.logs(run.id, ...(step === undefined ? [] : [{ stepId: Number(step) }]))
    },
  )
}

/**
 * A workflow list, as a client may send it.
 *
 * Bare names stay valid — that is most callers, and the CLI only ever sends
 * those. The object form carries the entry's id through a reorder and the
 * tickbox through a save, so there is one door into these rows rather than a
 * second route with its own copy of the rules.
 */
const isSelection = (value: unknown): value is WorkflowSelection[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      (typeof entry === 'string' && entry !== '') ||
      (typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { workflow?: unknown }).workflow === 'string' &&
        (entry as { workflow: string }).workflow !== '' &&
        ['undefined', 'string'].includes(typeof (entry as { id?: unknown }).id) &&
        ['undefined', 'boolean'].includes(typeof (entry as { enabled?: unknown }).enabled)),
  )

interface CreateBody {
  name?: string
  description?: string
  projectId?: string
  ticketId?: string
  branch?: string
  directory?: string
  workflows?: unknown
}

// Both read from core's own lists: a second copy of the vocabulary here would
// accept a state core has dropped, or reject one it has added.
const isState = (value: string): value is TaskState =>
  (TASK_STATES as readonly string[]).includes(value)
const isAction = (value: string): value is TaskAction =>
  (TASK_ACTIONS as readonly string[]).includes(value)

const notFound = (reply: { code: (n: number) => { send: (body: unknown) => unknown } }, id: string) =>
  reply.code(404).send({ error: `No task ${id}.` })
