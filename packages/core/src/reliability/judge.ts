/**
 * Which agent reads the work, in one place.
 *
 * Project, then installation, then nothing at all — and "nothing" is a real
 * answer rather than a default to invent. Written as the sibling of
 * `resolveProfile` and for the same reason: two callers deciding this
 * independently is two rules, and the one nobody reads is the one in force.
 *
 * **Per field, not per trio.** Every project that named a model before a
 * provider could be named has no provider, so its model must inherit nothing
 * while its provider inherits the installation's. A whole-trio rule would have
 * silently stopped judging exactly those projects on upgrade, which is the kind
 * of migration nobody notices until a score stops moving.
 */
export interface JudgeChoice {
  // `| undefined` on each, so a zod-parsed settings group — whose optional
  // fields are `string | undefined` under `exactOptionalPropertyTypes` — is a
  // valid source without being copied field by field first.
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly effort?: string | undefined
}

export function resolveJudge(sources: {
  readonly project?: JudgeChoice | undefined
  readonly installation?: JudgeChoice | undefined
}): JudgeChoice {
  const pick = (key: keyof JudgeChoice): string | undefined =>
    sources.project?.[key] ?? sources.installation?.[key]
  const provider = pick('provider')
  const model = pick('model')
  const effort = pick('effort')
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  }
}
