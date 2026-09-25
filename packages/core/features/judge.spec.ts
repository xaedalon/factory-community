import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolveJudge, type JudgeChoice } from '../src/index.js'

const feature = await loadFeature(fileURLToPath(new URL('./judge.feature', import.meta.url)))

describeFeature(feature, ({ Rule }) => {
  Rule("a project's choice beats the installation's, field by field", ({ RuleScenario }) => {
    let project: JudgeChoice | undefined
    let installation: JudgeChoice | undefined
    const judge = (): JudgeChoice =>
      resolveJudge({
        ...(project === undefined ? {} : { project }),
        ...(installation === undefined ? {} : { installation }),
      })

    RuleScenario("A project's provider wins", ({ Given, And, Then }) => {
      Given('the installation judges with "claude"', () => {
        installation = { provider: 'claude' }
      })
      And('the project judges with "codex"', () => {
        project = { provider: 'codex' }
      })
      Then('the judge\'s provider is "codex"', () => expect(judge().provider).toBe('codex'))
    })

    RuleScenario('A project that names nothing follows the installation', ({
      Given,
      And,
      Then,
    }) => {
      Given('the installation judges with "claude"', () => {
        installation = { provider: 'claude' }
      })
      And('the project names no judge', () => {
        project = {}
      })
      Then('the judge\'s provider is "claude"', () => expect(judge().provider).toBe('claude'))
    })

    RuleScenario('A project that named only a model keeps it and inherits the rest', ({
      Given,
      And,
      Then,
    }) => {
      Given('the installation judges with "claude" using "balanced" at "low"', () => {
        installation = { provider: 'claude', model: 'balanced', effort: 'low' }
      })
      And('the project judges with the model "opus" and nothing else', () => {
        project = { model: 'opus' }
      })
      Then('the judge\'s provider is "claude"', () => expect(judge().provider).toBe('claude'))
      And('the judge\'s model is "opus"', () => expect(judge().model).toBe('opus'))
      And('the judge\'s effort is "low"', () => expect(judge().effort).toBe('low'))
    })

    RuleScenario('With nothing named anywhere the judge is nothing at all', ({
      Given,
      Then,
      And,
    }) => {
      Given('neither the project nor the installation names a judge', () => {
        project = undefined
        installation = undefined
      })
      Then('the judge names no provider', () => expect(judge().provider).toBeUndefined())
      And('the judge names no model', () => expect(judge().model).toBeUndefined())
      And('the judge names no effort', () => expect(judge().effort).toBeUndefined())
    })
  })
})
