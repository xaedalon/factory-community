Feature: Running a plan
  The foreground runner is the smallest thing that could be called running: one
  process, in order, output straight through. Its purpose is to prove the
  definition layer is executable — a contract nothing can run is a contract
  nobody has tested, however cleanly it validates.

  Two of its behaviours come from specific incidents rather than a wish list.
  Every stuck-workflow report in the prototype's backlog was a process that
  never exited, so a step has a deadline that is actually enforced. And a failed
  step stops the run, because the steps after it assume it worked.

  Scenario: A plan runs its steps in order
    Given a phase "build" running "echo one" then "echo two"
    When the plan is run
    Then the run completed
    And the output was "one" then "two"

  Scenario: Phases run in the order the workflow lists them
    Given a phase "first" running "echo alpha"
    And a phase "second" running "echo beta"
    When the plan is run
    Then the run completed
    And the output was "alpha" then "beta"

  Scenario: A failing step stops the run
    Given a phase "build" running "exit 3" then "echo unreachable"
    When the plan is run
    Then the run failed
    And the output does not contain "unreachable"
    And a problem says the step exited 3

  Scenario: Phases after a failure are not reached
    Given a phase "build" running "exit 1"
    And a phase "later" running "echo later"
    When the plan is run
    Then the run failed
    And "later" was not reached

  Scenario: A step that hangs is killed
    Given a phase "build" running "sleep 30"
    And a step deadline of 1 second
    When the plan is run
    Then the run timed out
    And a problem says the step was killed

  Scenario: A step that cannot start is reported
    Given a phase "build" whose step runs a command that does not exist
    When the plan is run
    Then the run failed

  Scenario: Steps run in the phase's working directory
    Given a phase "build" running "pwd" in a subdirectory
    When the plan is run
    Then the run completed
    And the output names the subdirectory

  Scenario: A phase requiring approval pauses until it is given
    Given a phase "check" running "echo checked" that requires approval
    And approval will be given
    When the plan is run
    Then the run completed
    And approval was requested for "check"

  Scenario: Withholding approval stops the run
    Given a phase "check" running "echo checked" that requires approval
    And a phase "after" running "echo after"
    And approval will be withheld
    When the plan is run
    Then the run was declined
    And "after" was not reached
    And the output does not contain "after"

  Scenario: Approval is asked for after the phase has run
    Given a phase "check" running "echo checked" that requires approval
    And approval will be given
    When the plan is run
    Then the output contains "checked"

  Scenario: A dry run executes nothing
    Given a phase "build" running "echo should-not-run"
    When the plan is run as a dry run
    Then the run completed
    And there was no output

  Scenario: A dry run does not stop at an approval gate
    Given a phase "check" running "echo checked" that requires approval
    And a phase "after" running "echo after"
    When the plan is run as a dry run
    Then the run completed
    And a problem says it would pause for approval
    And "after" was reached

  Scenario: A loop workflow runs one pass, and says who repeats it
    Given a phase "build" running "echo once"
    And the workflow loops
    When the plan is run
    Then the run completed
    And a problem explains that the scheduler is what repeats it
    And "build" ran

  Scenario: Conditions are reported as unchecked
    Given a phase "build" running "echo one"
    And the workflow requires "hasWorktree"
    When the plan is run
    Then the run completed
    And a problem says the requirement is not being checked

  Scenario: Events are emitted for observers
    Given a phase "build" running "echo one"
    When the plan is run
    Then the events include "run.started" and "run.completed"
    And the events include "step.started" and "step.completed"

  Scenario: A step that says so is retried
    Given a phase "flaky" whose step fails once then succeeds, with 2 retries
    When the plan is run
    Then the run completed
    And the step took 2 attempts

  Scenario: Retries run out
    Given a phase "broken" whose step always fails, with 1 retry
    When the plan is run
    Then the run failed
    And the step took 2 attempts

  Scenario: A step with no retries runs once
    Given a phase "build" running "exit 1"
    When the plan is run
    Then the run failed
    And the step took 1 attempt

  Scenario: The delay between attempts is the one the step asked for
    Given a phase "slow" whose step always fails, with 1 retry after 5 seconds
    When the plan is run
    Then it waited 5 seconds between attempts


  Rule: an authorisation gate asks before anything of its phase has run

    `approval` used to say only *whether* a person is asked, and the answer was
    always "once the steps are done" — a review gate, which is what makes an
    artifact worth collecting at one. `before` is the other question people
    want to ask: do not deploy, delete, or let an agent near the repository
    until somebody says so.

    Scenario: Nothing runs until approval is given
      Given a phase "deploy" running "echo deployed" that asks before running
      And approval will be withheld
      When the plan is run
      Then the run was declined
      And the output does not contain "deployed"

    Scenario: Approving runs the phase that was being asked about
      Given a phase "deploy" running "echo deployed" that asks before running
      And approval will be given
      When the plan is run
      Then the run completed
      And the output contains "deployed"

    Scenario: The gate names the phase before it runs
      Given a phase "deploy" running "echo deployed" that asks before running
      And approval will be withheld
      When the plan is run
      Then approval was requested for "deploy"

    Scenario: A declined authorisation comes back to the same phase
      Given a phase "deploy" running "echo deployed" that asks before running
      And approval will be withheld
      When the plan is run
      Then "deploy" was not reached

    Scenario: Resuming into an approved phase does not ask twice
      Given a phase "deploy" running "echo deployed" that asks before running
      And the run is resuming into it, already approved
      And approval will be withheld
      When the plan is run
      Then the run completed
      And nothing was asked
      And the output contains "deployed"

    Scenario: A dry run says which side of the phase it would stop on
      Given a phase "deploy" running "echo deployed" that asks before running
      When the plan is run as a dry run
      Then the run completed
      And a problem says it would pause before its steps

  Rule: a retry can need a different command than the first attempt

    A step that *starts* an agent session cannot be run again as-is: the CLI
    refuses an id it has already seen, so the second attempt has to resume
    instead. The plan renders both — rendering a command is a provider's job —
    and hands the second one over as `retryArgs`.

    Without this, a step with `retries:` that happened to be the first agent
    step of a task would fail every attempt after the first with "Session ID …
    is already in use", and the failure would read as the step's own.

    Scenario: The second attempt runs the command the plan gave it for retries
      Given a step that fails once, with a different command for the retry
      When the plan is run
      Then the run completed
      And both commands ran, in that order

    Scenario: A step with no retry command simply runs the same one again
      Given a step that fails once and has no separate retry command
      When the plan is run
      Then the run completed
      And the same command ran twice

  Rule: the profile decides what a step's process can see

    The filter itself is specified in `agent-environment.feature`. This is the
    other half, and the half that actually protects anybody: that the spawn uses
    it. A correct filter the runner does not call is exactly the shape of
    failure this codebase keeps paying for — a field that validates and lies.

    Scenario: A confined step cannot see a credential
      Given the environment also holds "GITHUB_TOKEN"
      And a phase "build" that prints whether "GITHUB_TOKEN" is set
      When the plan is run
      Then the run completed
      And the output says "GITHUB_TOKEN" was absent

    Scenario: A confined step can still see its PATH
      Given the environment also holds "GITHUB_TOKEN"
      And a phase "build" that prints whether "PATH" is set
      When the plan is run
      Then the run completed
      And the output says "PATH" was present

    Scenario: The step's own output says what was withheld
      Given the environment also holds "GITHUB_TOKEN"
      And a phase "build" that prints whether "GITHUB_TOKEN" is set
      When the plan is run
      # Filed against the step, because that is where somebody debugging "it
      # cannot reach the registry" will be looking.
      Then the output names the withheld "GITHUB_TOKEN"

    Scenario: An unconfined step can see everything
      Given the plan runs under Full Access
      And the environment also holds "GITHUB_TOKEN"
      And a phase "build" that prints whether "GITHUB_TOKEN" is set
      When the plan is run
      Then the run completed
      And the output says "GITHUB_TOKEN" was present
      And the output names nothing withheld

    Scenario: What the provider declared survives
      Given the environment also holds "ANTHROPIC_API_KEY"
      And a phase "build" that prints whether "ANTHROPIC_API_KEY" is set, needing it
      When the plan is run
      Then the run completed
      And the output says "ANTHROPIC_API_KEY" was present

  Rule: a step that asks for stdin gets it

    `stdin:` comes from a provider descriptor — several agent CLIs hang forever
    headless without one — and it was declared, carried onto the planned step,
    printed by `--dry-run` as `< file`, and then dropped: the runner hard-coded
    `stdio: ['ignore', …]` and never opened anything. `/dev/null` made that
    harmless by accident, and a descriptor asking for a real prompt file would
    have been silently ignored while the printed command said otherwise.

    Scenario: The file a step asks for arrives on its stdin
      Given a file "prompt.txt" holding "hello from the file"
      And a phase "ask" whose step reads stdin and takes "prompt.txt" as input
      When the plan is run
      Then the run completed
      And the output says "hello from the file"

    Scenario: A step that asks for nothing still gets a closed stdin
      Given a phase "ask" whose step reads stdin
      When the plan is run
      # Closed rather than inherited: a step waiting on input nobody will send
      # should fail now rather than at the deadline.
      Then the run completed
      And the output is empty

    Scenario: A file that is not there is the step's failure, not the runner's
      Given a phase "ask" whose step takes a missing file as input
      When the plan is run
      Then the run failed
      And the step says it could not open its input
