#!/usr/bin/env node
import { run } from './main.js'

/**
 * The only module that touches the process. Everything above it is a function
 * of its arguments, which is why the CLI can be specified without spawning.
 */
const result = await run({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  isTty: process.stdout.isTTY === true,
  // Streamed as it arrives. A run's output belongs on screen while it happens,
  // not collected and printed once it is over.
  write: (line) => console.log(line),
  // Handed over rather than reached for, like everything else here. Nothing
  // reads stdin unless `factory mcp` is what was asked for — constructing this
  // attaches no listener, and only iterating it does.
  streams: { input: process.stdin, output: process.stdout, error: process.stderr },
})

for (const line of result.lines) console.log(line)
process.exitCode = result.exitCode
