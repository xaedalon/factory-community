import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Page } from '@playwright/test'
import { test as base } from 'playwright-bdd'

const DAEMON = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/daemon/dist/bin.js',
)
/**
 * The daemon this suite starts, and the dev server it drives.
 *
 * Read from the environment rather than fixed, so a run can sidestep a real
 * Factory that already holds 7317 — Pro's desktop app does, whenever it is
 * open. When they collided, the suite's own daemon could not bind and the run
 * carried on against whatever answered, which once was the developer's real
 * installation. `FACTORY_PORT=7417 FACTORY_WEB_PORT=5417 pnpm test:e2e` is now
 * all it takes to run alongside one.
 */
const PORT = Number(process.env.FACTORY_PORT ?? 7317)

/**
 * A throwaway installation per scenario.
 *
 * Each scenario gets its own temporary scopes and its own daemon pointed at
 * them, so nothing here can read or write the developer's real ~/.factory. The
 * daemon starts lazily — after the Given steps have written their files — and
 * is killed on the way out.
 *
 * The port is fixed because Vite's proxy target is, so scenarios run one at a
 * time. That is the right trade for a handful of browser tests.
 */
export class World {
  readonly root = mkdtempSync(join(tmpdir(), 'factory-web-'))
  readonly workDir = join(this.root, 'work')
  readonly projectScope = join(this.workDir, '.xaedalon', '.factory')
  /** The project the daemon starts with, which every task lands in by default. */
  defaultProject = ''
  readonly userScope = join(this.root, 'home', '.xaedalon', '.factory')
  /**
   * A second repository, with definitions of its own.
   *
   * The daemon is started in `workDir`, so this is the directory that proves a
   * project resolves definitions from its own scope rather than from wherever
   * the daemon happened to be launched.
   */
  readonly otherDir = join(this.root, 'other')
  readonly otherScope = join(this.otherDir, '.xaedalon', '.factory')
  /** Project ids, by name, for the scenarios that need one. */
  readonly projectIds = new Map<string, string>()
  #daemon: ChildProcess | undefined
  excludeBuiltin = false
  /**
   * Start with nothing accepted, the way a real first run does.
   *
   * Opt-in rather than the default, because every scenario that runs a workflow
   * needs an installation where somebody said yes — and the daemon reads its
   * settings once, at start, so this has to be decided before it launches.
   */
  freshInstallation = false
  /** Start with the installation profile set to Full Access. */
  unconfined = false
  /**
   * Whether spawned steps can find a shell.
   *
   * PATH is empty by default so provider availability does not depend on the
   * machine. A scenario that actually runs a workflow needs `bash`, so it opts
   * into a minimal PATH — minimal enough that no agent CLI is on it either.
   */
  withShell = false
  /** Set when a scenario is about what happens with no daemon at all. */
  disabled = false
  /**
   * Whether a stand-in for an agent CLI is on PATH.
   *
   * An artifact belongs to an agent step, so a scenario about evidence needs an
   * agent that runs. This one does the one thing the contract says it will: it
   * reads the path out of the prompt Factory wrote and writes a file there.
   * Which is also what makes it a better test than a shell step was — it proves
   * the wrapper's path is what the agent actually receives.
   */
  withStubAgent = false
  /**
   * What the stub agent writes into the artifact it is told about.
   *
   * Settable so a scenario can hand it Markdown to render, or something
   * hostile to prove the renderer does not run it.
   */
  stubArtifact = 'looks good'
  /** A tab a link opened, so a later step can assert against it. */
  openedTab: Page | undefined
  /** A bundle produced or captured during the scenario. */
  bundle = ''

  createScopes(): void {
    mkdirSync(join(this.workDir, '.git'), { recursive: true })
    mkdirSync(join(this.workDir, 'src'), { recursive: true })
    this.write(join(this.projectScope, 'config.yaml'), 'kind: factory.scope/v1\nscope: project\n')
    this.write(join(this.userScope, 'config.yaml'), 'kind: factory.scope/v1\nscope: user\n')
    // The disclaimer, accepted unless a scenario says otherwise. The daemon
    // refuses to queue a run until it is, for every client, so an installation
    // where nobody has agreed cannot run a workflow — which is most of what
    // this suite is about. `freshInstallation` is the opt-out.
    if (!this.freshInstallation) {
      this.write(
        join(this.userScope, 'settings.json'),
        JSON.stringify({
          security: {
            acceptedVersion: 1,
            ...(this.unconfined ? { profile: 'full-access' } : {}),
          },
        }),
      )
    }
  }

  createOtherScope(): void {
    mkdirSync(join(this.otherDir, '.git'), { recursive: true })
    this.write(join(this.otherScope, 'config.yaml'), 'kind: factory.scope/v1\nscope: project\n')
  }

  /**
   * The daemon this scenario started.
   *
   * Exposed because three steps used to build the URL themselves with the port
   * written in, which worked only while that port was also the default. Running
   * on another one sent them at whatever was on 7317 — a real installation, as
   * it turned out — and they failed with 404s from somebody else's data. One
   * builder, so a step cannot invent a port.
   */
  api(path: string): string {
    return `http://127.0.0.1:${PORT}${path}`
  }

  write(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }

  workflow(scope: string, name: string, body: string): void {
    this.write(join(scope, 'workflows', `${name}.workflow.yaml`), body)
  }

  agent(scope: string, name: string, body: string): void {
    this.write(join(scope, 'agents', `${name}.agent.yaml`), body)
  }

  phase(scope: string, name: string, body: string): void {
    this.write(join(scope, 'phases', `${name}.phase.yaml`), body)
  }

  /**
   * A third-party plugin, on disk, loaded the way a real one would be.
   *
   * Written as a file rather than stubbed in the browser because the claim
   * under test is that the *daemon* publishes the kind's schema and the builder
   * renders it — stubbing either half would test nothing.
   */
  httpPlugin(kind: string, field: string): void {
    // Absolute specifier, because the plugin lives in a temp directory with no
    // node_modules of its own — a bare `zod` import there resolves to nothing
    // and the daemon reports the plugin as unloadable.
    const zod = pathToFileURL(createRequire(import.meta.url).resolve('zod')).href
    this.write(
      join(this.projectScope, 'plugins', 'http.mjs'),
      `import { z } from '${zod}'
export default {
  name: 'acme-${kind}',
  version: '1.0.0',
  register(context) {
    context.provide('step-kind', {
      id: '${kind}',
      summary: 'Makes an HTTP request.',
      schema: z.object({
        ${field}: z.string().min(1),
        method: z.enum(['GET', 'POST']).optional(),
      }),
    })
  },
}
`,
    )
    this.write(
      join(this.projectScope, 'config.yaml'),
      'kind: factory.scope/v1\nscope: project\nplugins:\n  - ./plugins/http.mjs\n',
    )
  }

  /**
   * A third party's own task tool, declared by the project scope.
   *
   * The proof that the buttons on a task are a registry rather than a list the
   * board maintains: nothing in Factory is edited, a file appears in a
   * project, and a button appears on its tasks.
   */
  taskToolPlugin(): void {
    this.write(
      join(this.projectScope, 'plugins', 'docs.mjs'),
      `export default {
  name: 'acme-docs',
  version: '1.0.0',
  register(context) {
    context.provide('task-tool', {
      id: 'acme-docs',
      displayName: 'Acme docs',
      summary: 'Opens our runbook for this task.',
      run: 'detached',
      offer: () => ({ command: { command: 'echo', args: ['runbook'] } }),
    })
  },
}
`,
    )
    this.write(
      join(this.projectScope, 'config.yaml'),
      'kind: factory.scope/v1\nscope: project\nplugins:\n  - ./plugins/docs.mjs\n',
    )
  }

  /** A fake `claude` that obeys the artifact instruction and nothing else. */
  #stubAgent(): string {
    const bin = join(this.root, 'bin')
    const script = join(bin, 'claude')
    this.write(
      script,
      [
        '#!/bin/sh',
        '# The prompt is the last argument, and Factory named the path inside it.',
        'for last in "$@"; do :; done',
        `path=$(printf '%s\\n' "$last" | sed -n 's|^Write your output to ||p')`,
        '[ -n "$path" ] || exit 0',
        // Written through a heredoc rather than printf: the content is
        // arbitrary Markdown, and % in a printf format string is a trap.
        `cat > "$path" <<'ARTIFACT'`,
        this.stubArtifact,
        'ARTIFACT',
        '',
      ].join('\n'),
    )
    chmodSync(script, 0o755)
    return bin
  }

  async startDaemon(): Promise<void> {
    if (this.disabled || this.#daemon !== undefined) return

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FACTORY_HOME: this.userScope,
      FACTORY_PORT: String(PORT),
      // Empty PATH so provider availability is identical on any machine —
      // whether the person running the suite happens to have Claude Code
      // installed is not part of this contract.
      PATH: [
        ...(this.withStubAgent ? [this.#stubAgent()] : []),
        ...(this.withShell || this.withStubAgent ? ['/bin', '/usr/bin'] : []),
      ].join(':'),
      // And a throwaway HOME, because discovery also looks in the usual install
      // locations under it. Without this the suite passes or fails according to
      // what the developer happens to have in ~/.local/bin.
      HOME: this.root,
    }
    if (this.excludeBuiltin) env.FACTORY_SCOPES = `${this.projectScope}:${this.userScope}`

    // process.execPath, not 'node': PATH is deliberately empty above, so the
    // node binary has to be named absolutely or the spawn cannot find itself.
    this.#daemon = spawn(process.execPath, [DAEMON], {
      cwd: this.workDir,
      env,
      stdio: 'ignore',
    })
    await waitForHealth()
    // A task cannot be created without a project, so the working directory is
    // registered as one. Scenarios that are about projects add their own; this
    // is the one everything else lands in.
    this.defaultProject = await this.addProject('workspace', this.workDir)
  }

  /** Create a task the way the board would, so a scenario can start from one. */
  async createTask(name: string, workflows: string[], projectId?: string): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        workflows,
        projectId: projectId ?? this.defaultProject,
      }),
    })
    const body = (await response.json()) as { task: { id: string } }
    return body.task.id
  }

  /** Back to an installation with nothing registered. */
  async removeEveryProject(): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/projects`)
    const body = (await response.json()) as { items: { id: string }[] }
    for (const item of body.items) {
      await fetch(`http://127.0.0.1:${PORT}/api/projects/${item.id}`, { method: 'DELETE' })
    }
    this.defaultProject = ''
  }

  /** Register a project the way the projects page would. */
  async addProject(name: string, path: string): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, path }),
    })
    const body = (await response.json()) as { project?: { id: string } }
    const id = body.project?.id ?? ''
    this.projectIds.set(name, id)
    return id
  }

  /**
   * Queue a task and wait for it to settle.
   *
   * There is no API for setting a flag by hand, and there should not be: a flag
   * is earned by a workflow that completed. So a fixture that needs one runs a
   * workflow that provides it, which also means the scenario is resting on the
   * real mechanism rather than on a back door built for it.
   */
  async runTask(id: string): Promise<void> {
    await fetch(`http://127.0.0.1:${PORT}/api/tasks/${id}/actions/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/tasks/${id}`)
      const body = (await response.json()) as { task: { state: string } }
      if (body.task.state === 'done' || body.task.state === 'blocked') return
      await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error('The task never finished.')
  }

  async stop(): Promise<void> {
    this.#daemon?.kill('SIGKILL')
    this.#daemon = undefined
    rmSync(this.root, { recursive: true, force: true })
    await waitForPortFree()
  }
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('The daemon did not start.')
}

/** The next scenario reuses the port, so make sure this one has let go of it. */
async function waitForPortFree(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/health`)
    } catch {
      return
    }
    await new Promise((done) => setTimeout(done, 100))
  }
}

export const test = base.extend<{ world: World }>({
  // The empty pattern is required, not an oversight: Playwright reads this
  // parameter's destructuring to work out which other fixtures this one depends
  // on, and rejects a plain identifier outright. This fixture depends on none.
  // eslint-disable-next-line no-empty-pattern
  world: async ({}, use) => {
    const world = new World()
    await use(world)
    await world.stop()
  },
})
