import type { FastifyInstance } from 'fastify'
import { SCOPE_DIR, createScope, scaffoldProjectDefinitions } from '@factory/config'
import { join } from 'node:path'
import {
  DISCLAIMER,
  EXECUTION_PROFILES,
  NOT_ACCEPTED,
  PROJECT_TONES,
  hasAccepted,
  isExecutionProfile,
  queueOrder,
} from '@factory/core'
import type { ExecutionProfile, Project, ProjectSetting, Task } from '@factory/core'
import { ProjectHasTasksError } from '@factory/store'
import type { Runtime } from '@factory/runtime'
import type { Service } from '../service.js'

/** What scaffolding did, or why it could not. */
interface ScaffoldReport {
  readonly written: readonly string[]
  readonly kept: readonly string[]
  readonly missing: readonly string[]
  readonly error?: string
}

/** One report from however many settings were touched. */
const merge = (reports: readonly (ScaffoldReport | undefined)[]): ScaffoldReport => {
  const present = reports.filter((report): report is ScaffoldReport => report !== undefined)
  const error = present.find((report) => report.error !== undefined)?.error
  return {
    written: present.flatMap((report) => report.written),
    kept: present.flatMap((report) => report.kept),
    missing: present.flatMap((report) => report.missing),
    ...(error === undefined ? {} : { error }),
  }
}

/**
 * Projects over HTTP.
 *
 * The repository does the checking — the path exists, it is a directory, the
 * name is free — so a bad request comes back as the sentence the repository
 * wrote rather than a second set of rules kept here that could disagree with it.
 */
export function registerProjectRoutes(
  app: FastifyInstance,
  service: Service,
  runtime: Runtime,
): void {
  const { projects, tasks, chains } = service

  /**
   * Whether this installation has been told what an agent run can reach.
   *
   * Read fresh each time rather than captured, the same way the task routes
   * read it: accepting has to take effect without a restart, and the holder is
   * the one live copy.
   */
  const accepted = (): boolean => hasAccepted(runtime.settings.current().security.acceptedVersion)


  /**
   * Put the definitions a setting needs into the project, and say what landed.
   *
   * Done here rather than in the repository because the repository writes rows
   * and this writes files — and because it needs the project's own scope chain,
   * which only the daemon can resolve.
   *
   * Failing to scaffold does not fail the request. The setting is a database
   * fact and it was set; not being able to write into someone's repository —
   * read-only checkout, permissions, a `.factory` that is a file — is worth
   * reporting, not worth undoing their change over.
   */
  const scaffold = async (project: Project, setting: ProjectSetting) => {
    const chain = chains.for(project.id)
    if (chain === undefined) return undefined
    try {
      return await scaffoldProjectDefinitions({
        chain,
        host: runtime.host,
        // A plugin sees the copies a project is given, the same as any other
        // write.
        hooks: runtime.host.hooks,
        setting,
      })
    } catch (error) {
      return {
        written: [],
        kept: [],
        missing: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  app.get('/api/projects', async () => ({
    items: projects.list().map((project) => ({
      ...project,
      // What a person actually wants to know next to a project: is anything
      // happening in it.
      tasks: tasks.list().filter((task) => task.projectId === project.id).length,
    })),
  }))

  app.post<{
    Body: {
      name?: string
      path?: string
      defaultBranch?: string
      worktreesRoot?: string
      usesWorktrees?: boolean
      usesEnvironments?: boolean
    }
  }>(
    '/api/projects',
    async (request, reply) => {
      const body = request.body ?? {}
      if (typeof body.name !== 'string' || typeof body.path !== 'string') {
        return reply.code(400).send({ error: 'Send { name, path }.' })
      }
      try {
        const project = projects.add({
          name: body.name,
          path: body.path,
          ...(body.defaultBranch === undefined ? {} : { defaultBranch: body.defaultBranch }),
          ...(body.worktreesRoot === undefined ? {} : { worktreesRoot: body.worktreesRoot }),
          ...(body.usesWorktrees === undefined ? {} : { usesWorktrees: body.usesWorktrees }),
          ...(body.usesEnvironments === undefined
            ? {}
            : { usesEnvironments: body.usesEnvironments }),
        })
        // A scope of its own, before anything tries to write into it.
        //
        // A repository with no `.xaedalon/.factory` resolves to a chain with no
        // project scope, and then every write that asks for one fails — which
        // is the first thing a new project does, because the worktree workflows
        // are copied in as it is registered. It answered 500 with "No project
        // scope in this chain", and the reply that had already tried said only
        // `written: []`. Creating it is the one `mkdir` the person would have
        // had to do, and it is the same directory the copies are about to go
        // into.
        //
        // Never over an existing one: the moment `config.yaml` is there the
        // directory is theirs — which is also why Factory never writes an
        // ignore file over a scope somebody may already be sharing.
        const scope = createScope({ root: join(project.path, SCOPE_DIR), kind: 'project' })

        // Whatever it was registered with, it gets the files for.
        const scaffolded = [
          ...(project.usesWorktrees ? [await scaffold(project, 'worktrees')] : []),
          ...(project.usesEnvironments ? [await scaffold(project, 'environments')] : []),
        ]
        return reply.code(201).send({ project, scope, scaffolded: merge(scaffolded) })
      } catch (error) {
        // A path that does not exist or a name already taken is a mistake in
        // the request, not a failure of the server.
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
      }
    },
  )

  /**
   * Change a project.
   *
   * A separate route rather than "remove and add again", which would null the
   * `project_id` of every task that ever ran in it — the record of the work
   * would survive, pointing at nothing. That is also why `name` and
   * `defaultBranch` belong here: they were the two fields a person could only
   * change by destroying the project's history to do it.
   *
   * `path` is deliberately not accepted. Worktree roots are derived from it and
   * every run that ever happened recorded it, so a project that moves is a
   * different project, and saying so is kinder than pretending otherwise.
   *
   * Allowed while the project has work in flight: tasks already running finish
   * where they are, and the new rule applies to whatever starts next.
   */
  app.patch<{
    Params: { id: string }
    Body: {
      name?: unknown
      defaultBranch?: unknown
      tone?: unknown
      initials?: unknown
      usesWorktrees?: boolean
      usesEnvironments?: boolean
      profile?: unknown
    }
  }>('/api/projects/:id', async (request, reply) => {
    if (projects.get(request.params.id) === undefined) {
      return reply.code(404).send({ error: `No project ${request.params.id}.` })
    }
    const { name, defaultBranch, usesWorktrees, usesEnvironments, profile } = request.body ?? {}
    const settingProfile = 'profile' in (request.body ?? {})
    // Present-and-null is how either half of the square is handed back to the
    // name, so "in the body" is the question, not "has a value".
    const settingTone = 'tone' in (request.body ?? {})
    const settingInitials = 'initials' in (request.body ?? {})
    if (
      name === undefined &&
      defaultBranch === undefined &&
      usesWorktrees === undefined &&
      usesEnvironments === undefined &&
      !settingProfile &&
      !settingTone &&
      !settingInitials
    ) {
      return reply.code(400).send({
        error:
          'Send { name } or { defaultBranch } to change what the project is called or where ' +
          'work starts, { usesWorktrees } or { usesEnvironments }, true or false, ' +
          'or { profile } to say how much authority its runs get.',
      })
    }
    // Refused here rather than at the store, so the message names the field a
    // form can put the error against.
    if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
      return reply.code(400).send({ error: 'A project needs a name.' })
    }
    if (
      defaultBranch !== undefined &&
      (typeof defaultBranch !== 'string' || defaultBranch.trim() === '')
    ) {
      return reply.code(400).send({ error: 'A project needs a branch to start work from.' })
    }
    if (
      settingTone &&
      request.body.tone !== null &&
      (!Number.isInteger(request.body.tone) ||
        (request.body.tone as number) < 1 ||
        (request.body.tone as number) > PROJECT_TONES)
    ) {
      return reply.code(400).send({
        error: `colour is 1 to ${PROJECT_TONES}, or null to derive it from the name.`,
      })
    }
    if (settingInitials && request.body.initials !== null) {
      if (typeof request.body.initials !== 'string') {
        return reply.code(400).send({ error: 'letters are text, or null to derive them.' })
      }
    }
    // `null` clears it, which is not the same as `default`: a project that
    // states nothing follows the installation's choice, and returning to that
    // has to be expressible.
    if (settingProfile && profile !== null && !isExecutionProfile(profile)) {
      return reply.code(400).send({
        error: `profile is ${EXECUTION_PROFILES.join(', ')} or null to follow the installation.`,
      })
    }
    if (
      (usesWorktrees !== undefined && typeof usesWorktrees !== 'boolean') ||
      (usesEnvironments !== undefined && typeof usesEnvironments !== 'boolean')
    ) {
      return reply.code(400).send({ error: 'Settings are true or false.' })
    }

    try {
      let project = projects.get(request.params.id) as Project
      const scaffolded: (ScaffoldReport | undefined)[] = []

      // Identity before settings: if the rename is going to be refused for
      // colliding with another project, nothing else should have happened yet.
      if (name !== undefined) project = projects.rename(request.params.id, name as string)
      if (defaultBranch !== undefined) {
        project = projects.setDefaultBranch(request.params.id, defaultBranch as string)
      }
      if (settingTone || settingInitials) {
        project = projects.setAppearance(request.params.id, {
          ...(settingTone ? { tone: (request.body.tone as number | null) ?? undefined } : {}),
          ...(settingInitials
            ? { initials: (request.body.initials as string | null) ?? undefined }
            : {}),
        })
      }
      if (usesWorktrees !== undefined) {
        project = projects.setWorktrees(request.params.id, usesWorktrees)
        // Only on the way on. Turning a setting off leaves the files where they
        // are: they are the project's now, and deleting someone's committed
        // workflow because they flipped a checkbox would be unforgivable.
        if (usesWorktrees) scaffolded.push(await scaffold(project, 'worktrees'))
      }
      if (usesEnvironments !== undefined) {
        project = projects.setEnvironments(request.params.id, usesEnvironments)
        if (usesEnvironments) scaffolded.push(await scaffold(project, 'environments'))
      }
      if (settingProfile) {
        // Nothing is scaffolded for a profile: it changes what the next run is
        // *given*, not what the repository contains.
        project = projects.setProfile(
          request.params.id,
          profile === null ? undefined : (profile as ExecutionProfile),
        )
      }

      return { project, scaffolded: merge(scaffolded) }
    } catch (error) {
      // "That directory is not a git repository" is a fact about the request.
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  /**
   * Queue everything in this project that can be queued, in dependency order.
   *
   * One request rather than one per task. The board holds one error and one
   * acting id, with nowhere to put a partial refusal, and the disclaimer should
   * be answered once for a batch rather than ten times over.
   *
   * Every task goes through the ordinary `queue` action, so each takes its
   * `MAX(queue_position) + 1` ticket **in dependency order** — which is what
   * makes the queue's advisory ordering agree with the graph rather than merely
   * not contradict it. The scheduler would hold the dependents either way; this
   * is so the board reads in the order the work will happen.
   *
   * `draft` and `blocked` are what a person means by "everything": a blocked
   * task is usually blocked on something that has since been dealt with.
   * Never `done` or `cancelled` — one click must not set five agents on work
   * that already finished.
   */
  app.post<{ Params: { id: string } }>('/api/projects/:id/queue', async (request, reply) => {
    const project = projects.get(request.params.id)
    if (project === undefined) {
      return reply.code(404).send({ error: `No project ${request.params.id}.` })
    }
    // The same gate the single `queue` has, asked once. Queueing is what leads
    // to an agent running, whether it is one task or ten.
    if (!accepted()) {
      return reply.code(409).send({ error: NOT_ACCEPTED, disclaimer: DISCLAIMER })
    }

    const candidates = tasks
      .list({ projectId: project.id })
      .filter((task) => task.state === 'draft' || task.state === 'blocked')
    const { order, problems } = queueOrder(
      candidates.map((task) => task.id),
      tasks.dependenciesIn(project.id),
    )
    // Only a hand-edited database can hold a ring — the store refuses one at
    // the door. Worth refusing rather than ignoring all the same: the walk
    // cannot place a ring's members, so carrying on would queue everything
    // else and silently leave those out.
    if (problems.length > 0) {
      return reply.code(409).send({
        error: 'These tasks depend on each other in a ring, so there is no order to queue them in.',
        problems,
      })
    }

    const byId = new Map(candidates.map((task) => [task.id, task]))
    const queued: Task[] = []
    const skipped: { task: Task; reason: string }[] = []
    for (const id of order) {
      const task = byId.get(id) as Task
      // Nothing ticked is nothing to run, and the state machine says so. Said
      // out loud rather than failing the batch: a project usually has a draft
      // somebody has not planned yet.
      if (!tasks.actions(id).some((entry) => entry.action === 'queue')) {
        skipped.push({ task, reason: 'nothing in its plan is ticked' })
        continue
      }
      queued.push(tasks.act(id, 'queue'))
    }
    return { queued, skipped }
  })

  /**
   * Stop everything in flight in this project.
   *
   * Cancels what is running, what is waiting for a person, and what is in the
   * queue, then makes sure the processes are gone.
   *
   * Cancelling the queued ones is not optional: a transition wakes the
   * scheduler, so a stop that only killed processes would visibly start the
   * next task within a tick.
   *
   * `draft` and `blocked` are deliberately left alone, which is where this
   * differs from the global kill switch. Neither is happening, both are what
   * Queue all picks up from, and one click must not quietly clear the work
   * somebody has planned but not started.
   *
   * Never gated on the disclaimer, for the reason `/api/runs/stop` is not:
   * refusing to *stop* work because nobody has agreed to a notice would be the
   * most hostile possible reading of a safety feature.
   */
  app.post<{ Params: { id: string } }>('/api/projects/:id/stop', async (request, reply) => {
    const project = projects.get(request.params.id)
    if (project === undefined) {
      return reply.code(404).send({ error: `No project ${request.params.id}.` })
    }

    const cancelled: Task[] = []
    let signalled = 0
    let killed = 0
    for (const task of tasks.list({ projectId: project.id })) {
      if (task.state !== 'running' && task.state !== 'awaiting_approval' && task.state !== 'queued') {
        continue
      }
      cancelled.push(tasks.act(task.id, 'cancel', { reason: 'Stopped by request.' }))
      // The engine's watcher also reacts to the transition, on a microtask.
      // Asked directly as well so the answer this request returns is the truth
      // rather than whatever had happened by the time it was serialised.
      const report = await service.engine.cancel(task.id)
      signalled += report.signalled
      killed += report.killed
    }
    return { cancelled, signalled, killed }
  })

  /**
   * Forget a project, if nothing is left in it.
   *
   * 409 rather than a cascade: removing a project used to orphan its tasks,
   * and an orphan ran wherever the daemon was started. The count is in the
   * body as well as the message, so a client can say "3 tasks" without reading
   * a sentence.
   */
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    try {
      if (!projects.remove(request.params.id)) {
        return reply.code(404).send({ error: `No project ${request.params.id}.` })
      }
    } catch (error) {
      if (error instanceof ProjectHasTasksError) {
        return reply
          .code(409)
          .send({ error: error.message, tasks: error.count, archived: error.archived })
      }
      throw error
    }
    return reply.code(204).send()
  })
}
