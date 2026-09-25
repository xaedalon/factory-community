import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A throwaway filesystem for one scenario.
 *
 * Every path in these tests is generated, never literal. The prototype's
 * fixtures hardcoded one developer's home directory into every config file and
 * shell script, so its suite only ran on one machine.
 */
export class Sandbox {
  readonly root: string
  readonly home: string

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'factory-scope-'))
    this.home = this.dir('home')
  }

  dir(...parts: string[]): string {
    const path = join(this.root, ...parts)
    mkdirSync(path, { recursive: true })
    return path
  }

  /** A path inside the sandbox, without creating it. */
  path(...parts: string[]): string {
    return join(this.root, ...parts)
  }

  file(relative: string, contents: string): string {
    const path = join(this.root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    return path
  }

  /** Create a scope directory at the current path, optionally declaring its kind. */
  scope(relative: string, kind?: 'project' | 'user' | 'builtin'): string {
    return this.#scopeAt(this.dir(relative, '.xaedalon', '.factory'), kind)
  }

  /** The same, at the path scopes used to live at. For the compatibility tests. */
  legacyScope(relative: string, kind?: 'project' | 'user' | 'builtin'): string {
    return this.#scopeAt(this.dir(relative, '.factory'), kind)
  }

  #scopeAt(root: string, kind?: 'project' | 'user' | 'builtin'): string {
    if (kind !== undefined) {
      writeFileSync(join(root, 'config.yaml'), `kind: factory.scope/v1\nscope: ${kind}\n`)
    }
    return root
  }

  workflow(scopeRoot: string, name: string, body: string): string {
    const path = join(scopeRoot, 'workflows', `${name}.workflow.yaml`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    return path
  }

  phase(scopeRoot: string, name: string, body: string): string {
    const path = join(scopeRoot, 'phases', `${name}.phase.yaml`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    return path
  }

  agent(scopeRoot: string, name: string, body: string): string {
    const path = join(scopeRoot, 'agents', `${name}.agent.yaml`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    return path
  }

  profile(scopeRoot: string, name: string, body: string): string {
    const path = join(scopeRoot, 'profiles', `${name}.profile.yaml`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    return path
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}
