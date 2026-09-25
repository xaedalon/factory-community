Feature: A task, and the rules about how it moves
  A task is the thing that outlives the command that created it. Everything the
  board shows, the scheduler picks up and the engine runs is a task in some
  state, so the rules about which state can follow which are the part that has
  to be obviously right.

  They live in one place for a specific reason. In the prototype, approve,
  retry, run, archive and the scheduler each called transition() with their own
  surrounding logic, and the interface re-encoded the same rules as scattered
  conditionals. The two drifted, and the bug that followed let a blocked task be
  started in a way nothing had anticipated. Here there is one table of moves,
  one function that applies them, and a published list of what is currently
  allowed so no client has to re-derive any of it.

  Background:
    Given an empty store
    And a project to put tasks in

  Scenario: A new task starts as a draft
    When I create a task "Add due dates"
    Then the task is "draft"
    And its history is empty

  Scenario: A draft with no workflows cannot be queued
    When I create a task "Add due dates"
    Then "queue" is not offered

  Scenario: Assigning a workflow makes it queueable
    Given a task "Add due dates"
    When I assign the workflow "development"
    Then "queue" is offered

  Scenario: Queueing puts it in line
    Given a task "Add due dates" with the workflow "development"
    When I queue it
    Then the task is "queued"
    And it has a place in the queue

  Scenario: Tasks queue behind each other
    Given a task "First" with the workflow "development"
    And a task "Second" with the workflow "development"
    When I queue "First"
    And I queue "Second"
    Then "Second" is behind "First" in the queue

  Scenario: Every transition is recorded
    Given a task "Add due dates" with the workflow "development"
    When I queue it
    Then its history has 1 entry
    And the entry says it went from "draft" to "queued"

  Scenario: A blocked task records why
    Given a running task
    When it is blocked because "the tests failed"
    Then the task is "blocked"
    And the reason is "the tests failed"

  Scenario: Retrying clears the reason
    Given a running task
    And it is blocked because "the tests failed"
    When I retry it
    Then the task is "queued"
    And there is no reason recorded

  Scenario: A finished task can be run again
    Given a running task
    When it completes
    Then the task is "done"
    And it has a completion time
    When I queue it again
    Then the task is "queued"
    And it no longer has a completion time

  Scenario: An action the state does not allow is refused
    Given a task "Add due dates" with the workflow "development"
    When I try to approve it
    Then it is refused
    And the error says what is available instead

  Scenario: The available actions depend on the state
    Given a task "Add due dates" with the workflow "development"
    Then the offered actions are "archive, cancel, mark_done, queue"
    When I queue it
    Then the offered actions are "cancel, mark_done"

  Scenario: Internal actions are not offered to a person
    Given a task "Add due dates" with the workflow "development"
    When I queue it
    Then "start" is not offered

  Scenario: A task awaiting approval can be approved or rejected
    Given a task awaiting approval
    Then the offered actions are "approve, cancel, reject"

  Scenario: Approving resumes it
    Given a task awaiting approval
    When I approve it
    Then the task is "running"

  Scenario: Rejecting blocks it
    Given a task awaiting approval
    When I reject it
    Then the task is "blocked"

  Scenario: Archiving hides it from the board
    Given a task "Add due dates" with the workflow "development"
    When I archive it
    Then the task is "archived"
    And it is not in the default listing
    And it is in the listing that includes archived tasks

  Scenario: A restored task comes back as a draft
    Given a task "Add due dates" with the workflow "development"
    And it is archived
    When I restore it
    Then the task is "draft"

  Scenario: Cancelling is possible from anywhere that is still live
    Given a running task
    When I cancel it
    Then the task is "cancelled"

  Scenario: A transition and its history are written together
    Given a task "Add due dates" with the workflow "development"
    When a transition fails partway
    Then no history was recorded

  Rule: Editing the list keeps what each entry already knows

    This used to be the opposite. Progress was a position in the list, so any
    edit — even a reorder — sent the task back to the first workflow, because
    position 2 means nothing once the list has changed. Fixing a failure almost
    always means touching the task, so the cost of that landed exactly when it
    hurt most.

    Entries carry their own state now, and an edit carries it across.

    Scenario: Reordering keeps every entry's tick
      Given a task with "one", "two" and "three", of which "one" and "two" have run
      When I put the same workflows in a different order
      Then "one" and "two" are still unticked
      And "three" is still ticked

    Scenario: Adding a workflow leaves the others alone
      Given a task with "one", "two" and "three", of which "one" and "two" have run
      When I add "four" to the end
      Then "one" and "two" are still unticked
      And "four" is ticked

    Scenario: Saving an unedited list changes nothing
      Given a task with "one", "two" and "three", of which "one" and "two" have run
      When I assign the same list of workflows
      Then "one" and "two" are still unticked

    Scenario: A workflow that has never run can be taken off
      Given a task with "one", "two" and "three", of which "one" and "two" have run
      When I take "three" off the list
      Then the list is "one, two"

    Scenario: A workflow that has run cannot be taken off
      Given a task with "one", "two" and "three", of which "one" and "two" have run
      When I take "two" off the list
      Then the change is refused
      And the refusal names "two"

    Scenario: Nothing is half-applied when a removal is refused
      Given a task with "one", "two" and "three", of which "one" and "two" have run
      When I take "two" off the list
      Then the list is still "one, two, three"

  Rule: A workflow is ticked until the engine has finished with it

    Scenario: A new task has everything ticked
      Given a task "Add due dates" with the workflow "development"
      Then "development" is ticked

    Scenario: A task with nothing ticked cannot be queued
      Given a task with "one", "two" and "three", of which "one" and "two" have run
      And "three" is unticked as well
      Then it cannot be queued

    Scenario: Ticking one back on makes it queueable again
      Given a task with "one", "two" and "three", of which "one" and "two" have run
      And "three" is unticked as well
      When I tick "one" back on
      Then it can be queued

  Rule: A task can be renamed without losing where its work lives

    `directory` is the task's identity on disk — the worktree was created at it
    and the daemon joins it with the project's worktree root to decide where
    steps run. Re-deriving it from a new name would move the workspace out from
    under work in progress and orphan the directory holding it.

    Scenario: Renaming changes the name
      Given a task "Add due dates" with the workflow "development"
      When I rename it to "Add due dates and times"
      Then the task is called "Add due dates and times"

    Scenario: Renaming leaves the directory alone
      Given a task "Add due dates" with the workflow "development"
      When I rename it to "Something else entirely"
      Then its directory is unchanged

    Scenario: A task cannot be renamed to nothing
      Given a task "Add due dates" with the workflow "development"
      When I rename it to "   "
      Then the rename is refused

  Rule: A task says what it is for, separately from what it is called

    A name is an identifier people search the board by; a description is the
    brief. Keeping them apart is what lets `{{ task.description }}` be pasted
    into a prompt without dragging the name's constraints along with it.

    Scenario: A task with no description has an empty one, not a missing one
      Given a task "Add due dates" with the workflow "development"
      Then its description is empty

    Scenario: Describing a task
      Given a task "Add due dates" with the workflow "development"
      When I describe it as "Every todo gets an optional due date, shown on the list."
      Then its description is "Every todo gets an optional due date, shown on the list."

    Scenario: A description can be cleared
      Given a task "Add due dates" described as "Something provisional"
      When I describe it as ""
      Then its description is empty

    Scenario: Renaming leaves the description alone
      Given a task "Add due dates" described as "Every todo gets an optional due date."
      When I rename it to "Something else entirely"
      Then its description is "Every todo gets an optional due date."

    Scenario: Describing leaves the name and the directory alone
      Given a task "Add due dates" with the workflow "development"
      When I describe it as "A brief."
      Then the task is called "Add due dates"
      And its directory is unchanged

  Rule: A task remembers the agent session its steps share

    The id is Factory's own choosing, which is what makes the conversation
    resumable exactly rather than by "the most recent one in this directory".
    Written here, read by the next run and by whoever opens a terminal.

    Scenario: A new task has no session
      Given the task "Add due dates" exists
      Then it carries no session

    Scenario: A session is written down and read back
      Given the task "Add due dates" exists
      When the session "s-1" for "claude" is recorded
      Then it carries the session "s-1"
      And the session belongs to "claude"

    Scenario: The first one recorded is the one it keeps
      Given the task "Add due dates" exists
      And the session "s-1" for "claude" is recorded
      When the session "s-2" for "claude" is recorded
      # A later run must not replace it: the second session would be missing
      # every phase the first one holds, and the task would resume into a
      # conversation that never saw its own earlier work.
      Then it carries the session "s-1"

    Scenario: A session for a task that is not there is an error
      When the session "s-1" is recorded for a task that does not exist
      Then it fails

  Rule: A task's directory is a single path segment, whoever chose it

    The directory is not only a label. It is the task's worktree name, its
    artifacts root, and — through `workspaceFor` — the directory the agent
    process itself runs in. It also arrives over HTTP, because
    `POST /api/tasks` accepts one.

    So it is slugged whether it was supplied or derived from the name. The
    guarantee is structural rather than a list of inputs to reject: everything
    outside `a-z0-9` becomes a dash, so the result is one path segment and
    there is nothing left to climb out with.

    Scenario: A directory derived from the name is slugged
      When a task called "Add due dates" is created
      Then its directory is "add-due-dates"

    Scenario: A supplied directory is slugged too
      When a task is created asking for the directory "Add Due Dates"
      Then its directory is "add-due-dates"

    Scenario: A supplied directory cannot climb out
      When a task is created asking for the directory "../../escape"
      # Not "rejected": the separators simply cannot survive the slug, which is
      # a stronger claim than a validation rule somebody has to keep current.
      Then its directory is "escape"
      And its directory contains no separator

    Scenario: An absolute supplied directory cannot restart the path
      When a task is created asking for the directory "/etc/passwd"
      Then its directory is "etc-passwd"
      And its directory contains no separator

    Scenario: A supplied directory that slugs away still gets a name
      When a task is created asking for the directory "../.."
      Then its directory is "task"

    Scenario: Two tasks never share a directory, even when both ask for one
      Given a task is created asking for the directory "shared"
      When a task is created asking for the directory "shared"
      # They would otherwise share a worktree and an artifacts root.
      Then its directory is "shared-2"

  Rule: A task can be made to wait for another in the same project

    The edge is checked at the door, not when the graph is walked: a graph
    Factory wrote is a graph Factory can order, which is what lets the ordering
    treat a ring as corruption rather than as an ordinary outcome to design
    around.

    Ids rather than names, so renaming a task does not move the graph.

    Scenario: A new task waits for nothing
      Given the task "Add due dates" exists
      Then it waits for nothing

    Scenario: One task is made to wait for another
      Given the task "Scaffold" exists
      And the task "The model" exists
      When "The model" is made to wait for "Scaffold"
      Then "The model" waits for "Scaffold"
      And "Scaffold" waits for nothing

    Scenario: The same edge twice is one edge
      Given the task "Scaffold" exists
      And the task "The model" exists
      And "The model" is made to wait for "Scaffold"
      When "The model" is made to wait for "Scaffold" again
      # What pressing the button twice looks like.
      Then "The model" waits for exactly 1 task

    Scenario: The edge can be taken back
      Given the task "Scaffold" exists
      And the task "The model" exists
      And "The model" is made to wait for "Scaffold"
      When "The model" stops waiting for "Scaffold"
      Then "The model" waits for nothing

    Scenario: Taking back an edge that is not there is not an error
      Given the task "Scaffold" exists
      And the task "The model" exists
      When "The model" stops waiting for "Scaffold"
      Then "The model" waits for nothing

    Scenario: A task cannot wait for itself
      Given the task "Scaffold" exists
      When "Scaffold" is made to wait for "Scaffold"
      Then it is refused
      # In its own words, not as a ring one hop long: the ring check would
      # catch this too, and would explain it with "already waits for", which is
      # not what happened.
      And the refusal says it cannot depend on itself

    Scenario: A task cannot wait for one in another project
      Given the project "one" exists
      And the project "two" exists
      And the task "Scaffold" exists in "one"
      And the task "The model" exists in "two"
      When "The model" is made to wait for "Scaffold"
      # A dependency between projects has no owner, and the controls that act
      # on the graph are project-level.
      Then it is refused
      And the refusal says they are in different projects

    Scenario: A task cannot wait for one that is not there
      Given the task "The model" exists
      When "The model" is made to wait for a task that does not exist
      Then it is refused

    Scenario: An edge that would make a ring is refused
      Given the task "Scaffold" exists
      And the task "The model" exists
      And "The model" is made to wait for "Scaffold"
      When "Scaffold" is made to wait for "The model"
      Then it is refused
      And the refusal says it would make a ring

    Scenario: A longer ring is refused too
      Given the task "One" exists
      And the task "Two" exists
      And the task "Three" exists
      And "Two" is made to wait for "One"
      And "Three" is made to wait for "Two"
      When "One" is made to wait for "Three"
      Then it is refused
      And the refusal says it would make a ring

    Scenario: Deleting the waiting task removes the edge
      Given the task "Scaffold" exists
      And the task "The model" exists
      And "The model" is made to wait for "Scaffold"
      When "The model" is deleted
      Then no dependency rows are left

    Scenario: Deleting the blocker removes the edge
      Given the task "Scaffold" exists
      And the task "The model" exists
      And "The model" is made to wait for "Scaffold"
      When "Scaffold" is deleted
      # An edge naming a task nobody can find is a dependency nothing can ever
      # satisfy, so it must not outlive either end.
      Then no dependency rows are left

    Scenario: A project's edges are read together
      Given the project "one" exists
      And the task "Scaffold" exists in "one"
      And the task "The model" exists in "one"
      And "The model" is made to wait for "Scaffold"
      When I ask for the edges in "one"
      Then there is 1 edge

    Scenario: Another project's edges are left out
      Given the project "one" exists
      And the project "two" exists
      And the task "Scaffold" exists in "one"
      And the task "The model" exists in "one"
      And the task "Groundwork" exists in "two"
      And the task "The view" exists in "two"
      And "The model" is made to wait for "Scaffold"
      And "The view" is made to wait for "Groundwork"
      When I ask for the edges in "one"
      Then there is 1 edge

  Rule: A task can be marked done by hand

    "I did this myself" — the work happened outside Factory, or it turned out
    not to be needed, and everything waiting for it should stop waiting.

    A separate action rather than letting a person reach the engine's
    `complete`, which is only legal on a running task: telling Factory a
    running task is finished would leave the agent going, the run row saying
    `running`, and the engine's own completion throwing when it got there.

    What it skips is real. No run, no artifacts, no evidence, and no flags — so
    progress still reads none of the phases done. That is honest for work done
    by hand; it is not a way to fake a run.

    Scenario: A draft can be marked done
      Given a task "Add due dates" with the workflow "development"
      When I mark it done
      Then the task is "done"
      And it has a completion time

    Scenario: A task with nothing planned can be marked done
      Given a task "Add due dates"
      # Queueing is refused here because there is nothing to run. Doing it by
      # hand is exactly the case where there never was anything to run.
      When I mark it done
      Then the task is "done"

    Scenario: A queued task marked done leaves the queue
      Given a task "Add due dates" with the workflow "development"
      And I queue it
      When I mark it done
      Then the task is "done"
      And it has no place in the queue

    Scenario: A blocked task can be marked done
      Given a running task
      And it is blocked because "the tests failed"
      When I mark it done
      Then the task is "done"
      And there is no reason recorded

    Scenario: A running task cannot be marked done by hand
      Given a running task
      # The agent would keep going, and the engine's own completion would then
      # throw on a task that is already done.
      When I mark it done
      Then it is refused

    Scenario: A task awaiting approval cannot be marked done by hand
      Given a task awaiting approval
      # It holds a paused run. Approve or reject it first, or the doctor starts
      # warning about a run with nothing running.
      When I mark it done
      Then it is refused

    Scenario: Marking done is recorded like any other move
      Given a task "Add due dates" with the workflow "development"
      When I mark it done
      Then its history has 1 entry
      And the entry says it went from "draft" to "done"

    Scenario: A task marked done by hand earned nothing
      Given a task "Add due dates" with the workflow "development"
      When I mark it done
      Then it has no flags
      And its workflow is still ticked

    Scenario: Completing is still the engine's alone
      Given a running task
      Then "complete" is not offered

  Rule: The scheduler can block a task that is still queued

    Queued tasks could only be cancelled before. The dependency gate needs a
    third answer: a task whose blocker can never finish will never start, and
    leaving it in the queue would park it for ever looking like it was about to
    run.

    Still the scheduler's move alone — a person has cancel.

    Scenario: A queued task can be blocked with a reason
      Given a task "Add due dates" with the workflow "development"
      And I queue it
      When it is blocked because "Task 2 was cancelled"
      Then the task is "blocked"
      And the reason is "Task 2 was cancelled"

    Scenario: Blocking leaves the queue
      Given a task "Add due dates" with the workflow "development"
      And I queue it
      When it is blocked because "Task 2 was cancelled"
      Then it has no place in the queue

    Scenario: Retrying puts it back in line
      Given a task "Add due dates" with the workflow "development"
      And I queue it
      And it is blocked because "Task 2 was cancelled"
      When I retry it
      Then the task is "queued"
      And there is no reason recorded

    Scenario: Blocking is never offered to a person
      Given a task "Add due dates" with the workflow "development"
      And I queue it
      Then "block" is not offered

  Rule: a task can be moved to another project

    A task created in the wrong project could only be deleted and made again,
    which throws away everything recorded about it — and a task now has to be
    created in *some* project, so choosing the wrong one is an ordinary
    mistake rather than an exotic one.

    Moving changes where the work happens, so it is refused while work is
    happening: the task is in a worktree of the old project, the run in flight
    is spawning steps there, and the row deciding where that is must not change
    underneath it.

    Dependencies are the other refusal. An edge may only join two tasks in the
    same project — a dependency across projects has no owner — so moving one
    end of one would leave behind an edge the store would refuse to create.

    Scenario: A draft task is moved
      Given the project "other" also exists
      And the task "Add due dates" exists
      When I move it to "other"
      Then the task belongs to "other"

    Scenario: Moving a running task is refused
      Given the project "other" also exists
      And the task "Add due dates" exists
      And "Add due dates" is running
      When I move it to "other"
      Then it is refused
      And the error says the task is running

    Scenario: Moving a task that something waits for is refused
      Given the project "other" also exists
      And the task "Add due dates" exists
      And the task "Ship it" exists
      And "Ship it" waits for "Add due dates"
      When I move "Add due dates" to "other"
      Then it is refused
      And the error mentions what it is waiting on

    Scenario: Moving to a project that is not there is refused
      Given the task "Add due dates" exists
      When I move it to a project that does not exist
      Then it is refused

    Scenario: Moving it where it already is changes nothing
      Given the task "Add due dates" exists
      When I move it to the project it is already in
      Then the task is unchanged

  Rule: which actions exist to ask for is published too

    "A published list of what is currently allowed so no client has to
    re-derive any of it" is what the top of this file promises, and it was two
    thirds true. A task publishes the actions it offers *right now*; which
    actions exist to ask for at all was not published, so the CLI kept its own
    copy of the eight a person can type, with a comment saying the daemon had
    the final say. That comment is how a list drifts — it is correct right up
    until somebody adds a ninth move.

    Scenario: The engine's own moves are not on it
      # A client asking for one of these would put a task past the concurrency
      # cap, or mark a run done while its agent was still writing.
      Then a client may not ask for "start"
      And a client may not ask for "idle"
      And a client may not ask for "await_approval"
      And a client may not ask for "block"
      And a client may not ask for "complete"

    Scenario: The list is exactly the moves somebody may make
      # Named literally rather than filtered out of the table under test: an
      # assertion that loops over the list it is checking passes whatever that
      # list happens to say, including a new move with `internal` forgotten.
      Then a client may ask for exactly "queue, approve, reject, mark_done, retry, cancel, archive, restore"

  Rule: how many tasks a run has asked for is counted, never kept

    A counter on the run would say ten after somebody tidied five away, and an
    agent would be refused work it had every right to ask for. Counting the
    rows is the only answer that survives a deletion.

    Scenario: A run that has asked for nothing has asked for nothing
      Then "run-1" has asked for 0 tasks

    Scenario: Tasks a run asked for are counted
      Given two tasks created by "run-1"
      Then "run-1" has asked for 2 tasks

    Scenario: A task somebody else asked for is not counted
      Given two tasks created by "run-1"
      And a task created by "run-2"
      Then "run-1" has asked for 2 tasks

    Scenario: An archived task still counts
      # A task that was archived still happened. A run that could reset its own
      # budget by archiving is not budgeted.
      Given two tasks created by "run-1"
      And one of them is archived
      Then "run-1" has asked for 2 tasks
