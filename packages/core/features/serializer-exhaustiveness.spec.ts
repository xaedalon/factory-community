import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { EventBus } from '@factory/events'
import { CapabilityHost } from '../src/host.js'
import { builtinStepsPlugin } from '../src/builtins/steps.js'
import {
  AGENT_FIELDS,
  PROFILE_FIELDS,
  FIELD_TABLES,
  PHASE_FIELDS,
  WORKFLOW_FIELDS,
  type FieldSpec,
} from '../src/schema/fields.js'
import { parseWorkflow } from '../src/schema/workflow.js'
import { parsePhase } from '../src/schema/phase.js'
import { parseAgent } from '../src/schema/agent.js'
import { workflowSchemaKeys } from '../src/schema/workflow.js'
import { phaseSchemaKeys } from '../src/schema/phase.js'
import { agentSchemaKeys } from '../src/schema/agent.js'
import { parseProfile, profileSchemaKeys } from '../src/schema/profile.js'

const feature = await loadFeature(
  fileURLToPath(new URL('./serializer-exhaustiveness.feature', import.meta.url)),
)

const difference = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x))

describeFeature(feature, ({ Scenario }) => {
  let schemaKeys: readonly string[] = []
  let tableKeys: readonly string[] = []
  /** Which kinds a scenario in this file has actually compared. */
  const compared = new Set<string>()

  const compare = (kind: string, schema: readonly string[], table: readonly FieldSpec<never>[]) => {
    compared.add(kind)
    schemaKeys = schema
    tableKeys = table.map((spec) => spec.yaml)
  }

  Scenario('Every workflow schema field has a writer rule', ({ When, Then, And }) => {
    When('the workflow field table is compared to the workflow schema', () => {
      compare('workflow', workflowSchemaKeys, WORKFLOW_FIELDS as readonly FieldSpec<never>[])
    })
    Then('no schema field is missing from the table', () => {
      expect(difference(schemaKeys, tableKeys)).toEqual([])
    })
    And('no table entry names a field the schema does not accept', () => {
      expect(difference(tableKeys, schemaKeys)).toEqual([])
    })
  })

  Scenario('Every phase schema field has a writer rule', ({ When, Then, And }) => {
    When('the phase field table is compared to the phase schema', () => {
      compare('phase', phaseSchemaKeys, PHASE_FIELDS as readonly FieldSpec<never>[])
    })
    Then('no schema field is missing from the table', () => {
      expect(difference(schemaKeys, tableKeys)).toEqual([])
    })
    And('no table entry names a field the schema does not accept', () => {
      expect(difference(tableKeys, schemaKeys)).toEqual([])
    })
  })

  Scenario('Every agent schema field has a writer rule', ({ When, Then, And }) => {
    When('the agent field table is compared to the agent schema', () => {
      compare('agent', agentSchemaKeys, AGENT_FIELDS as readonly FieldSpec<never>[])
    })
    Then('no schema field is missing from the table', () => {
      expect(difference(schemaKeys, tableKeys)).toEqual([])
    })
    And('no table entry names a field the schema does not accept', () => {
      expect(difference(tableKeys, schemaKeys)).toEqual([])
    })
  })

  Scenario('Every profile schema field has a writer rule', ({ When, Then, And }) => {
    When('the profile field table is compared to the profile schema', () => {
      compare('profile', profileSchemaKeys, PROFILE_FIELDS as readonly FieldSpec<never>[])
    })
    Then('no schema field is missing from the table', () => {
      expect(difference(schemaKeys, tableKeys)).toEqual([])
    })
    And('no table entry names a field the schema does not accept', () => {
      expect(difference(tableKeys, schemaKeys)).toEqual([])
    })
  })

  /**
   * The guard on the guard.
   *
   * Every table was checked against its schema, and nothing checked that every
   * table was being checked — so a new definition kind could ship with an
   * unverified writer and this suite would stay green, which is the exact shape
   * of the defect the feature exists to prevent.
   */
  Scenario("Every kind's table was actually compared", ({ Then }) => {
    Then('every field table this package exports has been checked', () => {
      expect(difference(Object.keys(FIELD_TABLES), [...compared])).toEqual([])
    })
  })

  Scenario('Every table entry maps to a real property of the domain type', ({ Then, And }) => {
    // A table entry could name a `from` that the parser never produces -- the
    // field would then always look absent and never be written. Parsing a
    // fully-populated definition and checking each key actually appears is what
    // catches that.
    Then('every workflow table entry names a property the parser produces', () => {
      const parsed = parseWorkflow(
        parseYaml(
          [
            'kind: factory.workflow/v1',
            'name: development',
            'description: everything',
            'mode: loop',
            'interval: 30',
            'repeat: 5',
            'scheduling: sequential',
            'variables: {region: eu-west-1}',
            'needs: [groundwork]',
            'conditions: {requires: [hasWorktree]}',
            'on_fail: development-failure',
            'override: required',
            'reliability: {contributes: [design], expected_evidence: [technical_approach]}',
            'phases: [analysis]',
          ].join('\n'),
        ),
      ).workflow
      expect(parsed).toBeDefined()
      const missing = WORKFLOW_FIELDS.filter(
        (spec) => spec.from !== null && spec.emit !== 'omit' && parsed?.[spec.from] === undefined,
      ).map((spec) => spec.yaml)
      expect(missing).toEqual([])
    })
    And('every phase table entry names a property the parser produces', async () => {
      const host = new CapabilityHost({ events: new EventBus({ onSubscriberError: () => {} }) })
      await host.load(builtinStepsPlugin)
      const parsed = parsePhase(
        parseYaml(
          [
            'kind: factory.phase/v1',
            'name: analysis',
            'description: everything',
            'approval: after',
            'working_dir: web',
            'variables: {region: eu-west-1}',
            'steps: [{run: npm test}]',
          ].join('\n'),
        ),
        host,
      ).phase
      expect(parsed).toBeDefined()
      const missing = PHASE_FIELDS.filter(
        (spec) => spec.from !== null && spec.emit !== 'omit' && parsed?.[spec.from] === undefined,
      ).map((spec) => spec.yaml)
      expect(missing).toEqual([])
    })
    And('every profile table entry names a property the parser produces', () => {
      const parsed = parseProfile(
        parseYaml(
          [
            'kind: factory.profile/v1',
            'name: development',
            'description: everything',
            'extends: default',
            'commands: [cargo]',
            'deny_commands: [git push]',
            'providers: {claude: {args: [--add-dir, /opt]}}',
          ].join('\n'),
        ),
      ).profile
      expect(parsed).toBeDefined()
      const missing = PROFILE_FIELDS.filter(
        (spec) => spec.from !== null && spec.emit !== 'omit' && parsed?.[spec.from] === undefined,
      ).map((spec) => spec.yaml)
      expect(missing).toEqual([])
    })
    And('every agent table entry names a property the parser produces', () => {
      const parsed = parseAgent(
        parseYaml(
          [
            'kind: factory.agent/v1',
            'name: developer',
            'description: everything',
            'provider: claude',
            'model: strong',
            'effort: high',
            'subagent: implementer',
            'session: workflow',
            'args: [--verbose]',
          ].join('\n'),
        ),
      ).agent
      expect(parsed).toBeDefined()
      const missing = AGENT_FIELDS.filter(
        (spec) => spec.from !== null && spec.emit !== 'omit' && parsed?.[spec.from] === undefined,
      ).map((spec) => spec.yaml)
      expect(missing).toEqual([])
    })
  })

  Scenario('A field deliberately left unwritten must say why', ({ Then }) => {
    Then('every omitted field records a reason', () => {
      const undocumented = Object.values(FIELD_TABLES)
        .flat()
        .filter((spec) => spec.emit === 'omit' && !spec.why)
        .map((spec) => spec.yaml)
      expect(undocumented).toEqual([])
    })
  })
})
