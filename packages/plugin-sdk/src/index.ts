/**
 * @factory/plugin-sdk — everything a plugin needs, and nothing else.
 *
 * This is the whole contract. A third-party package, the built-in step kinds,
 * the provider plugins, and Xaedalon Factory Pro all import from here and from
 * nowhere deeper. If Pro ever needs something that is not reachable through
 * this module, the answer is to widen this module — so a third party gets it
 * too — never to let Pro reach into core.
 *
 * That is the difference between "commercial editions add capabilities" as a
 * design principle and as something the build can actually check.
 */

// --- the plugin contract -----------------------------------------------
export type {
  Capability,
  CapabilityKind,
  CapabilityLookup,
  FactoryPlugin,
  PluginContext,
  RegisteredCapability,
  WellKnownCapabilityKind,
} from '@factory/core'
export { CapabilityError, CAPABILITY_ID_PATTERN } from '@factory/core'

// --- reacting to what Factory does --------------------------------------
export type { FactoryEvent, FactoryEventName, FactoryEvents } from '@factory/events'

// --- exercising a plugin -------------------------------------------------
//
// A plugin author has to be able to load their plugin and drive it, or the
// only way to test one is to reach into core — which is precisely what this
// package exists to prevent. Added when factory-pro's own suite could not
// build a host without importing past the SDK.
export { CapabilityHost } from '@factory/core'
export { EventBus } from '@factory/events'

// --- influencing what Factory does --------------------------------------
export type {
  DefinitionUnderValidation,
  DefinitionWrite,
  HookHandler,
  HookName,
  TransformOutcome,
} from '@factory/core'
export { keep, reject } from '@factory/core'

// --- reporting ----------------------------------------------------------
export type { Problem, ProblemSeverity } from '@factory/core'
export { formatProblem, isClean } from '@factory/core'

// --- contributing a step kind -------------------------------------------
export type { Step, StepKindCapability } from '@factory/core'
export { defineStepKind, STEP_KIND } from '@factory/core'
export { closedWithExtensions, slug, variables } from '@factory/core'

// --- contributing a provider --------------------------------------------
export type {
  Availability,
  ProviderCapability,
  ProviderDescriptor,
  ProviderFeature,
  RenderRequest,
  RenderedCommand,
  SessionMode,
} from '@factory/core'
export {
  PROVIDER_FEATURES,
  PROVIDER_KIND,
  parseProviderDescriptor,
  providerFromDescriptor,
  toShellString,
} from '@factory/core'

// --- reading a provider's structured output ------------------------------
//
// The one part of a provider that cannot be a YAML file: a transcript format
// is a parser. It is here rather than in core's own switch because what
// `--output-format stream-json` means is Claude Code's business, and a third
// party shipping a provider must be able to read its own CLI's events without
// a core change. `LineBuffer` comes with it because every line-delimited
// format needs the same three lines, and getting them wrong is invisible until
// a chunk boundary lands mid-object.
export type { RefusedAction, StreamEvent, StreamReader, StreamReaderFactory } from '@factory/core'
export { LineBuffer } from '@factory/core'

// --- contributing a setup step ------------------------------------------
//
// Widened for the same reason as the diagnostic below: Pro knows whether it is
// licensed and wanted to say so on the setup list. Any plugin with setup of its
// own — an API token, a service to start — reaches it through the same door.
export type { SetupAction, SetupContext, SetupItem, SetupReport, SetupState, SetupStepCapability } from '@factory/core'
export { SETUP_STEP_KIND, runSetup } from '@factory/core'

// --- contributing a terminal --------------------------------------------
//
// Opening a terminal where a task's work is means starting a platform-specific
// application, and factory-community contains no platform detection anywhere —
// a property worth keeping. So core contracts it and consumes nothing: Pro's
// desktop plugin registers one, and anyone shipping an integration for their
// own terminal reaches the same contract through this door.
export type { TerminalCapability, TerminalOutcome, TerminalRequest } from '@factory/core'
export { TERMINAL_KIND, terminalCommand } from '@factory/core'

// --- contributing a button on a task ------------------------------------
//
// "Open terminal" and "Open session" were two buttons written into the board,
// their commands resolved by name inside a route. They are plugins now, and so
// is the diff viewer that would have been the third — which means the fourth
// can be somebody else's.
//
// A tool answers with a directory and, optionally, argv. It never spawns
// anything and never learns what is installed to perform it, so the same tool
// works where a terminal can be opened and where it cannot.
export type {
  TaskToolCapability,
  TaskToolContext,
  TaskToolOffer,
  TaskToolRun,
  TaskToolView,
} from '@factory/core'
export { TASK_TOOL_KIND, taskToolOffers } from '@factory/core'

// --- what a tool is looking at ------------------------------------------
//
// A plugin contributing a task tool is handed a task and where its work is, and
// could not name either: none of these three was reachable through the SDK.
// Widened for the first plugin that needed them, which is how this has gone
// every time.
export type { Project, Task, TaskWorkspace, Workspace } from '@factory/core'

// --- finding the tool a plugin drives -----------------------------------
//
// `commandAvailability` is the provider probe with the provider taken out of it
// — "is this on PATH, and if not, where did you look" — asked for by the
// diffity plugin, which needs the same answer about its own binary. The other
// two were already in core and not in here, which guaranteed a fourth copy of
// the three-place search the moment a plugin wanted to *run* what it found.
export { commandAvailability, knownToolDirectories, resolveCommand } from '@factory/core'

// --- resuming an agent's session ----------------------------------------
//
// The session-tool plugin builds `claude --resume <id>` from what the engine
// recorded, and that flag comes from the provider's own descriptor rather than
// from a string in a plugin.
export { resumeById } from '@factory/core'

// --- contributing a diagnostic ------------------------------------------
//
// Added because factory-pro wanted to contribute a doctor rule and could not
// reach the contract, which lives in @factory/config. That is the rule working:
// when a commercial edition needs something the SDK does not expose, the answer
// is to widen the SDK — so a third party gets it too — never to let Pro import
// past it. See PROJECT.md, binding rule 3.
export type { DoctorContext, DoctorRuleCapability } from '@factory/config'
export { DOCTOR_RULE_KIND } from '@factory/config'

// --- where a scope lives ------------------------------------------------
//
// A plugin that keeps a file of its own beside the user's definitions — a
// licence, a cache — needs to know where that is, and duplicating the literal
// is how the two drift the next time it moves. Same rule as above: widen the
// SDK rather than let anything reach past it.
export { LEGACY_SCOPE_DIR, SCOPE_CONFIG_FILE, SCOPE_DIR, userScopeRoot } from '@factory/config'

// --- judging how much to trust a task ------------------------------------
//
// Factory owns the arithmetic and an evaluator owns the reading. The contract
// is here rather than in core's own registry because an evaluator that only
// core could write is a subsystem with one supplier: a provider vendor who
// knows how to read their own model's output, or a team with a house rule
// about what counts as evidence, reaches the same door the built-in one uses.
//
// Note what is not exported: nothing that sets a score. There is no such field
// on `EvaluatorOutput` and no capability that could carry one.
export type {
  DimensionAssessment,
  EvaluatorAgent,
  EvaluatorInput,
  EvaluatorOutput,
  NormalizationNote,
  NormalizedEvaluation,
  Observation,
  ObservationKind,
  ObservationStatus,
  ProposedFinding,
  ReliabilityDimension,
  ReliabilityDriver,
  ReliabilityEvaluatorCapability,
  ReliabilityPolicy,
} from '@factory/core'
export {
  DEFAULT_RELIABILITY_POLICY,
  RELIABILITY_DIMENSIONS,
  RELIABILITY_EVALUATOR_KIND,
  normalize,
} from '@factory/core'

// --- proving a plugin conforms ------------------------------------------
export type { ConformanceCheck, ConformanceReport } from '@factory/core'
export { assertPluginConformance, checkPluginConformance } from '@factory/core'

export { defineProviderPlugin } from './provider-plugin.js'
