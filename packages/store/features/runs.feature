Feature: Runs, steps and the output they produced
  A run is one attempt at one workflow for one task. It is the thing a person
  opens when they ask "what did the agent actually do?", so it has to hold the
  answer: which steps ran, in what order, what each one exited with, and what
  they printed.

  The prototype kept none of this. Output went to a log file named after the
  time it started, the database recorded only that something had happened, and
  answering any question about a past run began with finding the right file and
  reading it by eye. Runs here are rows, and output is kept against the step
  that produced it.

  Output is also kept within a budget. A dev server left running can print for
  as long as anyone lets it, and a store that grows without limit stops being a
  store. When a step exceeds its budget the beginning and the end are kept and
  the middle is dropped — the beginning says what was asked, the end says how it
  ended, and the run says plainly how much is missing rather than pretending it
  has everything.

  Background:
    Given an empty store
    And a task "Add due dates" with the workflow "development"

  Scenario: A run records what it was and when it started
    When I start a run of "development" for the task
    Then the run is "running"
    And the run has a start time
    And the run belongs to the task

  Scenario: A run does not need a task
    When I start a detached run of "development"
    Then the run is "running"
    And the run belongs to no task

  Scenario: Steps are recorded in order
    Given a run of "development"
    When the step "install" of phase "setup" runs and succeeds
    And the step "test" of phase "verify" runs and fails with exit code 1
    Then the run has 2 steps
    And the steps are "install, test" in that order
    And the step "test" is "failed"
    And the step "test" exited with 1

  Scenario: A finished run has an end time and a verdict
    Given a run of "development"
    When the run finishes as "failed"
    Then the run is "failed"
    And the run has an end time

  Scenario: A run that has already finished cannot finish again
    Given a run of "development"
    And the run finishes as "completed"
    When I finish the run as "failed"
    Then it is refused
    And the error mentions the status it already has

  Scenario: A step that was never reached is recorded as skipped
    Given a run of "development"
    When the step "install" of phase "setup" runs and fails with exit code 2
    And the step "deploy" of phase "release" is skipped
    Then the step "deploy" is "skipped"
    And the step "deploy" has no exit code

  Scenario: Output is kept against the step that produced it
    Given a run of "development"
    And the step "install" of phase "setup" is running
    When the step prints "installing" on stdout
    And the step prints "a warning" on stderr
    Then the step's log reads "installing, a warning"
    And the log line "a warning" came from stderr

  Scenario: Output that belongs to the run rather than a step is kept too
    Given a run of "development"
    When the run prints "worktree created" on stdout
    Then the run's own log reads "worktree created"
    And the log is not attached to any step

  Scenario: Output arrives in the order it was written
    Given a run of "development"
    And the step "install" of phase "setup" is running
    When the step prints 20 numbered lines
    Then the step's log is in the order they were printed

  Scenario: A step that prints more than its budget keeps the start and the end
    Given a run of "development"
    And a log budget of 2000 bytes with a 500 byte head
    And the step "install" of phase "setup" is running
    When the step prints 100 lines of 100 bytes
    Then the step's log starts with line 1
    And the step's log ends with line 100
    And the step reports dropped output

  Scenario: One chunk bigger than the whole budget is still kept
    Given a run of "development"
    And a log budget of 200 bytes with a 50 byte head
    And the step "install" of phase "setup" is running
    When the step prints one line of 1000 bytes
    Then the step's log contains that line

  Scenario: Budgets are per step, not per run
    Given a run of "development"
    And a log budget of 2000 bytes with a 500 byte head
    And the step "install" of phase "setup" is running
    When the step prints 100 lines of 100 bytes
    And the step "test" of phase "verify" is running
    And the step prints "quiet" on stdout
    Then the step "test" reports no dropped output

  Scenario: Runs left open by a crash can be found again
    Given a run of "development"
    And a second run of "development" that finished as "completed"
    When I ask for the runs still marked running
    Then only the first run is listed

  Scenario: A paused run remembers where to continue
    Given a run of "development"
    When the run pauses at phase 2
    Then the run is "paused"
    And the run continues from phase 2
    And the run is the one the task is waiting on

  Scenario: A paused run is not mistaken for a crash
    Given a run of "development"
    And the run pauses at phase 1
    When I ask for the runs still marked running
    Then nothing is listed

  Scenario: Resuming a paused run puts it back to work
    Given a run of "development"
    And the run pauses at phase 1
    When the run resumes
    Then the run is "running"
    And the task is waiting on nothing

  Scenario: A run that is not paused cannot resume
    Given a run of "development"
    When I resume the run
    Then it is refused

  Scenario: A task's runs are listed newest first
    Given a run of "development" that finished as "failed"
    And a second run of "development"
    When I ask for the task's runs
    Then the second run is listed first

  Scenario: Deleting a task takes its runs and their output with it
    Given a run of "development"
    And the step "install" of phase "setup" is running
    And the step prints "installing" on stdout
    When the task is deleted
    Then the run is gone
    And no output is left behind

  Scenario: Evidence is kept with the run that produced it
    Given a run of "development"
    When the phase "review" produces the artifact "review" saying "looks good"
    Then the run has 1 piece of evidence
    And the evidence is for the phase "review"
    And the evidence reads "looks good"
    And the evidence records where the file is

  Scenario: An artifact a phase promised but did not produce is recorded as missing
    Given a run of "development"
    When the phase "review" promises "review" and produces nothing
    Then the run has 1 piece of evidence
    And the evidence is marked missing
    And the evidence has no content

  Scenario: Evidence bigger than the cap keeps the beginning and says so
    Given a run of "development"
    And an evidence cap of 100 bytes
    When the phase "review" produces the artifact "review" with 500 bytes
    Then the evidence is marked truncated
    And the evidence records the real size

  Scenario: Evidence is replaced when a phase runs again
    Given a run of "development"
    And the phase "review" produced the artifact "review" saying "first"
    When the phase "review" produces the artifact "review" saying "second"
    Then the run has 1 piece of evidence
    And the evidence reads "second"

  Scenario: A run for a task that does not exist is refused
    When I start a run for the task "ghost"
    Then it is refused

  Rule: a phase is carried out when one run got every step of it done

    This is what a task's progress is a fraction of. The subtlety is the "one
    run" part: judging every run of a workflow together means a failed attempt
    poisons its phase for ever, because the failed row and the later completed
    row sit side by side. Fail, fix, retry — the most travelled path there is —
    and the phase would never count again.

    Scenario: A phase whose every step completed is carried out
      Given a run of "development" for the first workflow
      And "build" ran in "compile" and succeeded
      Then 1 phase has been carried out

    Scenario: A phase is not carried out while a step of it is still running
      Given a run of "development" for the first workflow
      And "build" started in "compile" and has not finished
      Then no phases have been carried out

    Scenario: A phase whose step failed is not carried out
      Given a run of "development" for the first workflow
      And "build" ran in "compile" and failed
      Then no phases have been carried out

    Scenario: A retry carries out the phase its first attempt failed
      Given a run of "development" for the first workflow
      And "build" ran in "compile" and failed
      And a second run of "development" for the first workflow
      And "build" ran in "compile" and succeeded
      Then 1 phase has been carried out

    Scenario: A workflow that ran twice does not count its phases twice
      Given a run of "development" for the first workflow
      And "build" ran in "compile" and succeeded
      And a second run of "development" for the first workflow
      And "build" ran in "compile" and succeeded a second time
      Then 1 phase has been carried out

    Scenario: A run that finished carries out every phase of its workflow
      Given a run of "development" for the first workflow
      And the run completed
      Then its workflow counts as finished

    Scenario: A run that was refused carries nothing out
      Given a run of "development" for the first workflow
      And the run was refused
      Then no phases have been carried out
      And its workflow does not count as finished

    Scenario: A recovery workflow's phases are not credited to the entry that failed
      Given a run of "development" for the first workflow
      And a run of "diagnose" stamped with the same entry
      And "look" ran in "triage" and succeeded
      Then no phases have been carried out

  Rule: a run records the authority it was given

    Recorded rather than derived. "What authority did this run have?" has to be
    answerable after the project's setting has moved on, which is the same trap
    `session_provider` was added to avoid: reading a phase back later lets an
    edit disagree with what actually ran.

    Scenario: A run carries the profile it was started with
      When a run is started under "full-access"
      Then the run's profile is "full-access"

    Scenario: A run started without one records none
      When a run is started
      # Every run from before profiles existed. Null is the truth: nothing knew.
      Then the run states no profile

    Scenario: The profile survives a pause and a resume
      When a run is started under "default"
      And it pauses at phase 2
      And it is resumed
      Then the run's profile is "default"

  Rule: a step records what it actually ran

    A step stored what it said it would do — `describe`, in a person's words —
    and the kind that ran it. What it *actually executed* was nowhere, so "what
    did this agent run, and with what authority?" could only be answered by
    reading the phase file back, which an edit since then makes a different
    question. That is the first thing an audit asks, and the same trap the
    profile and the session provider were recorded to avoid.

    The argv, rendered the way `--dry-run` prints it and the way a terminal
    tool offers it — one string, quoted so it can be pasted. Not the
    environment: it is where the secrets are, and the profile already records
    how much of it the step could see.

    Scenario: A step keeps the command that was run
      When the step "install" runs "npm ci"
      Then the step's command is "npm ci"

    Scenario: A step that ran nothing records nothing
      When the step "install" of phase "setup" runs and succeeds
      # A step recorded before this existed, and a skipped one, which never had
      # a command to run.
      Then the step states no command
