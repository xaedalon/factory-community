import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EventBus } from '@factory/events'
import { CapabilityHost } from '../src/host.js'
import { builtinStepsPlugin } from '../src/builtins/steps.js'
import {
  parseAgentFile,
  parsePhaseFile,
  parseProfileFile,
  parseWorkflowFile,
} from '../src/yaml/parse.js'
import {
  updateExistingAgent,
  updateExistingPhase,
  updateExistingProfile,
  updateExistingWorkflow,
  writeNewWorkflow,
} from '../src/yaml/serialize.js'
import type { Workflow } from '../src/schema/workflow.js'
import type { Agent } from '../src/schema/agent.js'
import type { Profile } from '../src/schema/profile.js'

const feature = await loadFeature(fileURLToPath(new URL('./round-trip.feature', import.meta.url)))

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

const keyOrder = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => /^([a-z_][a-z0-9_-]*):/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined)

describeFeature(feature, ({ Scenario, ScenarioOutline, BeforeEachScenario }) => {
  let host: CapabilityHost
  let source = ''
  let output = ''
  let workflow: Workflow | undefined
  let refused = false

  BeforeEachScenario(async () => {
    host = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
    await host.load(builtinStepsPlugin)
    source = ''
    output = ''
    workflow = undefined
    refused = false
  })

  const parseWorkflowSource = () => {
    const result = parseWorkflowFile(source, 'fixture.yaml')
    expect(result.problems.filter((p) => p.severity === 'error')).toEqual([])
    workflow = result.value
    expect(workflow).toBeDefined()
  }

  ScenarioOutline('A no-op save changes nothing at all', ({ Given, When, Then }, variables) => {
    Given('the fixture "<fixture>"', () => {
      source = fixture(String(variables.fixture))
    })
    When('it is parsed and written back with no changes', () => {
      parseWorkflowSource()
      output = updateExistingWorkflow(source, workflow as Workflow)
    })
    Then('the file is byte-for-byte unchanged', () => {
      expect(output).toBe(source)
    })
  })

  Scenario(
    'Editing one field preserves comments, order and every other field',
    ({ Given, When, Then, And }) => {
      Given('the fixture "full-featured.workflow.yaml"', () => {
        source = fixture('full-featured.workflow.yaml')
      })
      When('the description is changed to "Rewritten."', () => {
        parseWorkflowSource()
        output = updateExistingWorkflow(source, {
          ...(workflow as Workflow),
          description: 'Rewritten.',
        })
      })
      Then('the description is "Rewritten."', () => {
        expect(output).toContain('description: Rewritten.')
      })
      And('the comment "# The development pipeline." is still present', () => {
        expect(output).toContain('# The development pipeline.')
      })
      And('the comment "# used by the deploy step" is still present', () => {
        expect(output).toContain('# used by the deploy step')
      })
      And('the on-fail workflow is still "development-failure"', () => {
        expect(output).toContain('on_fail: development-failure')
      })
      And('the conditions still require "hasWorktree"', () => {
        expect(output).toContain('hasWorktree')
      })
      And('the key order is unchanged', () => {
        expect(keyOrder(output)).toEqual(keyOrder(source))
      })
    },
  )

  Scenario(
    'A value written explicitly is kept even when it equals the default',
    ({ Given, When, Then, And }) => {
      Given('the fixture "explicit-defaults.workflow.yaml"', () => {
        source = fixture('explicit-defaults.workflow.yaml')
      })
      When('it is parsed and written back with no changes', () => {
        parseWorkflowSource()
        output = updateExistingWorkflow(source, workflow as Workflow)
      })
      Then('the file still contains "mode: once"', () => {
        expect(output).toContain('mode: once')
      })
      And('the file still contains "scheduling: parallel"', () => {
        expect(output).toContain('scheduling: parallel')
      })
    },
  )

  Scenario('The canonical writer omits values that equal the default', ({ Given, When, Then, And }) => {
    Given('the fixture "explicit-defaults.workflow.yaml"', () => {
      source = fixture('explicit-defaults.workflow.yaml')
    })
    When('it is written from scratch by the canonical writer', () => {
      parseWorkflowSource()
      output = writeNewWorkflow(workflow as Workflow)
    })
    Then('the output does not contain "mode: once"', () => {
      expect(output).not.toContain('mode: once')
    })
    And('the output does not contain "scheduling: parallel"', () => {
      expect(output).not.toContain('scheduling: parallel')
    })
    And('the output contains "name: release"', () => {
      expect(output).toContain('name: release')
    })
  })

  Scenario('Removing a field deletes its key', ({ Given, When, Then, And }) => {
    Given('the fixture "full-featured.workflow.yaml"', () => {
      source = fixture('full-featured.workflow.yaml')
    })
    When('the on-fail workflow is removed', () => {
      parseWorkflowSource()
      const { onFail: _removed, ...rest } = workflow as Workflow
      output = updateExistingWorkflow(source, rest as Workflow)
    })
    Then('the file no longer contains "on_fail"', () => {
      expect(output).not.toContain('on_fail')
    })
    And('the comment "# The development pipeline." is still present', () => {
      expect(output).toContain('# The development pipeline.')
    })
  })

  /** The agent fixture, parsed, for the scenarios about clearing a field. */
  const parseAgentSource = (): Agent => {
    const result = parseAgentFile(source, 'fixture.yaml')
    expect(result.problems.filter((p) => p.severity === 'error')).toEqual([])
    expect(result.value).toBeDefined()
    return result.value as Agent
  }

  Scenario('Emptying a list deletes its key, rather than leaving the old one', ({
    Given,
    When,
    Then,
    And,
  }) => {
    Given('the fixture "full-featured.agent.yaml"', () => {
      source = fixture('full-featured.agent.yaml')
    })
    When('its arguments are emptied', () => {
      output = updateExistingAgent(source, { ...parseAgentSource(), args: [] })
    })
    Then('the file no longer contains "args"', () => expect(output).not.toContain('args'))
    And('the comment at the top is still present', () =>
      expect(output).toContain('# The agent the implementation phases name.'),
    )
  })

  Scenario('Clearing a field back to its default deletes its key too', ({
    Given,
    When,
    Then,
  }) => {
    Given('the fixture "full-featured.agent.yaml"', () => {
      source = fixture('full-featured.agent.yaml')
    })
    When('its description is cleared', () => {
      output = updateExistingAgent(source, { ...parseAgentSource(), description: '' })
    })
    Then('the file no longer contains "description"', () =>
      expect(output).not.toContain('description'),
    )
  })

  Scenario('A phase round-trips its steps, including the agent step', ({ Given, When, Then }) => {
    Given('the fixture "full-featured.phase.yaml"', () => {
      source = fixture('full-featured.phase.yaml')
    })
    When('it is parsed and written back with no changes', () => {
      const result = parsePhaseFile(source, host, 'fixture.yaml')
      expect(result.problems.filter((p) => p.severity === 'error')).toEqual([])
      output = updateExistingPhase(source, result.value!, host)
    })
    Then('the file is byte-for-byte unchanged', () => {
      expect(output).toBe(source)
    })
  })

  Scenario('A profile round-trips everything it carries', ({ Given, When, Then }) => {
    Given('the fixture "full-featured.profile.yaml"', () => {
      source = fixture('full-featured.profile.yaml')
    })
    When('it is parsed and written back with no changes', () => {
      const result = parseProfileFile(source, 'fixture.yaml')
      expect(result.problems.filter((p) => p.severity === 'error')).toEqual([])
      expect(result.value).toBeDefined()
      output = updateExistingProfile(source, result.value as Profile)
    })
    Then('the file is byte-for-byte unchanged', () => expect(output).toBe(source))
  })

  Scenario('Updating refuses to touch a file that does not parse', ({ Given, When, Then }) => {
    Given('a file that is not valid YAML', () => {
      source = 'name: development\n  bad: [unclosed\n'
    })
    When('an update is attempted', () => {
      try {
        updateExistingWorkflow(source, { name: 'x' } as unknown as Workflow)
      } catch {
        refused = true
      }
    })
    Then('the update is refused', () => {
      expect(refused).toBe(true)
    })
  })
})
