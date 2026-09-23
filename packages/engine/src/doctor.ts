import type { Problem } from '@factory/core'
import {
  dependencyStatus,
  isSettled,
  needsOutOfOrder,
  nextEntry,
  workflowNames,
  workspaceFor,
  type Project,
  type Task,
} from '@factory/core'
import type { FactoryPlugin } from '@factory/core'
import { DOCTOR_RULE_KIND, type DoctorRuleCapability } from '@factory/config'
import { SETUP_STEP_KIND, type SetupStepCapability } from '@factory/core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectRepository, RunRepository, TaskRepository } from '@factory/store'
import type { ReconcileReport } from './reconcile.js'
import type { WorkflowFacts } from './scheduler.js'

/**
 * Doctor rules for an installation that is actually running.
 *
 * The built-in rules in @factory/config check what is *installed* — do the
 * definitions parse, does every phase exist, is the provider on PATH. They can
 * run anywhere, including from a CLI invocation that never opens a database.
 * These check what is *happening*, and they only exist in a process that holds
 * the store.
 *
 * Registered as an ordinary plugin so they arrive through the same seam as
 * anything else: where there is no database there are no rules, and `factory
 * doctor` degrades to the installation checks with nothing to configure. That
 * is the same degrade-by-absence the desktop capability uses.
 *
 * The questions are the ones the prototype could not answer without opening
 * the database by hand: why is this task not running, what is waiting for me,
 * and what did the last crash cost.
 */
export interface RunningDoctorOptions {
  readonly tasks: TaskRepository
  readonly runs: RunRepository
  readonly projects: ProjectRepository
  /** What the boot had to correct. */
  readonly reconciliation: ReconcileReport
  /** The same workflow lookup the scheduler uses, so the two cannot disagree. */
  readonly workflow: (name: string, projectId?: string) => WorkflowFacts | undefined
}

export function runningDoctorRules(
  options: RunningDoctorOptions,
): readonly DoctorRuleCapability[] {
  const { tasks, runs, projects, reconciliation } = options

  /** The project this task shares a working copy with, when it is shared. */
  const sharedCheckout = (task: Task): Project | undefined => {
    const project = projects.get(task.projectId)
    return project === undefined || project.usesWorktrees ? undefined : project
  }

  const recovered: DoctorRuleCapability = {
    id: 'runs-recovered-at-boot',
    summary: 'Reports runs that a previous stop left marked as running.',
    check: () =>
      reconciliation.closedRuns.map((run) => ({
        severity: 'warning' as const,
        message:
          `Run of "${run.workflow}" was still marked running when Factory started, so it was ` +
          `closed as failed. Whatever it was doing did not finish.`,
        rule: 'doctor.runRecovered',
      })),
  }

  const stuck: DoctorRuleCapability = {
    id: 'tasks-waiting-on-a-flag',
    summary: 'Queued tasks whose workflow requires a flag nothing has set.',
    check() {
      const problems: Problem[] = []
      for (const task of tasks.list({ state: 'queued' })) {
        const workflow = current(task)
        if (workflow === undefined) continue
        const facts = options.workflow(workflow, task.projectId)
        const unmet = (facts?.requires ?? []).filter((flag) => !task.flags.includes(flag))
        if (unmet.length === 0) continue

        // The old message here said the task "will wait until a workflow
        // provides it". That is never true. Flags belong to one task, and the
        // workflow being blocked is the earliest one it has not run — so no
        // later workflow can set the flag in time, and nothing else can set it
        // at all. Whichever way it is stuck, it is stuck for good, and saying
        // "waiting" invites someone to wait.
        const provider = (flag: string): string | undefined =>
          task.workflows.find((entry) =>
            options.workflow(entry.workflow, task.projectId)?.provides?.includes(flag),
          )?.workflow

        for (const flag of unmet) {
          const from = provider(flag)
          problems.push({
            severity: 'error',
            message:
              from === undefined
                ? `Task "${task.name}" needs the flag ${flag} before "${workflow}" can run, and ` +
                  `nothing it is assigned provides it. Assign a workflow that does, or one that ` +
                  `does not need it.`
                : `Task "${task.name}" needs the flag ${flag} before "${workflow}" can run. ` +
                  `"${from}" provides it, but it comes after "${workflow}" in the list, so it ` +
                  `will never run. Put it first.`,
            rule: 'doctor.taskFlagUnreachable',
          })
        }
      }
      return problems
    },
  }

  /**
   * A task whose list puts a workflow before something it needs.
   *
   * The builder assembles the list correctly; this is for one assembled another
   * way — by the API, by hand, or before the predecessor existed. Reported
   * rather than repaired, for the same reason the flag rule above reports: a
   * task's list is a plan somebody wrote, and quietly rewriting it is worse
   * than saying it is wrong.
   */
  const outOfOrder: DoctorRuleCapability = {
    id: 'tasks-out-of-order',
    summary: 'Tasks whose workflows come before what they need.',
    check() {
      const problems: Problem[] = []
      for (const task of tasks.list()) {
        if (isSettled(task.state)) continue
        const found = needsOutOfOrder(workflowNames(task), (name) =>
          options.workflow(name, task.projectId) === undefined
            ? undefined
            : (options.workflow(name, task.projectId)?.needs ?? []),
        )
        for (const { workflow, missing: predecessor, late } of found) {
          problems.push({
            severity: 'error',
            message: late
              ? `Task "${task.name}" runs "${workflow}" before "${predecessor}", which it needs. ` +
                `"${predecessor}" comes later in the list, so it will not have run. Put it first.`
              : `Task "${task.name}" runs "${workflow}", which needs "${predecessor}" — and that ` +
                `is not in the list at all. Add it before "${workflow}".`,
            rule: 'doctor.needsOutOfOrder',
          })
        }
      }
      return problems
    },
  }

  const missing: DoctorRuleCapability = {
    id: 'tasks-name-a-missing-workflow',
    summary: 'Tasks pointed at a workflow that no longer exists.',
    check({ workflows }) {
      const known = new Set(workflows.map((entry) => entry.name))
      const problems: Problem[] = []
      for (const task of tasks.list()) {
        if (isSettled(task.state)) continue
        for (const { workflow } of task.workflows) {
          if (known.has(workflow)) continue
          // `workflows` is what the installation can see. A task resolves
          // through its project's own scope as well, so ask there before
          // calling a name missing — otherwise every workflow committed to a
          // repository is reported as broken.
          if (options.workflow(workflow, task.projectId) !== undefined) continue
          problems.push({
            severity: 'error',
            message:
              `Task "${task.name}" is assigned the workflow "${workflow}", which does not exist ` +
              `in any scope. Running it will fail before anything starts.`,
            rule: 'doctor.taskMissingWorkflow',
          })
        }
      }
      return problems
    },
  }

  const waiting: DoctorRuleCapability = {
    id: 'tasks-awaiting-a-person',
    summary: 'Tasks stopped at an approval gate.',
    check: () =>
      tasks.list({ state: 'awaiting_approval' }).map((task) => {
        const shared = sharedCheckout(task)
        return {
          severity: 'warning' as const,
          message:
            `Task "${task.name}" is waiting for someone to approve or reject it.` +
            // The honest voice of the scheduler's trade-off: a gate holds the
            // working copy, so in that project it is holding up everything.
            (shared === undefined
              ? ''
              : ` Nothing else in "${shared.name}" can start until it is decided.`),
          rule: 'doctor.taskAwaitingApproval',
        }
      }),
  }

  const blocked: DoctorRuleCapability = {
    id: 'tasks-blocked',
    summary: 'Tasks stopped by a failure.',
    check: () =>
      tasks.list({ state: 'blocked' }).map((task) => {
        const shared = sharedCheckout(task)
        return {
          severity: 'warning' as const,
          message:
            `Task "${task.name}" is blocked: ${task.blockedReason ?? 'no reason was recorded'}` +
            // A blocked task releases the project — otherwise one forgotten
            // failure freezes it — but whatever it left behind is still there.
            (shared === undefined
              ? ''
              : ` Whatever it left in ${shared.path} is still there, and the next task in ` +
                `"${shared.name}" starts on top of it.`),
          rule: 'doctor.taskBlocked',
        }
      }),
  }

  const orphaned: DoctorRuleCapability = {
    id: 'runs-without-a-task',
    summary: 'Runs still marked running while their task is not.',
    check() {
      // A disagreement between the two halves of the record. Neither the board
      // nor the scheduler can be right when this happens, so it is worth saying
      // out loud rather than leaving someone to notice a stuck spinner.
      const problems: Problem[] = []
      for (const run of runs.running()) {
        if (run.taskId === undefined) continue
        const task = tasks.get(run.taskId)
        if (task !== undefined && task.state === 'running') continue
        problems.push({
          severity: 'error',
          message:
            `A run of "${run.workflow}" is marked running, but its task is ` +
            `${task === undefined ? 'gone' : task.state}. Restarting Factory will close it.`,
          rule: 'doctor.runWithoutRunningTask',
        })
      }
      return problems
    },
  }

  const projectPaths: DoctorRuleCapability = {
    id: 'project-paths-exist',
    summary: 'Every project still points at a directory.',
    check: () =>
      projects
        .list()
        .filter((project) => !existsSync(project.path))
        .map((project) => ({
          severity: 'error' as const,
          message:
            `Project "${project.name}" points at ${project.path}, which is no longer there. ` +
            `Anything scheduled for it will fail before it starts.`,
          rule: 'doctor.projectPathMissing',
        })),
  }

  const worktrees: DoctorRuleCapability = {
    id: 'worktrees-still-there',
    summary: 'Tasks that claim a worktree still have one.',
    check() {
      const problems: Problem[] = []
      for (const task of tasks.list()) {
        // The flag is this rule's subject, not its path resolution: the claim
        // is what there is to check against the disk. Where the work would go
        // is resolved rather than rebuilt, so the sentence below cannot name a
        // directory other than the one the engine would really use.
        if (!task.flags.includes('hasWorktree')) continue
        // A row that is not there is a database edited by hand, not a
        // diagnosis this rule can make: the run itself refuses and says which
        // project is missing, which is the honest place for it.
        const project = projects.get(task.projectId)
        if (project === undefined) continue
        const workspace = workspaceFor(task, project, existsSync, join)
        // No worktree was even considered — the project works in place, or the
        // task has no directory of its own. Both are the configured behaviour
        // rather than a fault.
        if (workspace.worktree === undefined || workspace.inWorktree) continue
        // The flag says a workflow created one; the disk says otherwise. Steps
        // gated on it will run in the repository instead, which is exactly the
        // shared-checkout problem worktrees exist to avoid.
        problems.push({
          severity: 'error',
          message:
            `Task "${task.name}" has the flag hasWorktree, but there is no worktree at ` +
            `${workspace.worktree}. Work for it would run in ${workspace.path} instead.`,
          rule: 'doctor.worktreeMissing',
        })
      }
      return problems
    },
  }

  /**
   * A project about to run a built-in that asked to be overridden.
   *
   * Some built-ins cannot know your setup — where a worktree goes, what an
   * environment is made of — and say so with `override: required`. Factory
   * never recognises them by name: the definition declares it, and this reads
   * the declaration.
   *
   * Reported on *use*, not on existence. A workflow nobody has assigned is not
   * a problem waiting to happen, and complaining about the built-in
   * `worktree-create` in a project that never uses worktrees would be noise
   * that teaches people to ignore the checklist.
   */
  const overrides: DoctorRuleCapability = {
    id: 'builtins-needing-a-project-copy',
    summary: 'Tasks about to run a built-in the project was meant to make its own.',
    check() {
      const problems: Problem[] = []
      const said = new Set<string>()

      for (const task of tasks.list()) {
        if (isSettled(task.state)) continue

        for (const { workflow: name } of task.workflows) {
          const facts = options.workflow(name, task.projectId)
          if (facts?.override !== 'required' || facts.scope === 'project') continue

          // One problem per project and workflow, however many tasks share it.
          const key = `${task.projectId}/${name}`
          if (said.has(key)) continue
          said.add(key)

          const project = projects.get(task.projectId)
          problems.push({
            severity: 'error',
            message:
              `"${name}" has to be written for each project — it ships as a placeholder that ` +
              `cannot know how ${project?.name ?? 'this project'} is set up — and ` +
              `${project?.name ?? 'it'} is still using the ${facts.scope} copy. ` +
              (facts.overridePath === undefined
                ? `Save a copy into the project's scope.`
                : `Save a copy at ${facts.overridePath}.`),
            rule: 'doctor.overrideRequired',
          })
        }
      }
      return problems
    },
  }

  /**
   * A task waiting for something that can never finish.
   *
   * The scheduler already blocks a *queued* dependent whose blocker is dead,
   * with the reason, which `doctor.taskBlocked` repeats. A task that has not
   * been queued yet says nothing at all — so a plan assembled in advance can
   * sit there with an edge to a task somebody cancelled last week, and the
   * first anybody hears of it is the batch refusing to start it.
   *
   * Only edges that can never be satisfied. Waiting for something that has not
   * run yet is what waiting is for, and reporting that would make doctor's
   * output a list of everything in progress.
   *
   * A task already `blocked` is left alone: `doctor.taskBlocked` says so, with
   * the reason it was blocked for, and two rules about one task is noise.
   */
  const dependencies: DoctorRuleCapability = {
    id: 'tasks-waiting-on-a-dead-blocker',
    summary: 'Tasks whose blockers can never finish.',
    check() {
      const problems: Problem[] = []
      const edges = tasks.dependencies()
      if (edges.length === 0) return problems

      const facts = new Map<string, ReturnType<TaskRepository['blocker']>>()
      const factsOf = (id: string) => {
        if (!facts.has(id)) facts.set(id, tasks.blocker(id))
        return facts.get(id)
      }

      for (const task of tasks.list()) {
        if (isSettled(task.state) || task.state === 'blocked') continue
        const status = dependencyStatus(task.id, edges, factsOf)
        if (status.state !== 'dead') continue
        const because = status.dead
          .map((entry) => `"${factsOf(entry.id)?.name ?? entry.id}" ${entry.because}`)
          .join(' and ')
        problems.push({
          severity: 'warning',
          message:
            `Task "${task.name}" is waiting for something that cannot finish: ${because}. ` +
            `It will be blocked rather than started when the queue reaches it.`,
          rule: 'doctor.dependencyDead',
        })
      }
      return problems
    },
  }

  return [
    recovered,
    dependencies,
    stuck,
    outOfOrder,
    missing,
    waiting,
    blocked,
    orphaned,
    projectPaths,
    worktrees,
    overrides,
  ]
}

/**
 * The workflow a task will run next: the first one still ticked.
 *
 * `undefined` when nothing is, which the callers must handle rather than
 * falling back to the first — a finished task is not "on" its first workflow.
 */
const current = (task: Task): string | undefined => nextEntry(task)?.workflow

/**
 * Somewhere to work.
 *
 * The one setup step that needs the database: a project is a row, not a file,
 * so no amount of reading the scope chain can answer it. Essential, because a
 * task cannot be created without one — a project is what says where the work
 * happens, and until there is one there is nothing for Factory to do.
 */
function projectStep(options: RunningDoctorOptions): SetupStepCapability {
  return {
    id: 'a-project',
    title: 'Add a repository',
    summary: 'A project is the repository Factory does the work in.',
    order: 20,
    check() {
      const projects = options.projects.list()
      if (projects.length > 0) {
        return {
          done: true,
          detail:
            projects.length === 1
              ? `${projects[0]?.name} (${projects[0]?.path})`
              : `${projects.length} projects.`,
        }
      }
      return {
        done: false,
        essential: true,
        detail: 'No repositories have been added, so there is nowhere for a task to happen.',
        actions: [
          { label: 'Add one on the Projects page', url: '/projects' },
          {
            label: 'Or from a terminal',
            // A command, not an address. This printed `curl 127.0.0.1:7317/…`
            // until an agent following the setup runbook on `FACTORY_PORT=7717`
            // was handed a port nothing was listening on. The CLI resolves the
            // daemon from `FACTORY_URL` or `FACTORY_PORT` in one place, so the
            // hint should not be a second copy of that decision.
            command: 'factory project add my-repo /full/path/to/repo',
          },
        ],
      }
    },
  }
}

/**
 * What the engine knows about a running installation.
 *
 * Doctor rules and setup steps together, because they answer two questions
 * about the same thing and both need the database that only this process has.
 */
export function runningInstallationPlugin(options: RunningDoctorOptions): FactoryPlugin {
  return {
    name: '@factory/engine/running-installation',
    version: '0.1.0',
    register(context) {
      for (const rule of runningDoctorRules(options)) context.provide(DOCTOR_RULE_KIND, rule)
      context.provide(SETUP_STEP_KIND, projectStep(options))
    },
  }
}
