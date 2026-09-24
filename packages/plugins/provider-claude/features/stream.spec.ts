import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { StreamEvent, StreamReader } from '@factory/core'
import { claudeStream } from '../src/stream.js'

const feature = await loadFeature(fileURLToPath(new URL('./stream.feature', import.meta.url)))

/**
 * The events, built the way the CLI emits them.
 *
 * Written as a helper rather than pasted per scenario so that the *shape* lives
 * in one place: if 2.1.x moves a field, one edit here fails every scenario that
 * depends on it, rather than a handful passing on stale JSON.
 */
const TOOL_USE_ID = 'toolu_013ecPNvQ3cyGnTf2BZM1Ch2'

/** The CLI's own words, verbatim from the run on 2026-09-24. Abbreviated only at the end. */
const DENIAL_MESSAGE =
  'Permission for this tool use was denied. It requires approval, and this session has no ' +
  'approval surface — nobody can answer a permission prompt here — so it was denied ' +
  'automatically. The action was NOT performed; do not claim it succeeded.'

const line = (value: unknown): string => `${JSON.stringify(value)}\n`

const toolUse = (tool: string, input: Record<string, unknown>): string =>
  line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: TOOL_USE_ID, name: tool, input }],
    },
  })

const permissionDenied = (id = TOOL_USE_ID): string =>
  line({ type: 'system', subtype: 'permission_denied', tool_use_id: id, message: DENIAL_MESSAGE })

const toolResult = (text: string, isError: boolean): string =>
  line({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: text, is_error: isError }],
    },
  })

const assistantText = (text: string): string =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

describeFeature(feature, ({ Rule, BeforeEachScenario }) => {
  let reader: StreamReader
  let events: StreamEvent[]

  BeforeEachScenario(() => {
    reader = claudeStream()
    events = []
  })

  const feed = (text: string): void => {
    events.push(...reader.push(text))
  }
  const close = (): void => {
    events.push(...reader.end())
  }

  const logged = (stream: 'stdout' | 'stderr'): string =>
    events
      .filter((event) => event.log?.stream === stream)
      .map((event) => event.log?.text ?? '')
      .join('')
  const scanned = (): string => events.map((event) => event.scan ?? '').join('\n')
  const refusals = (): readonly NonNullable<StreamEvent['refused']>[] =>
    events.flatMap((event) => (event.refused === undefined ? [] : [event.refused]))

  const wrote = (text: string) => (): void => feed(assistantText(text))
  const ran = (command: string, tool: string) => (): void => feed(toolUse(tool, { command }))
  const denied = (): void => {
    feed(permissionDenied())
    close()
  }
  const logHas = (text: string, stream: 'stdout' | 'stderr') => (): void => {
    expect(logged(stream)).toContain(text)
  }
  const oneRefusal = (): void => expect(refusals()).toHaveLength(1)

  Rule("the agent's prose still reaches the log", ({ RuleScenario }) => {
    RuleScenario('A text block is logged as it was written', ({ When, Then }) => {
      When(
        'the stream says the agent wrote "Installed 412 packages."',
        wrote('Installed 412 packages.'),
      )
      Then(
        'the log has "Installed 412 packages." on stdout',
        logHas('Installed 412 packages.', 'stdout'),
      )
    })

    RuleScenario('The log is what the denial patterns already read', ({ When, Then }) => {
      When(
        'the stream says the agent wrote "Installed 412 packages."',
        wrote('Installed 412 packages.'),
      )
      Then('"Installed 412 packages." was offered to the denial scanner', () =>
        expect(scanned()).toContain('Installed 412 packages.'),
      )
    })
  })

  Rule('a refused command is reported as a refusal, with the command', ({ RuleScenario }) => {
    RuleScenario('A denied Bash call names what it was denied', ({ Given, When, Then, And }) => {
      Given('the stream ran "git --version" as "Bash"', ran('git --version', 'Bash'))
      When('that call is denied', denied)
      Then('one refusal was reported', oneRefusal)
      And('the command it names is "git --version"', () =>
        expect(refusals()[0]?.command).toBe('git --version'),
      )
      And('the tool it names is "Bash"', () => expect(refusals()[0]?.tool).toBe('Bash'))
      // The CLI's own sentence, not a paraphrase of it. That distinction is
      // the reason this file exists rather than another wording pattern.
      And('it carries the CLI\'s own words', () =>
        expect(refusals()[0]?.evidence).toBe(DENIAL_MESSAGE),
      )
    })

    RuleScenario('The denial is visible in the log as well as reported', ({ Given, When, Then }) => {
      Given('the stream ran "pnpm install" as "Bash"', ran('pnpm install', 'Bash'))
      When('that call is denied', denied)
      // The refusal's own line. `toContain('pnpm install')` would also match
      // the trace line the tool call already wrote, and would keep passing
      // with the refusal removed entirely.
      Then('the log says "pnpm install" was refused', () =>
        expect(logged('stderr')).toContain('refused — pnpm install'),
      )
    })

    RuleScenario('A denied tool that ran no command still reports', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('the stream used the "WebFetch" tool with no command', () =>
        feed(toolUse('WebFetch', { url: 'https://example.invalid' })),
      )
      When('that call is denied', denied)
      Then('one refusal was reported', oneRefusal)
      And('it names no command', () => expect(refusals()[0]?.command).toBeUndefined())
      And('the tool it names is "WebFetch"', () => expect(refusals()[0]?.tool).toBe('WebFetch'))
    })

    RuleScenario('A denial for a call the reader never saw still reports', ({
      When,
      Then,
      And,
    }) => {
      When('a call the reader never saw is denied', () => {
        feed(permissionDenied('toolu_never_seen'))
        close()
      })
      Then('one refusal was reported', oneRefusal)
      And('it names no command', () => expect(refusals()[0]?.command).toBeUndefined())
    })
  })

  Rule('an ordinary failure is not a refusal', ({ RuleScenario }) => {
    RuleScenario('The events a run is mostly made of are not refusals', ({ When, Then }) => {
      When('the stream reports the system events an ordinary run emits', () => {
        feed(line({ type: 'system', subtype: 'init' }))
        feed(line({ type: 'system', subtype: 'thinking_tokens' }))
        feed(line({ type: 'rate_limit_event' }))
        feed(line({ type: 'result', subtype: 'success', is_error: false }))
        close()
      })
      Then('no refusal was reported', () => expect(refusals()).toEqual([]))
    })

    RuleScenario('A command that exits non-zero is not a refusal', ({ Given, When, Then }) => {
      Given('the stream ran "pnpm test" as "Bash"', ran('pnpm test', 'Bash'))
      When('that call fails with "1 test failed"', () => {
        feed(toolResult('1 test failed', true))
        close()
      })
      Then('no refusal was reported', () => expect(refusals()).toEqual([]))
    })

    RuleScenario('A tool result is read for refusals even though it is not logged', ({
      Given,
      When,
      Then,
      And,
    }) => {
      const refusedPath = '/tmp/probe.txt is outside the configured working directories'
      Given('the stream ran "cat outside.txt" as "Bash"', ran('cat outside.txt', 'Bash'))
      When(`that call fails with "${refusedPath}"`, () => {
        feed(toolResult(refusedPath, true))
        close()
      })
      Then(`"${refusedPath}" was offered to the denial scanner`, () =>
        expect(scanned()).toContain(refusedPath),
      )
      And('the log has nothing on stdout', () => expect(logged('stdout')).toBe(''))
    })
  })

  Rule('output that is not the format is not lost', ({ RuleScenario }) => {
    RuleScenario('A line that is not JSON passes through', ({ When, Then }) => {
      When('the output is the line "npm warn Unknown project config"', () => {
        feed('npm warn Unknown project config\n')
        close()
      })
      Then(
        'the log has "npm warn Unknown project config" on stdout',
        logHas('npm warn Unknown project config', 'stdout'),
      )
    })

    RuleScenario('An event split across two chunks is still read', ({ Given, When, Then, And }) => {
      Given('the stream ran "pnpm install" as "Bash"', () => {
        // Nothing fed yet: this scenario delivers both events character by
        // character, which is the point of it.
      })
      When('that call is denied, delivered one character at a time', () => {
        const text = toolUse('Bash', { command: 'pnpm install' }) + permissionDenied()
        for (const character of text) feed(character)
        close()
      })
      Then('one refusal was reported', oneRefusal)
      And('the command it names is "pnpm install"', () =>
        expect(refusals()[0]?.command).toBe('pnpm install'),
      )
    })

    RuleScenario('A last line with no newline is read when the process closes', ({
      When,
      Then,
    }) => {
      When('the output ends mid-line with the agent writing "Done."', () => {
        feed(assistantText('Done.').replace(/\n$/, ''))
        close()
      })
      Then('the log has "Done." on stdout', logHas('Done.', 'stdout'))
    })
  })
})
