Feature: Agent providers
  A step names an agent, its configuration and its prompt; the provider turns
  that into a command. Which agent is a phase's choice or the configuration's —
  Factory never requires you to buy inference from Factory.

  A provider is a descriptor, not a class. All three that ship are a YAML file
  and one call, so adding a fourth agent needs no code — which is what provider
  independence has to mean if it means anything. It also puts model ids in data,
  where they belong: they move faster than releases, and a fix should be a
  one-line edit rather than a rebuild.

  Background:
    Given the claude, codex and copilot providers are registered

  Scenario: The registered providers are discoverable
    Then the host has a "provider" capability "claude"
    And the host has a "provider" capability "codex"
    And the host has a "provider" capability "copilot"

  Scenario: A model role resolves to the provider's own identifier
    Then "strong" resolves to "opus" for "claude"
    And "strong" resolves to "claude-opus-5.5" for "copilot"

  Scenario: Copilot dots a model's minor version rather than hyphenating it
    # Both of these were once hyphenated. `claude-opus-5-5` was refused outright
    # — "Model ... from --model flag is not available" — and `claude-haiku-4-5`
    # would have been, the first time anybody asked for the fast role. GitHub's
    # own SDK documents the form: `e.g. "claude-haiku-4.5"`.
    Then "fast" resolves to "claude-haiku-4.5" for "copilot"
    And "balanced" resolves to "claude-sonnet-5" for "copilot"

  Scenario: A literal model identifier passes through untouched
    Then "claude-fable-5" resolves to "claude-fable-5" for "claude"

  Scenario: Rendering a step produces the command claude actually takes
    Given an agent step with the prompt "Analyse WW2-1234"
    And the step asks for model "strong" and effort "max"
    When it is rendered for "claude"
    Then the command is "claude"
    And the arguments include "--restricted"
    And the arguments include "--model opus"
    And the arguments include "--effort max"
    And the prompt is the last argument
    And stdin is redirected from "/dev/null"

  Scenario: A sub-agent is passed as a flag
    Given an agent step with the prompt "Analyse WW2-1234"
    And the step asks for the sub-agent "deep-researcher"
    When it is rendered for "claude"
    Then the arguments include "--agent deep-researcher"

  Scenario: A step with no session gets no session arguments
    Given an agent step with the prompt "One shot"
    When it is rendered for "claude"
    Then the arguments do not include "--session-id"
    And it reports no session

  Scenario: A prompt containing quotes needs no escaping
    Given an agent step with the prompt "Fix the \"broken\" test; don't guess"
    When it is rendered for "claude"
    Then the prompt is passed as a single argument

  Scenario: A setting the provider does not have is a warning, not silence
    Given an agent step with the prompt "Analyse"
    And the step asks for effort "max"
    When the step is checked against "copilot"
    Then there is a warning about effort

  Scenario: Asking to carry a session on a provider that cannot is a warning
    Given an agent step with the prompt "Analyse"
    And the step carries a session with the identity "run-42"
    When the step is checked against "codex"
    Then there is a warning about sessions

  Scenario: An unverified descriptor says so
    Given an agent step with the prompt "Analyse"
    When the step is checked against "codex"
    Then there is a warning that the descriptor is unverified

  Scenario: A verified descriptor does not claim to be unverified
    Given an agent step with the prompt "Analyse"
    When the step is checked against "claude"
    Then there is no warning that the descriptor is unverified

  Scenario: Availability reports whether the executable is really there
    Then "claude" is available when its directory is on PATH
    And "claude" is unavailable when PATH is empty
    And the unavailable reason names the command

  Scenario Outline: Every provider plugin passes the conformance suite
    When the "<provider>" plugin is checked for conformance
    Then the plugin conforms

    Examples:
      | provider |
      | claude   |
      | codex    |
      | copilot  |

  Rule: starting a session and continuing one are different commands

    Factory chooses the id, which is what makes a session resumable exactly —
    by the next phase, by a re-run, and by a person opening a terminal. The
    alternative it replaced was "continue the most recent conversation in this
    directory", which is the wrong conversation the moment two tasks share a
    directory and, for Claude, is not reachable interactively at all.

    Choosing the id means Factory has to know which of two commands to render.
    `--session-id` refuses an id that already exists and `--resume` refuses one
    that does not, so a descriptor says both and this decides between them. A
    CLI with one flag for both says one, and the other falls back to it.

    Scenario: Starting a session names it
      Given an agent step with the prompt "Analyse"
      And the step carries a session with the identity "run-42"
      When it is rendered for "claude"
      Then the arguments include "--session-id run-42"
      And it reports starting the session "run-42"

    Scenario: Continuing one resumes it by that id
      Given an agent step with the prompt "Continue"
      And the step carries a session with the identity "run-42"
      And the session already exists
      When it is rendered for "claude"
      Then the arguments include "--resume run-42"
      And the arguments do not include "--session-id"
      And it reports continuing the session "run-42"

    Scenario: One flag that does both is used for both
      Given an agent step with the prompt "Continue"
      And the step carries a session with the identity "run-42"
      And the session already exists
      # Copilot's `--session-id` sets the UUID of a new session *and* resumes
      # one, so its descriptor names no separate resume flag and this falls
      # back rather than rendering nothing.
      When it is rendered for "copilot"
      Then the arguments include "--session-id run-42"

    Scenario: A provider that cannot carry a session gets no id
      Given an agent step with the prompt "Continue"
      And the step carries a session with the identity "run-42"
      When it is rendered for "codex"
      Then the arguments do not include "run-42"
      # Which is what stops anything recording a session that was never made.
      And it reports no session

    Scenario: A session scope of none carries no id either
      Given an agent step with the prompt "One shot"
      And the step is given the identity "run-42" but no session scope
      When it is rendered for "claude"
      Then the arguments do not include "run-42"
      And it reports no session

    Scenario: An id nobody supplied renders no flag at all
      Given an agent step with the prompt "Continue"
      And the step carries a session with no identity
      # A flag with nothing after it would swallow the next argument.
      When it is rendered for "claude"
      Then the arguments do not include "--session-id"
      And it reports no session

  Rule: the profile decides what the CLI is allowed to do

    One field, read in one place — the first elements of the rendered argv. That
    is what makes a profile real rather than advisory, and why no second place
    is allowed to decide.

    Every flag below was measured against Claude Code 2.1.273 rather than read
    out of `--help`, because two configurations that read correctly did nothing
    useful: `--tools default` left the session with no Bash at all, and
    `--permission-mode dontAsk` denied every write.

    Scenario: The Default profile confines the agent and never waits
      Given an agent step with the prompt "Analyse WW2-1234"
      When it is rendered for "claude" under "default"
      Then the arguments include "--restricted"
      And the arguments name the tools the agent needs
      And the arguments include "--permission-prompts none"
      And the arguments do not include "bypassPermissions"

    Scenario: The Default profile lets the agent run the project's package manager
      # Measured on 2.1.281: `--tools` still grants Bash, but `acceptEdits`
      # auto-approves edits and not commands, so `pnpm install` needed approval
      # and `--permission-prompts none` denied it. An agent that cannot run
      # your tests writes a report full of ticks instead.
      Given an agent step with the prompt "Analyse WW2-1234"
      When it is rendered for "claude" under "default"
      Then the arguments allow "pnpm"
      And the arguments allow "npm"

    Scenario: No interpreter is on the allow-list
      # `--restricted` confines Factory's file tools and the shell's own
      # redirection. It cannot confine what a child process does with its own
      # syscalls, so `Bash(node *)` hands that command the whole filesystem —
      # measured: `node -e writeFileSync('/tmp/x')` wrote the file.
      Given an agent step with the prompt "Analyse WW2-1234"
      When it is rendered for "claude" under "default"
      Then the arguments do not allow "node"
      And the arguments do not allow "python"
      And the arguments do not allow a bare tool name

    Scenario: Full Access needs no allow-list
      Given an agent step with the prompt "Analyse WW2-1234"
      When it is rendered for "claude" under "full-access"
      Then the arguments do not include "--allowedTools"

    Scenario: The Full Access profile removes the restriction
      Given an agent step with the prompt "Analyse WW2-1234"
      When it is rendered for "claude" under "full-access"
      Then the arguments include "--permission-mode bypassPermissions"
      And the arguments do not include "--restricted"

    Scenario: A confined agent is given the directories it legitimately needs
      Given an agent step with the prompt "Analyse WW2-1234"
      And the artifacts directory "/repos/todolist/.xaedalon/.factory/tasks/t/artifacts" is allowed
      When it is rendered for "claude" under "default"
      # The artifacts root lives under the project, not the worktree, so
      # without this the Default profile refuses the document it just asked for.
      Then the arguments include "--add-dir /repos/todolist/.xaedalon/.factory/tasks/t/artifacts"

    Scenario: An unconfined agent is given no directory grants
      Given an agent step with the prompt "Analyse WW2-1234"
      And the artifacts directory "/repos/todolist/.xaedalon/.factory/tasks/t/artifacts" is allowed
      When it is rendered for "claude" under "full-access"
      # Nothing to grant when nothing is withheld.
      Then the arguments do not include "--add-dir"

    Scenario: Copilot keeps its own path and network checking under Default
      Given an agent step with the prompt "Analyse WW2-1234"
      When it is rendered for "copilot" under "default"
      Then the arguments include "--allow-all-tools"
      And the arguments do not include "--allow-all-paths"
      And the arguments do not include "--allow-all-urls"

    Scenario: Copilot under Full Access allows everything
      Given an agent step with the prompt "Analyse WW2-1234"
      When it is rendered for "copilot" under "full-access"
      Then the arguments include "--allow-all"

    Scenario: Codex claims nothing under either profile
      Given an agent step with the prompt "Analyse WW2-1234"
      When it is rendered for "codex" under "default"
      # Not installed on the machine this descriptor was written on, so its
      # confinement has been measured not at all. An empty list is the honest
      # answer; doctor says so out loud.
      Then no permission arguments are rendered
