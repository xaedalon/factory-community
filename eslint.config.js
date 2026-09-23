// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Two rules here are load-bearing architecture, not style.
 *
 *  1. The open-core boundary. Community must never import commercial code.
 *     pnpm-workspace.yaml already makes it unresolvable; this makes it a lint
 *     error too, so the intent is visible at the point of violation.
 *
 *  2. The single path resolver. The prototype computed paths from two disagreeing
 *     anchors (a __dirname climb and process.cwd()) in ~19 places, which
 *     coincided only under systemd. Every path in Factory flows from
 *     packages/config/src/scopes.ts, and nothing else may ask the OS directly.
 */
const PRO_IMPORT_BAN = {
  patterns: [
    {
      group: ['@factory-pro/*', '**/factory-pro/**', '../../../factory-pro/**'],
      message:
        'The open core must not import commercial code. Community has to build, test and run ' +
        'with factory-pro/ deleted. If Pro needs something from core, widen the public API in ' +
        '@factory/plugin-sdk instead — that is the contract a third-party plugin uses too.',
    },
  ],
}

const RESOLVER_ONLY =
  ' is only allowed in packages/config/src/scopes.ts. Take the resolved ScopeChain as a' +
  ' parameter instead — see §5 of the plan.'

// Both call shapes, because `homedir()` via a named import is the common one
// and `os.homedir()` is the other. Missing either would leave the rule
// decorative.
const OS_PATH_BAN = [
  {
    selector: "CallExpression[callee.object.name='process'][callee.property.name='cwd']",
    message: `process.cwd()${RESOLVER_ONLY}`,
  },
  {
    selector: "CallExpression[callee.property.name='homedir']",
    message: `os.homedir()${RESOLVER_ONLY}`,
  },
  {
    selector: "CallExpression[callee.name='homedir']",
    message: `homedir()${RESOLVER_ONLY}`,
  },
  {
    selector: "CallExpression[callee.property.name='tmpdir']",
    message: `os.tmpdir()${RESOLVER_ONLY}`,
  },
  {
    selector: "CallExpression[callee.name='tmpdir']",
    message: `tmpdir()${RESOLVER_ONLY}`,
  },
  // The same rule, for the same reason, and the omission that cost the most.
  // Everything below an entry point receives its environment rather than
  // reaching for it — which is what makes the CLI exercisable without spawning
  // a process, and what keeps a plugin testable on a machine it is not running
  // on. The runner spawned every agent with the daemon's full environment for
  // sixteen increments because it read `process.env` itself; the call site was
  // fixed, and this is what stops it coming back.
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message:
      'process.env is only read at an entry point. Take the environment as a parameter — ' +
      'every module below bin.ts already does, which is why they can be tested.',
  },
]

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', '**/.features-gen/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', PRO_IMPORT_BAN],
      'no-restricted-syntax': ['error', ...OS_PATH_BAN],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Allow the conventional underscore prefix, which is how a destructuring
      // rest is used to drop a key: `const { onFail: _drop, ...rest } = value`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The one module allowed to ask the operating system where things are.
    files: ['packages/config/src/scopes.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Process entry points. Reading argv, cwd and env here and passing them
    // down is exactly the shape the rule protects: everything below an entry
    // point receives its environment rather than reaching for it, which is why
    // the whole CLI can be exercised without spawning a process.
    files: ['**/src/bin.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Maintenance scripts, which are entry points: they are the process, and
    // `console` is how they report. Run by hand and by `pnpm mutate`, never
    // imported by anything.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Build and test tooling, which runs before any of this exists: a vite
    // config has no runtime to receive an environment from.
    files: ['**/*.config.ts', '**/*.config.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Specs legitimately need a temp directory to build scope trees in. The
    // rule is about production path resolution flowing from one place; a test
    // creating its own fixture is not that. Production code under src/ is
    // still covered.
    files: ['**/features/**/*.ts', '**/*.spec.ts', '**/*.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
)
