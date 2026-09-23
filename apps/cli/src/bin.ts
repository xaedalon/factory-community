#!/usr/bin/env node
import { run } from './main.js'

/**
 * The only module that touches the process. Everything above it is a function
 * of its arguments, which is why the CLI can be specified without spawning.
 *
 * It reports facts about the process and decides nothing with them — including
 * whether stdin is a terminal, which `factory mcp` needs and which only this
 * module can see.
 */
const result = await run({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  isTty: process.stdout.isTTY === true,
  stdinIsTty: process.stdin.isTTY === true,
  // Streamed as it arrives. A run's output belongs on screen while it happens,
  // not collected and printed once it is over.
  write: (line) => console.log(line),
  streams: { input: process.stdin, output: process.stdout, error: process.stderr },
})

for (const line of result.lines) console.log(line)
process.exitCode = result.exitCode
