import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { CapabilityHost } from '../src/host.js'
import { builtinStepsPlugin } from '../src/builtins/steps.js'
import { parseStep, type PlannedStep, type Step } from '../src/schema/step.js'
import { STEP_KIND, type StepKindCapability } from '../src/schema/step.js'
import type { Problem } from '../src/problems.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./worktree-steps.feature', import.meta.url)),
)

describeFeature(feature, ({ Scenario }) => {
  let host: CapabilityHost
  let step: Step | undefined
  let problems: Problem[] = []
  let planned: PlannedStep | undefined

  const script = (): string => (planned?.args ?? []).join('\n')

  const given = async (yaml: string): Promise<void> => {
    host = new CapabilityHost()
    await host.load(builtinStepsPlugin)
    const result = parseStep(parseYaml(yaml), host)
    step = result.step
    problems = [...result.problems]
    planned = undefined
  }

  const plan = (): void => {
    const kind = host
      .list<StepKindCapability>(STEP_KIND)
      .map((entry) => entry.capability)
      .find((entry) => entry.id === 'worktree')
    const result = kind?.plan?.(step as Step, { host, cwd: '/repo' })
    planned = result === undefined || 'problems' in result ? undefined : result
  }

  Scenario('Creating a worktree on a new branch', ({ Given, When, Then, And }) => {
    Given('the step:', async (_: unknown, yaml: string) => given(yaml))
    When('the step is planned', plan)
    Then('the command is bash', () => expect(planned?.command).toBe('bash'))
    And('the script would create a worktree at "/tmp/worktrees/add-due-dates"', () =>
      expect(script()).toContain('/tmp/worktrees/add-due-dates'),
    )
    // Re-running a workflow after a failure is the common case, not the rare
    // one, so a step that cannot be repeated is a step nobody can retry.
    And('the script checks whether the directory already exists', () =>
      expect(script()).toContain('if [ -d "$dir" ]'),
    )
    And('the script uses the existing branch when there is one', () =>
      expect(script()).toContain('git show-ref --verify --quiet "refs/heads/$branch"'),
    )
  })

  Scenario('Creating from a named starting point', ({ Given, When, Then }) => {
    Given('the step:', async (_: unknown, yaml: string) => given(yaml))
    When('the step is planned', plan)
    Then('the script starts the branch from "origin/main"', () =>
      expect(script()).toContain('origin/main'),
    )
  })

  Scenario('A path with a space is quoted', ({ Given, When, Then }) => {
    Given('the step:', async (_: unknown, yaml: string) => given(yaml))
    When('the step is planned', plan)
    Then('the script quotes the path', () =>
      expect(script()).toContain(`'/tmp/my worktrees/add-due-dates'`),
    )
  })

  Scenario('Creating without a branch is refused', ({ Given, When, Then }) => {
    Given('the step:', async (_: unknown, yaml: string) => given(yaml))
    When('the step is planned', plan)
    Then('the step would fail with a message about the branch', () =>
      expect(script()).toContain('needs a branch'),
    )
  })

  Scenario('Removing a worktree', ({ Given, When, Then, And }) => {
    Given('the step:', async (_: unknown, yaml: string) => given(yaml))
    When('the step is planned', plan)
    Then('the script removes the worktree', () =>
      expect(script()).toContain('git worktree remove --force "$dir"'),
    )
    And("the script prunes git's record of it", () =>
      expect(script()).toContain('git worktree prune'),
    )
    And('the script does nothing when the directory is already gone', () =>
      expect(script()).toContain('no worktree at'),
    )
    And('the script leaves the worktree before removing it', () => {
      const text = script()
      // The repository is found from the worktree while it still exists, and
      // the `cd` happens before the removal — an order this asserts, because
      // either one on its own is no use.
      expect(text).toContain('rev-parse --path-format=absolute --git-common-dir')
      expect(text.indexOf('cd "$main"')).toBeGreaterThan(-1)
      expect(text.indexOf('cd "$main"')).toBeLessThan(
        text.indexOf('git worktree remove --force "$dir"'),
      )
    })
  })

  Scenario('An action the kind does not have is a validation error', ({ Given, When, Then, And }) => {
    Given('the step:', async (_: unknown, yaml: string) => given(yaml))
    When('the step is parsed', () => {
      // Parsed by the Given; this step exists so the scenario reads in order.
    })
    Then('parsing fails', () => expect(step).toBeUndefined())
    And('the problem names the field "action"', () =>
      expect(problems.some((problem) => (problem.field ?? '').includes('action'))).toBe(true),
    )
  })
})
