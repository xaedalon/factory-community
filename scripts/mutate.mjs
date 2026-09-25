#!/usr/bin/env node
/**
 * Break one line on purpose, run the scenarios, and say which of them noticed.
 *
 * Every increment's commit message lists the mutations that were made and
 * watched to fail, and until now that was the only record: the practice lived
 * in a habit and in eighteen commit messages, which is not something a new
 * contributor can repeat. This makes it a command.
 *
 *   node scripts/mutate.mjs \
 *     --file packages/store/src/projects.ts \
 *     --find "if ((counts?.total ?? 0) > 0) {" \
 *     --replace "if (false) {" \
 *     --suite packages/store
 *
 * A batch, which is how a round of them is usually run:
 *
 *   node scripts/mutate.mjs --from mutations.json
 *
 * where the file is `[{ file, find, replace, suite?, describe? }, ...]`.
 *
 * The exit code is the useful part: 0 when every mutation was caught, 1 when
 * any survived or could not be applied — a mutation nobody ran is not a
 * mutation that passed. A surviving mutation is not necessarily a missing
 * scenario: it can be an equivalent mutant, which the report says to check.
 *
 * The file is restored by a `finally` and by handlers for SIGINT and SIGTERM,
 * because a script that edits source and is interrupted must not leave the
 * working tree mutated. That is the same reason `verify-standalone.sh` restores
 * `factory-pro/` from an EXIT trap.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const args = parse(process.argv.slice(2))
const mutations =
  args.from === undefined
    ? [{ file: args.file, find: args.find, replace: args.replace ?? '', suite: args.suite }]
    : JSON.parse(readFileSync(args.from, 'utf8'))

if (mutations.some((entry) => entry.file === undefined || entry.find === undefined)) {
  console.error('Each mutation needs a --file and a --find. See the top of this file.')
  process.exit(2)
}

const results = []
for (const mutation of mutations) results.push(run(mutation))

console.log('')
const MARKS = { caught: '✓ caught   ', survived: '✗ SURVIVED ', 'not-applied': '· not applied' }
for (const result of results) {
  console.log(`${MARKS[result.status]} ${result.describe}`)
  if (result.status === 'survived') {
    console.log(
      '            Nothing failed. Either a scenario is missing, or the mutant is equivalent —',
    )
    console.log('            say which in the commit message, and why.')
  }
}
const caught = results.filter((result) => result.status === 'caught').length
console.log('')
console.log(`${caught}/${results.length} caught.`)
// Non-zero for a survivor and for one that could not be applied: a mutation
// nobody ran is not a mutation that passed.
process.exit(caught === results.length ? 0 : 1)

function run(mutation) {
  const describe = mutation.describe ?? `${mutation.file}: ${short(mutation.find)}`
  const original = readFileSync(mutation.file, 'utf8')
  const occurrences = original.split(mutation.find).length - 1
  if (occurrences !== 1) {
    console.error(
      `\n${describe}\n  "find" matches ${occurrences} times in ${mutation.file}; ` +
        `it has to match exactly once. Add enough surrounding text to make it unique.`,
    )
    return { describe, status: 'not-applied' }
  }

  const restore = () => writeFileSync(mutation.file, original)
  const onSignal = () => {
    restore()
    process.exit(130)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    console.log(`\n── ${describe}`)
    writeFileSync(mutation.file, original.replace(mutation.find, mutation.replace ?? ''))
    const suite = mutation.suite ?? args.suite
    const outcome = spawnSync(
      'npx',
      ['vitest', 'run', ...(suite === undefined ? [] : [suite])],
      { stdio: 'inherit' },
    )
    // Non-zero means something failed, which for a mutation is the point.
    return { describe, status: outcome.status === 0 ? 'survived' : 'caught' }
  } finally {
    restore()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

function short(text) {
  const line = text.trim().split('\n')[0]
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

function parse(list) {
  const out = {}
  for (let index = 0; index < list.length; index += 1) {
    const key = list[index]
    if (!key.startsWith('--')) continue
    out[key.slice(2)] = list[index + 1]
    index += 1
  }
  return out
}
