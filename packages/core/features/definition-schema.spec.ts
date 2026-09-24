import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { EventBus } from '@factory/events'
import { CapabilityHost } from '../src/host.js'
import { builtinStepsPlugin } from '../src/builtins/steps.js'
import { parseWorkflow, type Workflow } from '../src/schema/workflow.js'
import { parsePhase, type Phase } from '../src/schema/phase.js'
import type { Problem } from '../src/problems.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./definition-schema.feature', import.meta.url)),
)

// The YAML *file* layer -- locations, comment preservation -- lands in step 4.
// Here the docstring is turned into a plain object so the schema is what is
// under test, not the parser.
const asObject = (docstring: string): unknown => parseYaml(docstring)

describeFeature(feature, ({ Scenario, Rule, BeforeEachScenario }) => {
  let host: CapabilityHost
  let input: unknown
  let workflow: Workflow | undefined
  let phase: Phase | undefined
  let problems: readonly Problem[]

  const errors = () => problems.filter((p) => p.severity === 'error')
  const warnings = () => problems.filter((p) => p.severity === 'warning')
  const anyMessage = (needle: string) =>
    problems.some((p) => p.message.toLowerCase().includes(needle.toLowerCase()))

  BeforeEachScenario(async () => {
    host = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
    await host.load(builtinStepsPlugin)
    input = undefined
    workflow = undefined
    phase = undefined
    problems = []
  })

  const givenWorkflow = (_ctx: unknown, docstring: string) => {
    input = asObject(docstring)
  }
  const whenWorkflowParsed = () => {
    const result = parseWorkflow(input)
    workflow = result.workflow
    problems = result.problems
  }
  const whenPhaseParsed = () => {
    const result = parsePhase(input, host)
    phase = result.phase
    problems = result.problems
  }

  Scenario('An invalid enum value is rejected and names its field', ({ Given, When, Then, And }) => {
    Given('the workflow YAML:', givenWorkflow)
    When('the workflow is parsed', whenWorkflowParsed)
    Then('parsing fails', () => expect(workflow).toBeUndefined())
    And('a problem names the field "mode"', () =>
      expect(errors().some((p) => p.field === 'mode')).toBe(true),
    )
    And('a problem mentions "once"', () => expect(anyMessage('once')).toBe(true))
  })

  Scenario('An unknown field is rejected with a suggestion', ({ Given, When, Then, And }) => {
    Given('the workflow YAML:', givenWorkflow)
    When('the workflow is parsed', whenWorkflowParsed)
    Then('parsing fails', () => expect(workflow).toBeUndefined())
    And('a problem suggests "phases"', () => expect(anyMessage('did you mean "phases"')).toBe(true))
  })

  Scenario('An unknown field with no near match lists the valid ones', ({ Given, When, Then, And }) => {
    Given('the workflow YAML:', givenWorkflow)
    When('the workflow is parsed', whenWorkflowParsed)
    Then('parsing fails', () => expect(workflow).toBeUndefined())
    And('a problem lists the valid fields', () => expect(anyMessage('valid fields')).toBe(true))
  })

  Scenario('A name that is not a slug is rejected', ({ Given, When, Then, And }) => {
    Given('the workflow YAML:', givenWorkflow)
    When('the workflow is parsed', whenWorkflowParsed)
    Then('parsing fails', () => expect(workflow).toBeUndefined())
    And('a problem names the field "name"', () =>
      expect(errors().some((p) => p.field === 'name')).toBe(true),
    )
  })

  Scenario('Defaults are applied so a minimal workflow is complete', ({ Given, When, Then, And }) => {
    Given('the workflow YAML:', givenWorkflow)
    When('the workflow is parsed', whenWorkflowParsed)
    Then('parsing succeeds', () => expect(errors()).toHaveLength(0))
    And('the workflow mode is "once"', () => expect(workflow?.mode).toBe('once'))
    And('the workflow scheduling is "parallel"', () => expect(workflow?.scheduling).toBe('parallel'))
    And('the workflow has 0 phases', () => expect(workflow?.phases).toHaveLength(0))
  })

  Scenario('Every field survives parsing', ({ Given, When, Then, And }) => {
    Given('the workflow YAML:', givenWorkflow)
    When('the workflow is parsed', whenWorkflowParsed)
    Then('parsing succeeds', () => expect(errors()).toHaveLength(0))
    And('the workflow mode is "loop"', () => expect(workflow?.mode).toBe('loop'))
    And('the workflow interval is 30', () => expect(workflow?.interval).toBe(30))
    And('the workflow scheduling is "sequential"', () =>
      expect(workflow?.scheduling).toBe('sequential'),
    )
    And('the workflow on-fail is "development-failure"', () =>
      expect(workflow?.onFail).toBe('development-failure'),
    )
    And('the workflow requires "hasWorktree"', () =>
      expect(workflow?.conditions?.requires).toContain('hasWorktree'),
    )
    And('the workflow provides "hasBuild"', () =>
      expect(workflow?.conditions?.provides).toContain('hasBuild'),
    )
    And('the workflow clears "hasStaleBuild"', () =>
      expect(workflow?.conditions?.clears).toContain('hasStaleBuild'),
    )
    And('the workflow variable "region" is "eu-west-1"', () =>
      expect(workflow?.variables.region).toBe('eu-west-1'),
    )
    And('the workflow has 2 phases', () => expect(workflow?.phases).toHaveLength(2))
  })

  Scenario('interval without a loop is an error rather than a silent no-op', ({ Given, When, Then, And }) => {
    Given('the workflow YAML:', givenWorkflow)
    When('the workflow is parsed', whenWorkflowParsed)
    Then('parsing fails', () => expect(errors().length).toBeGreaterThan(0))
    And('a problem names the field "interval"', () =>
      expect(errors().some((p) => p.field === 'interval')).toBe(true),
    )
  })

  Scenario('Extension fields are preserved untouched', ({ Given, When, Then, And }) => {
    Given('the workflow YAML:', givenWorkflow)
    When('the workflow is parsed', whenWorkflowParsed)
    Then('parsing succeeds', () => expect(errors()).toHaveLength(0))
    And('the workflow extension "x-jira" is preserved', () =>
      expect(workflow?.extensions['x-jira']).toEqual({ project: 'WW2' }),
    )
  })

  Scenario('A phase listed twice is a warning, not an error', ({ Given, When, Then, And }) => {
    Given('the workflow YAML:', givenWorkflow)
    When('the workflow is parsed', whenWorkflowParsed)
    Then('parsing succeeds', () => expect(workflow).toBeDefined())
    And('there is a warning about a duplicate phase', () =>
      expect(warnings().some((p) => p.rule === 'workflow.duplicatePhase')).toBe(true),
    )
  })

  Scenario('An agent step with no prompt is an error, never a silent drop', ({ Given, When, Then, And }) => {
    Given('the phase YAML:', givenWorkflow)
    When('the phase is parsed', whenPhaseParsed)
    Then('parsing fails', () => expect(phase).toBeUndefined())
    And('a problem names the field "steps.0.prompt"', () =>
      expect(errors().some((p) => p.field === 'steps.0.prompt')).toBe(true),
    )
  })

  Scenario('A phase carries approval and a working directory', ({ Given, When, Then, And }) => {
    Given('the phase YAML:', givenWorkflow)
    When('the phase is parsed', whenPhaseParsed)
    Then('parsing succeeds', () => expect(errors()).toHaveLength(0))
    And('the phase approval is "after"', () => expect(phase?.approval).toBe('after'))
    And('the phase working directory is "web"', () => expect(phase?.workingDir).toBe('web'))
  })

  Scenario('A phase with no steps is a warning', ({ Given, When, Then, And }) => {
    Given('the phase YAML:', givenWorkflow)
    When('the phase is parsed', whenPhaseParsed)
    Then('parsing succeeds', () => expect(errors()).toHaveLength(0))
    And('there is a warning about a phase with no steps', () =>
      expect(problems.some((problem) => problem.rule === 'phase.noSteps')).toBe(true),
    )
  })

  Scenario('The old spelling of approval is still understood', ({ Given, When, Then, And }) => {
    Given('the phase YAML:', givenWorkflow)
    When('the phase is parsed', whenPhaseParsed)
    Then('parsing succeeds', () => expect(errors()).toHaveLength(0))
    // Read, never written: a file that says `required` keeps working, and is
    // spelled `after` the next time it is saved.
    And('the phase approval is "after"', () => expect(phase?.approval).toBe('after'))
  })

  Scenario('A phase can ask before it runs anything', ({ Given, When, Then, And }) => {
    Given('the phase YAML:', givenWorkflow)
    When('the phase is parsed', whenPhaseParsed)
    Then('parsing succeeds', () => expect(errors()).toHaveLength(0))
    And('the phase approval is "before"', () => expect(phase?.approval).toBe('before'))
  })

  Rule('a loop can say how many times', ({ RuleScenario }) => {
    RuleScenario('A loop with a repeat count', ({ Given, When, Then, And }) => {
      Given('the workflow YAML:', givenWorkflow)
      When('the workflow is parsed', whenWorkflowParsed)
      Then('parsing succeeds', () => expect(workflow).toBeDefined())
      And('the workflow repeat is 5', () => expect(workflow?.repeat).toBe(5))
    })

    RuleScenario('A repeat of nought is refused', ({ Given, When, Then, And }) => {
      Given('the workflow YAML:', givenWorkflow)
      When('the workflow is parsed', whenWorkflowParsed)
      Then('parsing fails', () => expect(workflow).toBeUndefined())
      And('a problem names the field "repeat"', () =>
        expect(errors().some((problem) => problem.field === 'repeat')).toBe(true),
      )
    })

    RuleScenario('A repeat past a hundred is refused', ({ Given, When, Then, And }) => {
      Given('the workflow YAML:', givenWorkflow)
      When('the workflow is parsed', whenWorkflowParsed)
      Then('parsing fails', () => expect(workflow).toBeUndefined())
      And('a problem names the field "repeat"', () =>
        expect(errors().some((problem) => problem.field === 'repeat')).toBe(true),
      )
    })

    RuleScenario('repeat without a loop is an error rather than a silent no-op', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the workflow YAML:', givenWorkflow)
      When('the workflow is parsed', whenWorkflowParsed)
      Then('parsing fails', () => expect(errors().length).toBeGreaterThan(0))
      And('a problem names the field "repeat"', () =>
        expect(errors().some((problem) => problem.field === 'repeat')).toBe(true),
      )
    })

    RuleScenario('A loop with no repeat is still valid, and unbounded', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the workflow YAML:', givenWorkflow)
      When('the workflow is parsed', whenWorkflowParsed)
      Then('parsing succeeds', () => expect(workflow).toBeDefined())
      // Absent, not 0 and not Infinity — "until somebody stops it" is what a
      // loop meant before `repeat` existed, and it stays sayable.
      And('the workflow has no repeat', () => expect(workflow?.repeat).toBeUndefined())
    })
  })

  Rule('a workflow names what must come before it', ({ RuleScenario }) => {
    RuleScenario('A workflow declares its predecessor', ({ Given, When, Then, And }) => {
      Given('the workflow YAML:', givenWorkflow)
      When('the workflow is parsed', whenWorkflowParsed)
      Then('parsing succeeds', () => expect(workflow).toBeDefined())
      And('the workflow needs "validate"', () => expect(workflow?.needs).toEqual(['validate']))
    })

    RuleScenario('A workflow that needs nothing has an empty list, not a missing one', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the workflow YAML:', givenWorkflow)
      When('the workflow is parsed', whenWorkflowParsed)
      Then('parsing succeeds', () => expect(workflow).toBeDefined())
      // Always present, like `phases`. Absent and empty are the same thing for
      // a list, and two ways to spell it is two things to check for.
      And('the workflow needs nothing', () => expect(workflow?.needs).toEqual([]))
    })

    RuleScenario('A workflow cannot need itself', ({ Given, When, Then, And }) => {
      Given('the workflow YAML:', givenWorkflow)
      When('the workflow is parsed', whenWorkflowParsed)
      // An error, where a self-referencing `on_fail` is only a warning: that one
      // merely never helps, this one can never be satisfied.
      Then('parsing fails', () => expect(errors().length).toBeGreaterThan(0))
      And('a problem names the field "needs"', () =>
        expect(errors().some((problem) => problem.field === 'needs')).toBe(true),
      )
    })

    RuleScenario('A path is not a workflow name', ({ Given, When, Then, And }) => {
      Given('the workflow YAML:', givenWorkflow)
      When('the workflow is parsed', whenWorkflowParsed)
      Then('parsing fails', () => expect(workflow).toBeUndefined())
      And('a problem names the field "needs.0"', () =>
        expect(errors().some((problem) => problem.field === 'needs.0')).toBe(true),
      )
    })
  })
  Rule('a workflow with no phases says so while somebody can still see it', ({ RuleScenario }) => {
    RuleScenario('A workflow with no phases parses, with a warning', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the workflow YAML:', givenWorkflow)
      When('the workflow is parsed', whenWorkflowParsed)
      Then('parsing succeeds', () => expect(workflow).toBeDefined())
      And('a warning says the workflow will do nothing', () => {
        expect(warnings().map((problem) => problem.rule)).toContain('workflow.noPhases')
        expect(warnings()[0]?.message).toContain('do nothing')
      })
    })

    RuleScenario('A workflow with a phase says nothing', ({ Given, When, Then, And }) => {
      Given('the workflow YAML:', givenWorkflow)
      When('the workflow is parsed', whenWorkflowParsed)
      Then('parsing succeeds', () => expect(workflow).toBeDefined())
      And('there are no warnings', () => expect(warnings()).toEqual([]))
    })
  })
})
