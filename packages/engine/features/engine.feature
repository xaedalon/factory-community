Feature: Turning a task into runs
  The engine is what stands between a task somebody queued and the processes
  that do the work. It plans each of the task's workflows, runs it, writes down
  every step and everything printed, and moves the task through the states the
  board shows — always by asking the task's own rules, never by writing a state
  directly.

  It also has to be honest about stopping. A workflow can fail, a step can hit
  its deadline, a phase can ask for approval, and a plan can turn out not to
  resolve at all. Each of those ends somewhere different, and the difference is
  the whole reason a person can tell at a glance whether a task needs them.

  Approval is the case worth stating plainly: the engine may be running with
  nobody watching, so a gate does not ask. It stops the run, remembers the phase
  to continue from, and leaves the task where a person will find it.

  Background:
    Given an empty store
    And a task "Add due dates"

  Scenario: A queued task becomes a run
    Given the task has the workflow "development"
    And "development" prints "building" and succeeds
    And the task is queued
    When the engine runs the task
    Then the task is "done"
    And there is 1 run
    And the run is "completed"
    And the run is for "development"

  Scenario: Every step is recorded with what it printed
    Given the task has the workflow "development"
    And "development" prints "building" and succeeds
    And the task is queued
    When the engine runs the task
    Then the run has 1 step
    And the step is "completed"
    And the step's log contains "building"

  Scenario: A failing step blocks the task
    Given the task has the workflow "development"
    And "development" fails with exit code 3
    And the task is queued
    When the engine runs the task
    Then the task is "blocked"
    And the task says why it is blocked
    And the run is "failed"
    And the step exited with 3

  Scenario: What never ran is recorded as skipped
    Given the task has the workflow "development"
    And "development" fails in its first phase and has a second phase
    And the task is queued
    When the engine runs the task
    Then the run has 2 steps
    And the step of the second phase is "skipped"

  Scenario: A task's workflows run in order
    Given the task has the workflows "development, review"
    And every workflow succeeds
    And the task is queued
    When the engine runs the task
    Then there are 2 runs
    And the runs are for "development, review" in that order
    And the task is "done"

  Scenario: A workflow after a failure does not start
    Given the task has the workflows "development, review"
    And "development" fails with exit code 1
    And the task is queued
    When the engine runs the task
    Then there is 1 run
    And the task is "blocked"

  Scenario: An approval gate parks the task rather than asking
    Given the task has the workflow "development"
    And "development" needs approval after its first phase and has a second phase
    And the task is queued
    When the engine runs the task
    Then the task is "awaiting_approval"
    And the run is "paused"
    And the run continues from phase 1
    And the second phase has not run

  Scenario: Approving continues after the gate without repeating it
    Given the task has the workflow "development"
    And "development" needs approval after its first phase and has a second phase
    And the task is queued
    And the engine has run the task
    When the task is approved
    And the engine runs the task again
    Then the task is "done"
    And there is 1 run
    And the run is "completed"
    And the first phase ran once

  Scenario: A workflow that cannot be planned blocks the task and says so
    Given the task has the workflow "nonsense"
    And "nonsense" cannot be planned
    And the task is queued
    When the engine runs the task
    Then the task is "blocked"
    And the run is "refused"
    And the task says why it is blocked

  Scenario: A step that runs too long is stopped and the task is blocked
    Given the task has the workflow "development"
    And "development" runs for longer than the deadline
    And the task is queued
    When the engine runs the task
    Then the task is "blocked"
    And the run is "timed-out"
    And the step is "timed-out"

  Scenario: A task the engine does not own is refused
    Given the task has the workflow "development"
    And every workflow succeeds
    When the engine runs the task
    Then it is refused
    And the error says what state the task is in

  Scenario: A task with nothing to run is blocked, not completed
    Given the task has the workflow "development"
    And every workflow succeeds
    And the task is queued
    And the workflows are taken away
    When the engine runs the task
    Then the task is "blocked"

  Scenario: Running a task again records a second attempt
    Given the task has the workflow "development"
    And "development" fails with exit code 1
    And the task is queued
    And the engine has run the task
    When the task is retried and the engine runs it again
    Then there are 2 runs
    And the newest run is attempt 2

  Scenario: A completed workflow sets the flags it declares
    Given the task has the workflow "worktree-create"
    And "worktree-create" succeeds and provides "hasWorktree"
    And the task is queued
    When the engine runs the task
    Then the task has the flag "hasWorktree"

  Scenario: A workflow that fails earns nothing
    Given the task has the workflow "worktree-create"
    And "worktree-create" fails and would have provided "hasWorktree"
    And the task is queued
    When the engine runs the task
    Then the task has no flags

  Scenario: A workflow can clear a flag it invalidates
    Given the task has the workflow "worktree-delete"
    And the task already has the flag "hasWorktree"
    And "worktree-delete" succeeds and clears "hasWorktree"
    And the task is queued
    When the engine runs the task
    Then the task has no flags

  Scenario: A failure can call for help before the task is blocked
    Given the task has the workflow "development"
    And "development" fails and calls "development-failure" on failure
    And "development-failure" writes a diagnosis
    And the task is queued
    When the engine runs the task
    Then there are 2 runs
    And the recovery run is for "development-failure"
    And the recovery run is "completed"
    And the recovery was told which workflow failed
    And the task is "blocked"

  Scenario: A recovery that fails does not call for help itself
    Given the task has the workflow "development"
    And "development" fails and calls "development-failure" on failure
    And "development-failure" fails and calls "development-failure" on failure
    And the task is queued
    When the engine runs the task
    Then there are 2 runs
    And the task is "blocked"

  Scenario: A retry resumes at the workflow that failed
    Given the task has the workflows "development, review"
    And "development" succeeds
    And "review" fails with exit code 1
    And the task is queued
    And the engine has run the task
    When the task is retried and the engine runs it again
    Then "development" ran once
    And there are 3 runs

  Scenario: A loop workflow goes back in the queue instead of finishing
    Given the task has the workflow "watch"
    And "watch" loops every 30 seconds
    And the task is queued
    When the engine runs the task
    Then the task is "queued"
    And the task waits 30 seconds before running again
    And the run is "completed"
    And the task is still on "watch"

  Scenario: A loop's next iteration is a new run
    Given the task has the workflow "watch"
    And "watch" loops every 30 seconds
    And the task is queued
    And the engine has run the task
    When the engine runs the task again
    Then there are 2 runs
    And the newest run is attempt 2

  Scenario: What a phase produced is kept with the run
    Given the task has the workflow "review"
    And "review" writes "looks good" to the artifact it declares
    And the task is queued
    When the engine runs the task
    Then the run has evidence from the phase "work"
    And the evidence reads "looks good"

  Scenario: An artifact a phase promised and did not produce is recorded and warned about
    Given the task has the workflow "review"
    And "review" declares an artifact and writes nothing
    And the task is queued
    When the engine runs the task
    Then the run has evidence from the phase "work"
    And the evidence is marked missing
    And a problem says the artifact is not there

  Scenario: Evidence waits with a task that stopped for approval
    Given the task has the workflow "review"
    And "review" writes "looks good" to the artifact it declares and then needs approval
    And the task is queued
    When the engine runs the task
    Then the task is "awaiting_approval"
    And the evidence reads "looks good"

  Scenario: A flaky step is retried, and the run records how many attempts it took
    Given the task has the workflow "flaky"
    And "flaky" fails once then succeeds, with 1 retry
    And the task is queued
    When the engine runs the task
    Then the task is "done"
    And the step took 2 attempts

  Scenario: A run a crash left behind is closed at boot
    Given the task has the workflow "development"
    And "development" was left running when Factory stopped
    When Factory starts and reconciles
    Then the run is "failed"
    And the run says Factory stopped
    And the task is "blocked"

  Scenario: Reconciling leaves an approved task waiting rather than blocking it
    Given the task has the workflow "development"
    And "development" needs approval after its first phase and has a second phase
    And the task is queued
    And the engine has run the task
    And the task is approved
    When Factory starts and reconciles
    Then the task is "running"
    And nothing was closed

  Scenario: Reconciling leaves a paused run alone
    Given the task has the workflow "development"
    And "development" needs approval after its first phase and has a second phase
    And the task is queued
    And the engine has run the task
    When Factory starts and reconciles
    Then the run is "paused"
    And the task is "awaiting_approval"
    And nothing was closed

  Rule: an artifact keeps every version and the latest

    A rerun should not throw away what it replaced. The newest sits where the
    agent was told to write it, and a dated copy of each run goes beside it, so
    a second opinion can be compared with the first rather than replacing it
    silently.

    Scenario: A produced artifact is kept, and a copy of it dated
      Given the task has the workflow "review"
      And "review" writes "looks good" to the artifact it declares
      And the task is queued
      When the engine runs the task
      Then the run has evidence from the phase "work"
      And a dated copy of the artifact was kept

    Scenario: Running it again adds a version and updates the latest
      Given the task has the workflow "review"
      And "review" writes "looks good" to the artifact it declares
      And the task is queued
      And the engine has already run the task once
      When the engine runs the task again
      Then there are 2 dated copies
      And the latest reads what the second run wrote

    Scenario: Two artifacts in one run do not collide
      Given the task has the workflow "two-artifacts"
      And the task is queued
      When the engine runs the task
      Then the run has 2 pieces of evidence
      And they are named "first, second"

  Rule: a gate that asks first parks with its phase still to run

    The difference from a review gate is the resume point, and getting it wrong
    is worse than either behaviour on its own: resuming *past* an authorisation
    gate would ask permission for a phase and then skip it, and resuming into
    one without remembering the answer would ask for ever.

    Scenario: Nothing of the gated phase has run when the task parks
      Given the task has the workflow "development"
      And "development" asks before its first phase and has a second phase
      And the task is queued
      When the engine runs the task
      Then the task is "awaiting_approval"
      And the run is "paused"
      And no step has run at all
      And the run continues from phase 0

    Scenario: Approving runs the phase that was asked about, exactly once
      Given the task has the workflow "development"
      And "development" asks before its first phase and has a second phase
      And the task is queued
      And the engine has run the task
      When the task is approved
      And the engine runs the task again
      Then the task is "done"
      And there is 1 run
      And the first phase ran once
      And the second phase ran once

  Rule: a loop with a repeat count stops when it has done them

    A loop used to go round until somebody noticed, which is a poor default for
    something that spawns agents. The count is derived from the runs rather than
    kept in a column of its own: a counter would be a second copy of what the
    runs already say, and the two would disagree the first time a run was
    deleted.

    Scenario: A loop set to repeat once runs once and is done
      Given the task has the workflow "watch"
      And "watch" loops every 30 seconds, repeating 1 time
      And the task is queued
      When the engine runs the task
      Then the task is "done"
      And there is 1 run

    Scenario: A loop set to repeat twice goes round again first
      Given the task has the workflow "watch"
      And "watch" loops every 30 seconds, repeating 2 times
      And the task is queued
      When the engine runs the task
      Then the task is "queued"
      And the task is still on "watch"

    Scenario: And stops on the second pass
      Given the task has the workflow "watch"
      And "watch" loops every 30 seconds, repeating 2 times
      And the task is queued
      And the engine has run the task
      When the engine runs the task again
      Then the task is "done"
      And there are 2 runs

    Scenario: A loop with no repeat keeps going
      Given the task has the workflow "watch"
      And "watch" loops every 30 seconds
      And the task is queued
      And the engine has run the task
      When the engine runs the task again
      Then the task is "queued"

  Rule: what runs next is whatever is ticked, and only that

    This replaced an integer cursor. The cursor was right — a retry did resume —
    but nothing on screen showed it, and any edit to the list reset it, because
    a position in the old list means nothing in the new one.

    Scenario: An unticked workflow is passed over
      Given the task has the workflows "development, review"
      And "development" is unticked
      And the task is queued
      When the engine runs the task
      Then there is 1 run
      And the runs are for "review" in that order

    Scenario: A workflow that completes unticks itself
      Given the task has the workflows "development, review"
      And the task is queued
      When the engine runs the task
      Then "development" is unticked
      And "review" is unticked

    Scenario: A workflow that failed stays ticked
      Given the task has the workflows "development, review"
      And "review" fails
      And the task is queued
      When the engine runs the task
      Then "development" is unticked
      And "review" is still ticked

    Scenario: Fixing it and running again does only what is left
      Given the task has the workflows "development, review"
      And "review" fails
      And the task is queued
      And the engine has run the task
      When "review" is fixed
      And the task is retried
      And the engine runs the task again
      Then "development" ran once
      And the task is "done"

    Scenario: A task queued with nothing ticked is blocked, not completed
      Given the task has the workflows "development, review"
      And every workflow is unticked
      And the task is queued
      When the engine runs the task
      Then the task is "blocked"
      And there are 0 runs

  Rule: a task's agent session is written down once it really exists

    Factory chooses the session id so a conversation can be resumed exactly —
    by the next phase, by a re-run, and by a person opening a terminal in the
    task's directory. Choosing it means recording it, and *when* it is recorded
    is the whole of this rule.

    It is recorded after the process that starts the session has actually
    spawned, and never before. An id written down at plan time would outlive a
    spawn that failed — no CLI on PATH, a directory that had gone — and every
    later run would ask the CLI to resume a conversation that was never had,
    which it refuses. With nothing recorded, the next run simply starts one.

    Scenario: The session is written down after the step that starts it
      Given the task has the workflow "development"
      And "development" runs an agent step that starts a session
      And the task is queued
      When the engine runs the task
      Then the task carries the session "session-1"
      And the session belongs to "claude"

    Scenario: A later run is told the session already exists
      Given the task has the workflow "development" twice
      And "development" runs an agent step that starts a session
      And the task is queued
      When the engine runs the task
      Then the first plan was told to start "session-1"
      And the second plan was told "session-1" already exists

    Scenario: A step that could not be started records nothing
      Given the task has the workflow "development"
      And "development" runs an agent step whose command does not exist
      And the task is queued
      When the engine runs the task
      # Nothing spawned, so no conversation exists. Recording the id here would
      # leave the task asking to resume one for ever.
      Then the task carries no session
      And the task is "blocked"

    Scenario: And the run after it starts a fresh one
      Given the task has the workflow "development"
      And "development" runs an agent step whose command does not exist
      And the task is queued
      When the engine runs the task
      And the task is retried
      Then the second plan was told to start a session

    Scenario: A step that starts no session records nothing
      Given the task has the workflow "development"
      And "development" prints "building" and succeeds
      And the task is queued
      When the engine runs the task
      # A shell step, or an agent step with no session scope, or a provider
      # with no session support: the plan says so, and nothing is recorded.
      Then the task carries no session

    Scenario: A recovery workflow is given the same session
      Given the task has the workflow "development"
      And "development" runs an agent step that starts a session then fails
      And "development-failure" looks into it
      And the task is queued
      When the engine runs the task
      # The agent asked to diagnose a failure wants the conversation that
      # produced it, not a fresh one.
      Then the recovery plan was told "session-1" already exists

  Rule: cancelling a task stops what it is doing

    It did not. Cancelling flipped a row: the agent ran to completion, the
    engine's next transition threw `TransitionError` because `complete` has no
    edge from `cancelled`, the scheduler swallowed that because the task was no
    longer running, and the run row said `running` until the next daemon boot
    corrected it to "Factory stopped while this was running."

    `RunState 'cancelled'` was declared and written by nothing. It has a writer
    now, and the three reasons it could not work — no handle on the child, no
    process group, no attempt at shutdown — are gone.

    Scenario: Cancelling a running task stops its process and records it
      Given the workflow "long" whose phase runs for a long time
      And it is the task's only workflow
      And the task is queued
      When the task is cancelled while it is running
      Then the run is recorded as cancelled
      And the task is cancelled
      And nothing is left running
      And no error was raised

    Scenario: Cancelling through the store reaches the engine
      Given the workflow "long" whose phase runs for a long time
      And it is the task's only workflow
      And the task is queued
      When the task is cancelled through the store while it is running
      # The route only changes the state; the engine notices. So the API, the
      # CLI and a future desktop menu item cannot differ about what cancelling
      # actually does.
      Then the run is recorded as cancelled
      And nothing is left running

    Scenario: Cancelling a task that is doing nothing is not an error
      When the task is cancelled before anything runs
      Then nothing was signalled

    Scenario: Stopping everything cancels the tasks it stopped
      Given the workflow "long" whose phase runs for a long time
      And it is the task's only workflow
      And the task is queued
      When everything is stopped while it is running
      Then the run is recorded as cancelled
      And the task is cancelled
      And the reason is recorded against the task

  Rule: a refusal is always reported, and only parks a run that failed

    The plan for this increment assumed a refusal would fail the step. Running
    the real CLI showed otherwise: a confined `claude -p` **exits 0** and reports
    the refusal in prose. So the two cases are genuinely different and get
    different answers.

    A run that failed *and* was refused something was going to stop either way,
    so parking it is strictly better: it keeps its place, the person is told
    what was refused, and approving continues from the failing phase rather than
    from the beginning.

    A run that was refused something and still succeeded is left alone.
    Interrupting it would be wrong — the work that mattered may well be done —
    and not interrupting is the entire point of the Default profile.

    Scenario: A refusal on a run that succeeded is reported without stopping it
      Given the workflow "review" whose phase is refused a path but succeeds
      And it is the task's only workflow
      And the task is queued
      When the engine works on it
      Then the run completed
      And the task is done
      And a problem says the agent was refused something
      And the problem names the path it was refused
      And a "permission.requested" event was emitted

    Scenario: A refusal on a run that failed parks it for a person
      Given the workflow "review" whose phase is refused a path and fails
      And it is the task's only workflow
      And the task is queued
      When the engine works on it
      Then the task is awaiting approval
      And the run is paused
      And a problem says the agent was refused something

    Scenario: A failure with no refusal still blocks
      Given the workflow "review" whose phase simply fails
      And it is the task's only workflow
      And the task is queued
      When the engine works on it
      # Unchanged: parking is for the case a person can actually resolve.
      Then the task is blocked

  Rule: a refused command parks the run, whatever its exit code said

    The rule above splits on whether the run *failed*, and a supervised run
    found the case it cannot see. An agent was refused `pnpm install`; the CLI
    exited 0 with `"subtype":"success"`; the tests that ran afterwards ran
    against a project with no dependencies; and Factory said done. Nobody was
    lied to on purpose — there was nothing to read.

    A provider that emits a structured transcript says which *command* was
    refused, and that is a different animal from a refused path. A refused path
    leaves the agent free to write somewhere else and finish the job. A refused
    command means an install, a build or a test did not run, and everything
    reported after it was reported without it. So it parks, and the exit code
    does not get a vote.

    Scenario: A run that succeeded with a refused command is parked, not finished
      Given the workflow "build" whose second phase is refused "pnpm install"
      And it is the task's only workflow
      And the task is queued
      When the engine works on it
      Then the task is awaiting approval
      And the run is paused
      And the task is not done
      And a problem names the command "pnpm install"

    Scenario: Approving resumes the phase the command was refused in
      # Not the phase after it. Resuming past the work that did not happen is
      # the same silence with an approval in front of it.
      Given the workflow "build" whose second phase is refused "pnpm install"
      And it is the task's only workflow
      And the task is queued
      When the engine works on it
      Then the run continues from phase 1

    Scenario: A workflow's flags are not earned by a run that was refused a command
      # `provides:` is how a later workflow knows the environment is ready. A
      # flag set here would tell the next workflow a lie that outlives the run.
      Given the workflow "build" whose second phase is refused "pnpm install"
      And it provides "installed"
      And it is the task's only workflow
      And the task is queued
      When the engine works on it
      Then the task does not have the flag "installed"

  Rule: a sequential workflow runs alone, wherever it is in the task's list

    `scheduling: sequential` was enforced only where a task was admitted. After
    that the task stays `running` from its first workflow to its last, and
    nothing looked at the field again — so a sequential workflow anywhere but
    first was never serialised against anything. Measured on a real pipeline:
    two tasks whose fourth workflow was `merge` ran their merges 20ms apart,
    twice, and left the repository with a staged deletion of a file that had
    just merged cleanly. The sample repository's answer was to take a `mkdir`
    lock inside the workflow, which is the workaround this makes unnecessary.

    Held around one workflow's execution, which is the unit the field is about,
    and released the moment that execution ends — including when it parks at an
    approval gate. Holding a lane across a wait for a person is how one
    forgotten approval freezes every sequential workflow in an installation.

    Scenario: Two tasks reaching a sequential workflow do not overlap
      Given two tasks whose second workflow is sequential and records when it ran
      When the engine works on both at once
      Then the second workflow's two runs did not overlap
      And both tasks are "done"

    Scenario: The one that waited says so
      Given two tasks whose second workflow is sequential and records when it ran
      When the engine works on both at once
      Then one of the runs says it waited for the sequential lane

    Scenario: Parallel workflows are still parallel
      Given two tasks whose only workflow is parallel and records when it ran
      When the engine works on both at once
      # The other half of the guarantee: serialising everything would be a
      # correct-looking scheduler that runs one thing at a time.
      Then the two runs overlapped

  Rule: rejecting an approval ends the run it was asked about

    `reject` moves the task to `blocked` and used to leave its paused run
    paused for ever. Two consequences, and the second is the serious one. The
    board showed a run nobody would ever pick up, and doctor said somebody
    should approve or reject a task that had already been rejected. Worse, a
    retry afterwards *resumed* that run — `Engine.start` picks a paused run up
    at the phase after the gate, so the phases the person had declined to
    authorise ran anyway, with nobody asked a second time.

    `declined` is the state for this — "someone said no at an approval gate" —
    and until now nothing in the product ever wrote it.

    Everything the run produced is kept. Rejecting is a verdict on what
    happened, not a reason to throw away the evidence it was reached from.

    Scenario: The run is finished as declined
      Given a task parked at an approval gate
      When somebody rejects it
      Then the run is "declined"
      And the run's output is still there

    Scenario: A retry after a rejection starts the workflow again
      Given a task parked at an approval gate
      And somebody rejects it
      When the task is retried
      # Not resumed past the gate: the phases before it run again, and the gate
      # is asked again.
      Then the gate was reached a second time
      And there are 2 runs

  Rule: what a run produced is kept out of git, and nothing else is

    A repository that grows a diff every time an agent thinks is a repository
    nobody wants, so the first run to write an artifact leaves an ignore file
    beside the directory it wrote into.

    The narrow one. This fires for a family directory Factory did not create —
    one from before it wrote an ignore file at all, or one somebody has already
    shared — so it names what a run produced and nothing else. Hiding the whole
    directory here would hide a team's next workflow from `git status` while
    leaving the ones already committed in plain sight.

    Scenario: A run writes an ignore file for the output it produced
      Given a workflow whose step writes an artifact under a Factory directory
      And it is the task's only workflow
      And the task is queued
      When the engine runs the task
      Then the family directory has an ignore file
      And it ignores the task directories, the database and the bundle backups
      And it leaves the definitions alone

    Scenario: An ignore file already there is left exactly as it is
      Given a workflow whose step writes an artifact under a Factory directory
      And an ignore file somebody wrote by hand
      And it is the task's only workflow
      And the task is queued
      When the engine runs the task
      Then the ignore file still says what they wrote

    Scenario: An artifact outside a Factory directory writes no ignore file
      Given a workflow whose step writes an artifact somewhere of its own
      And it is the task's only workflow
      And the task is queued
      When the engine runs the task
      # Nothing to ignore on somebody's behalf: this is a directory they chose.
      Then no ignore file was written

  Rule: an agent is told where it is in the tree

    Factory puts four names into the environment of every process it starts, so
    that an MCP server run by that agent knows which run it is inside without
    being asked to be honest about it. Everything that bounds work starting
    work rests on them arriving.

    Asserted by running a real command and reading what it printed, because the
    interesting failure is not "the object had the wrong key" — it is a name
    that never reached the process at all.

    Scenario: A step can see the run and the task it belongs to
      Given the task has the workflow "development"
      And "development" prints what it was told about itself
      And the task is queued
      When the engine runs the task
      Then the output names the run it is part of
      And the output names the task it is part of
      And the output says it is at depth 0

  Rule: a run remembers who asked for its task

    Scenario: A task a person created starts a run at the top of the tree
      Given the task has the workflow "development"
      And "development" prints "building" and succeeds
      And the task is queued
      When the engine runs the task
      Then the run is at depth 0
      And the run came from nowhere

    Scenario: A task an agent asked for starts a run one deeper
      Given a finished run "run-earlier" at depth 0
      And a task created by "run-earlier"
      And that task has a workflow that succeeds
      And the task is queued
      When the engine runs the task
      Then the run is at depth 1
      And the run came from "run-earlier"
