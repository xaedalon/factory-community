Feature: The command that checks a project's work

  A supervised run of ten tasks produced a `validate` workflow that passed every
  time by asking an agent whether the work was good. It said yes. The
  dependencies were not installed and the test suite had never run — an agent's
  report is a *claim*, and Factory was treating it as a *result*.

  The gate needed to fix that already existed: a shell step whose non-zero exit
  fails the phase and blocks the task. What was missing was anything that knew
  what to run. So a project carries one command, and the built-in
  `project-check` phase is nothing but that command.

  Detected rather than asked for, where a repository says plainly enough what it
  is. Nobody sets a project up by filling in a form they were not expecting —
  and a wrong guess is worse than none, because it is a command they did not
  choose, failing for a reason they have to go and find. So every answer below
  needs positive evidence, and anything else is left empty.

  Rule: a JavaScript project is read from its manifest, not from the machine

    Scenario: A declared test script is the check
      Given a "package.json" declaring the scripts "build, test"
      Then the check command is "npm test"

    Scenario: "check" is preferred to "test" where both exist
      # A project that has both means the difference, and means "check" to be
      # the whole of it.
      Given a "package.json" declaring the scripts "test, check"
      Then the check command is "check"'s, run by the package manager

    Scenario: A manifest with no script to run says nothing
      Given a "package.json" declaring the scripts "build, start"
      Then there is no check command

    Scenario: A manifest with no scripts at all says nothing
      Given a "package.json" with no scripts
      Then there is no check command

    Scenario: A manifest that will not parse says nothing
      # A broken manifest is not evidence of anything, and "npm test" for a
      # project nobody can build is a guess about a repository that is already
      # in trouble.
      Given a "package.json" that is not valid JSON
      Then there is no check command

  Rule: the lockfile decides the package manager

    The lockfile is the only honest answer. What is installed on the machine
    says nothing about what the project expects, and a project run with pnpm
    will not survive `npm test`.

    Scenario Outline: The lockfile names the runner
      Given a "package.json" declaring the scripts "test"
      And the repository also contains "<lockfile>"
      Then the check command is "<command>"

      Examples:
        | lockfile        | command    |
        | pnpm-lock.yaml  | pnpm test  |
        | yarn.lock       | yarn test  |
        | bun.lock        | bun test   |
        | package-lock.json | npm test |

    Scenario: No lockfile falls back to the one that is always there
      Given a "package.json" declaring the scripts "test"
      Then the check command is "npm test"

  Rule: other ecosystems answer for themselves

    Scenario: A Cargo manifest means cargo
      Given the repository contains "Cargo.toml"
      Then the check command is "cargo test"

    Scenario: A Go module means go
      Given the repository contains "go.mod"
      Then the check command is "go test ./..."

    Scenario: A Makefile with a test target means make
      Given a "Makefile" with a "test" target
      Then the check command is "make test"

    Scenario: A Makefile without one says nothing
      # A `test` *variable* is not a target, and running `make test` against a
      # Makefile that has none fails with a message about the Makefile rather
      # than about the work.
      Given a "Makefile" with no "test" target
      Then there is no check command

    Scenario: A JavaScript project with a Makefile is still a JavaScript project
      Given a "package.json" declaring the scripts "test"
      And a "Makefile" with a "test" target
      Then the check command is "npm test"

    Scenario: An empty repository says nothing
      Given a repository with none of those files
      Then there is no check command
