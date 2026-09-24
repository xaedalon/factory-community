import { z } from 'zod'
import type { Evidence, LogLine, Run, RunStep } from '@factory/core'
import { defineTool, type McpTool } from '../tool.js'
import { asToolError } from '../errors.js'
import { briefRun } from './tasks.js'

/**
 * Runs, over MCP.
 *
 * A run is where the evidence is, and evidence is the reason somebody opens a
 * run they did not watch — so it arrives with the run rather than behind
 * another call, exactly as the route already returns it.
 *
 * Logs are bounded, and a log that lost its middle says so. A truncated log
 * that reads like a complete one is how an agent concludes a build passed.
 */

interface RunDetail {
  readonly run: Run
  readonly steps: readonly RunStep[]
  readonly evidence: readonly Evidence[]
}

interface LogView {
  readonly lines: readonly LogLine[]
  readonly dropped: number
}

/** Enough to read, small enough not to fill a context window with one call. */
const DEFAULT_TAIL = 200

export const runTools: readonly McpTool[] = [
  defineTool({
    name: 'factory_run_get',
    title: 'One run',
    description:
      'A run with its steps and the evidence it produced. Use it to find out what happened, ' +
      'and which step to read the logs of.',
    schema: z.object({ run: z.string().describe('The run id.') }),
    run: async (input, { api }) => {
      let detail: RunDetail
      try {
        detail = await api.request<RunDetail>(`/api/runs/${encodeURIComponent(input.run)}`)
      } catch (error) {
        throw asToolError(error, 'RUN_NOT_FOUND')
      }
      return {
        ...briefRun(detail.run),
        ...(detail.run.taskId === undefined ? {} : { task: detail.run.taskId }),
        steps: detail.steps.map((step) => ({
          id: step.id,
          phase: step.phase,
          describe: step.describe,
          uses: step.uses,
          state: step.state,
          ...(step.exitCode === undefined ? {} : { exitCode: step.exitCode }),
          attempts: step.attempts,
          ...(step.detail === undefined ? {} : { detail: step.detail }),
        })),
        // Names and sizes, not contents. Five artifacts of Markdown is tens of
        // kilobytes, and the run detail is the listing rather than the reading.
        evidence: detail.evidence.map((item) => ({
          name: item.name,
          phase: item.phase,
          path: item.path,
          bytes: item.bytes,
          truncated: item.truncated,
          missing: item.missing,
        })),
      }
    },
  }),

  defineTool({
    name: 'factory_run_logs',
    title: 'What a run printed',
    description:
      'The tail of a run\u2019s output. Always bounded, and lines say which step printed them. ' +
      'If the daemon had to drop the middle of a log to stay inside its budget, the reply says ' +
      'how much.',
    schema: z.object({
      run: z.string().describe('The run id.'),
      step: z.number().int().optional().describe('Only this step, by its id from factory_run_get.'),
      tail: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe(`The last N lines. Default ${DEFAULT_TAIL}.`),
    }),
    run: async (input, { api }) => {
      const tail = input.tail ?? DEFAULT_TAIL
      const ask = async (step?: number): Promise<LogView> => {
        const query = step === undefined ? '' : `?step=${step}`
        try {
          return await api.request<LogView>(
            `/api/runs/${encodeURIComponent(input.run)}/logs${query}`,
          )
        } catch (error) {
          throw asToolError(error, 'RUN_NOT_FOUND')
        }
      }

      if (input.step !== undefined) {
        const view = await ask(input.step)
        return shape(input.run, view.lines, view.dropped, tail, input.step)
      }

      // Without a step, one request answers almost nothing: a run's own log
      // holds what the engine wrote, and everything a command printed is
      // attached to the step that printed it. So the steps are walked, which is
      // what `factory task logs` does for a person and for the same reason —
      // a line with no step beside it is a line nobody can place.
      let detail: RunDetail
      try {
        detail = await api.request<RunDetail>(`/api/runs/${encodeURIComponent(input.run)}`)
      } catch (error) {
        throw asToolError(error, 'RUN_NOT_FOUND')
      }

      const collected: (LogLine & { step?: number; phase?: string })[] = []
      let dropped = (await ask()).dropped
      for (const line of (await ask()).lines) collected.push(line)
      for (const step of detail.steps) {
        const view = await ask(step.id)
        dropped += view.dropped
        for (const line of view.lines) {
          collected.push({ ...line, step: step.id, phase: step.phase })
        }
      }
      return shape(input.run, collected, dropped, tail)
    },
  }),
]

/**
 * The tail, and an honest account of what is missing from it.
 *
 * Two different losses, and conflating them is a lie in one direction or the
 * other: `droppedByFactory` is what the daemon's log budget discarded from the
 * middle, `older` is what this call asked not to be sent. A truncated log that
 * reads like a complete one is how an agent concludes a build passed.
 */
const shape = (
  run: string,
  lines: readonly (LogLine & { step?: number; phase?: string })[],
  dropped: number,
  tail: number,
  step?: number,
) => {
  const kept = lines.slice(-tail)
  return {
    run,
    ...(step === undefined ? {} : { step }),
    lines: kept.map((line) => ({
      stream: line.stream,
      text: line.text,
      ...(line.step === undefined ? {} : { step: line.step }),
      ...(line.phase === undefined ? {} : { phase: line.phase }),
    })),
    droppedByFactory: dropped,
    older: Math.max(lines.length - kept.length, 0),
  }
}
