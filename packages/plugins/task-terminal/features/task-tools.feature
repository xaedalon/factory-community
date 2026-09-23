Feature: The three task tools Factory ships

  "Open terminal" and "Open session" were buttons written into the board, their
  commands resolved by name inside a route. They are plugins now, which is what
  made room for the third — and for a fourth that will not be ours.

  All three live in one feature for the reason the three providers do: they are
  a family, they share a fixture, and three copies of that fixture is how the
  copy nobody reads goes stale.

  Background:
    Given the claude provider is installed

  Scenario Outline: Every one of them passes the same conformance suite
    When conformance is checked for "<plugin>"
    Then the plugin conforms
    And it provides "<capability>"

    Examples:
      | plugin        | capability               |
      | task-terminal | task-tool:open-terminal  |
      | task-session  | task-tool:open-session   |
      | task-diffity  | task-tool:diffity        |

  Scenario: They list in the order the row reads in
    Then the orders are 10, 20, 30

  Rule: a terminal where the work is

    Scenario: It offers a shell and no command
      When "open-terminal" is asked what it offers
      # Asserted before the two absences below, because both of those are true
      # of a tool that offered nothing at all: `offer?.command` and
      # `offer?.unavailable` read `undefined` when there is no offer, so
      # without this the scenario passes for a tool that declined to appear.
      Then it offers something
      And it offers no command of its own
      And it is available

    Scenario: A task whose project is missing has nowhere to open
      Given the task's project is not in the database
      When "open-terminal" is asked what it offers
      Then it is unavailable
      And the reason says there is nowhere to open

  Rule: the conversation the agent was having

    Factory chooses the session id so this can be exact. `claude -c` resumes
    "the most recent conversation in this directory", which is the wrong one as
    soon as two tasks share a directory — and which interactive Claude refuses
    outright for a session `claude -p` created.

    Scenario: A task with a recorded session resumes it by id
      Given the task's session is "s-99" on "claude"
      When "open-session" is asked what it offers
      Then it would run "claude --resume s-99"
      And it is available

    Scenario: A task no agent has run for says so, and says it only once
      When "open-session" is asked what it offers
      Then it is unavailable
      # The one copy of this sentence. It used to be written twice — a tooltip
      # in the board and the daemon's own wording for the refusal.
      And the reason is the no-session-yet sentence

    Scenario: A session whose provider has gone names it
      Given the task's session is "s-99" on "gone"
      When "open-session" is asked what it offers
      Then it is unavailable
      And the reason names "gone"

    Scenario: A provider that cannot resume by id says that instead
      Given the codex provider is installed
      And the task's session is "s-99" on "codex"
      When "open-session" is asked what it offers
      Then it is unavailable
      And the reason says it has no way to resume

  Rule: the task's changes, in Diffity

    Diffity starts a small server and opens the browser itself, so it asks for
    a detached run and needs nothing installed to perform it. That is why it
    works where the two terminal tools degrade to a line you copy.

    Scenario: It diffs the branch against its base
      Given "diffity" is installed
      When "diffity" is asked what it offers
      # A task's agent commits as it goes, so bare `diffity` — uncommitted
      # changes — would usually show nothing at all.
      # Flags before the ref: `diffity main --new` is refused, the flag being
      # read as a second git ref. Verified against diffity 0.9.5.
      Then it would run "diffity --new main"
      And it asks for a detached run
      And it is available

    Scenario: It runs the binary where it was actually found
      Given "diffity" is installed somewhere PATH does not mention
      When "diffity" is asked what it offers
      # A detached child inherits this PATH. Passing the bare name would fail
      # with "command not found" on something just reported as available.
      Then it would run the full path to it

    Scenario: Not installed says how to install it
      When "diffity" is asked what it offers
      Then it is unavailable
      And the reason says "npm install -g diffity"

    Scenario: A project that is not a git repository cannot be diffed
      Given "diffity" is installed
      And the project is not a git repository
      # Answered by the project row, not by looking for a .git directory.
      When "diffity" is asked what it offers
      Then it is unavailable
      And the reason says Diffity needs one

    Scenario: A task whose project is missing has nothing to diff
      Given "diffity" is installed
      And the task's project is not in the database
      When "diffity" is asked what it offers
      Then it is unavailable
