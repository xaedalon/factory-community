Feature: Deciding what runs next
  The scheduler is the only thing that decides which queued task starts. It
  answers five questions — is there room, is what this task waits for done, is
  the working copy free, is this task's lane free, and what is next in the
  queue — and it says out loud why anything it passed over was passed over.

  That last part is the point. The prototype's scheduler was a loop with early
  returns, and "why is nothing running?" could only be answered by reading it.
  Every tick here returns what it started and what it skipped, with a reason.

  Background:
    Given an empty store
    And nothing is running

  Scenario: A queued task is started
    Given a queued task "Add due dates" on a parallel workflow
    When the scheduler ticks
    Then "Add due dates" is started
    And it is "running"

  Scenario: Nothing queued, nothing started
    When the scheduler ticks
    Then nothing is started

  Scenario: Tasks start in queue order
    Given a queued task "First" on a parallel workflow
    And a queued task "Second" on a parallel workflow
    When the scheduler ticks
    Then the started tasks are "First, Second" in that order

  Scenario: The concurrency cap holds
    Given the cap is 2
    And a queued task "First" on a parallel workflow
    And a queued task "Second" on a parallel workflow
    And a queued task "Third" on a parallel workflow
    When the scheduler ticks
    Then 2 tasks are started
    And "Third" was skipped because "at capacity"

  Scenario: Only one sequential workflow runs at a time
    Given a queued task "First" on a sequential workflow
    And a queued task "Second" on a sequential workflow
    When the scheduler ticks
    Then 1 task is started
    And "Second" was skipped because "a sequential workflow is already running"

  Scenario: A blocked lane does not hold up the queue behind it
    Given a queued task "First" on a sequential workflow
    And a queued task "Second" on a sequential workflow
    And a queued task "Third" on a parallel workflow
    When the scheduler ticks
    Then the started tasks are "First, Third" in that order

  Scenario: A sequential workflow may run alongside parallel ones
    Given a queued task "First" on a sequential workflow
    And a queued task "Second" on a parallel workflow
    When the scheduler ticks
    Then 2 tasks are started

  Scenario: A task waiting for a person does not hold a slot
    Given the cap is 1
    And a task "Waiting" is awaiting approval
    And a queued task "Next" on a parallel workflow
    When the scheduler ticks
    Then "Next" is started

  Scenario: A task waiting for a person keeps the checkout it is working in
    Given a project "api" that works in its own checkout
    And a task "Waiting" in "api" is awaiting approval
    And a queued task "Next" in "api"
    When the scheduler ticks
    Then nothing is started
    And "Next" was skipped because "the project runs one task at a time"

  Scenario: A freed slot is filled on the next tick
    Given the cap is 1
    And a queued task "First" on a parallel workflow
    And a queued task "Second" on a parallel workflow
    And the scheduler ticks
    When "First" finishes
    And the scheduler ticks again
    Then "Second" is started

  Scenario: A task is never handed over twice
    Given the cap is 3
    And a queued task "First" on a parallel workflow
    When the scheduler ticks twice
    Then "First" was handed over once

  Scenario: A tick asked for during a tick happens after it
    Given the cap is 3
    And a queued task "First" on a parallel workflow
    And a queued task "Second" on a parallel workflow
    And the scheduler ticks whenever a task changes state
    When a task is queued
    Then all the queued tasks are started
    And no transaction was still open when a tick ran

  Scenario: A task waits until the flag its workflow requires is set
    Given a queued task "Build" whose workflow requires "hasWorktree"
    When the scheduler ticks
    Then nothing is started
    And "Build" was skipped because "a required flag is not set"
    And the report names "hasWorktree"
    And "Build" is still "queued"

  Scenario: The task runs once the flag is set
    Given a queued task "Build" whose workflow requires "hasWorktree"
    And the scheduler ticks
    When "Build" earns "hasWorktree"
    And the scheduler ticks again
    Then "Build" is started

  Scenario: A loop waiting for its next iteration is left alone
    Given a queued task "Watch" that may not run for another minute
    When the scheduler ticks
    Then nothing is started
    And "Watch" was skipped because "waiting for its next iteration"

  Scenario: The iteration starts once its time has come
    Given a queued task "Watch" that may not run for another minute
    And the scheduler ticks
    When a minute passes
    And the scheduler ticks again
    Then "Watch" is started

  Scenario: An approved task is picked back up
    Given a task "Waiting" that was approved and is holding a paused run
    When the scheduler ticks
    Then "Waiting" was handed over once

  Scenario: A task already being worked on is not handed over again
    Given a task "Waiting" that was approved and is holding a paused run
    And the scheduler ticks
    When the scheduler ticks again
    Then "Waiting" was handed over once

  Scenario: A task the engine refuses is blocked, and the scheduler carries on
    Given a queued task "Broken" on a parallel workflow
    And handing a task over fails with "the worktree is missing"
    And a queued task "Fine" on a parallel workflow
    When the scheduler ticks
    And the work settles
    Then "Broken" is "blocked"
    And "Broken" says why it is blocked
    And "Fine" is "running"

  Rule: a project that shares one checkout runs one task at a time

    A slot is global, and an unattended approval gate must never hold one — that
    is what the scenario above is about. A working copy is not global, and an
    unattended gate must hold it: the task parked there has uncommitted changes
    in the tree, and a second task would edit them underneath the person
    reviewing.

    A blocked task is the other way round. It has stopped, and holding the
    project until somebody deals with it would let one forgotten failure freeze
    a repository indefinitely. Its changes are still in the tree, which doctor
    says out loud rather than the scheduler pretending otherwise.

    Scenario: A project that works in its own checkout starts one task and no more
      Given a project "api" that works in its own checkout
      And a queued task "First" in "api"
      And a queued task "Second" in "api"
      When the scheduler ticks
      Then 1 task is started
      And "Second" was skipped because "the project runs one task at a time"

    Scenario: The task left waiting is told which project, and which task has it
      Given a project "api" that works in its own checkout
      And a queued task "First" in "api"
      And a queued task "Second" in "api"
      When the scheduler ticks
      Then the reason given to "Second" names "api"
      And the reason given to "Second" names "First"

    Scenario: Work in other projects carries on regardless
      Given a project "api" that works in its own checkout
      And a project "web" that gives each task a worktree
      And a queued task "First" in "api"
      And a queued task "Second" in "api"
      And a queued task "Third" in "web"
      When the scheduler ticks
      Then the started tasks are "First, Third" in that order

    Scenario: A project no lookup can answer for holds nothing
      Given a queued task "First" in a project the lookup cannot see
      And a queued task "Second" in the same project
      When the scheduler ticks
      # Not a project somebody removed: removing one that still has tasks is
      # refused. This is a scheduler built without a project store at all, or a
      # row edited away by hand. Defaulting to "exclusive" would stall the work
      # for no reason.
      Then 2 tasks are started

    Scenario: A project that gives each task a worktree runs as many as capacity allows
      Given a project "web" that gives each task a worktree
      And a queued task "First" in "web"
      And a queued task "Second" in "web"
      When the scheduler ticks
      Then 2 tasks are started

    Scenario: The project is free again once the task that had it finishes
      Given a project "api" that works in its own checkout
      And a queued task "First" in "api"
      And a queued task "Second" in "api"
      And the scheduler ticks
      When "First" finishes
      And the scheduler ticks again
      Then "Second" is started

    Scenario: A blocked task lets the project go
      Given a project "api" that works in its own checkout
      And a task "Stopped" in "api" is blocked
      And a queued task "Next" in "api"
      When the scheduler ticks
      Then "Next" is started

    Scenario: A busy project does not hold up the queue behind it
      Given a project "api" that works in its own checkout
      And a project "web" that gives each task a worktree
      And a queued task "First" in "api"
      And a queued task "Second" in "api"
      And a queued task "Loose" in "web"
      When the scheduler ticks
      Then the started tasks are "First, Loose" in that order

    Scenario: An approved task is picked back up even though its project is busy with it
      Given a project "api" that works in its own checkout
      And a task "Waiting" in "api" that was approved and is holding a paused run
      When the scheduler ticks
      Then "Waiting" was handed over once

  Rule: a workflow means whatever the task's own project says it means

    A name is resolved through a scope chain, and a project has its own. Two
    repositories can both define "build" and mean different things by it, so
    the scheduler has to ask about the workflow *and* the project — otherwise a
    workflow one repository marked sequential is run alongside others because
    some other repository's copy said parallel.

    Scenario: A workflow's lane is read from the task's own project
      Given a project "api" where "build" runs one task at a time
      And a project "web" where "build" runs alongside others
      And a queued task "Api one" on "build" in "api"
      And a queued task "Api two" on "build" in "api"
      And a queued task "Web one" on "build" in "web"
      When the scheduler ticks
      Then the started tasks are "Api one, Web one" in that order
      And "Api two" was skipped because "a sequential workflow is already running"

  Rule: a task waits for the tasks it depends on

    Queueing always works. The holding happens here, which is what lets a
    person queue ten tasks in dependency order and walk away rather than
    queueing one and watching for it to finish.

    A blocker that can never finish is different in kind from one that has not
    finished yet. Waiting for something cancelled is not waiting, it is
    stalling, so the dependent leaves the queue and says why.

    Scenario: A task waits for its blocker
      Given a queued task "Scaffold" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And "The model" waits for "Scaffold"
      When the scheduler ticks
      Then the started tasks are "Scaffold" in that order
      And "The model" was skipped because "a task it depends on is not done"
      And "The model" is "queued"

    Scenario: The skip names the blocker
      Given a queued task "Scaffold" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And "The model" waits for "Scaffold"
      When the scheduler ticks
      # "Nothing is running and nothing says why" was the prototype's whole
      # problem. A reason without the name is only half an answer.
      Then the skip detail for "The model" names "Scaffold"

    Scenario: It starts once the blocker is done
      Given a queued task "Scaffold" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And "The model" waits for "Scaffold"
      And the scheduler ticks
      When "Scaffold" is done
      And the scheduler ticks again
      Then "The model" is started

    Scenario: A task with no dependencies is unaffected
      Given a queued task "Add due dates" on a parallel workflow
      When the scheduler ticks
      Then "Add due dates" is started

    Scenario: Two tasks waiting for the same blocker both go when it is done
      Given a queued task "Scaffold" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And a queued task "The view" on a parallel workflow
      And "The model" waits for "Scaffold"
      And "The view" waits for "Scaffold"
      And the scheduler ticks
      When "Scaffold" is done
      And the scheduler ticks again
      # The parallelism a project asks for: nothing here makes siblings queue
      # behind each other.
      Then the started tasks are "The model, The view" in that order

    Scenario: A chain runs one at a time in order
      Given a queued task "One" on a parallel workflow
      And a queued task "Two" on a parallel workflow
      And a queued task "Three" on a parallel workflow
      And "Two" waits for "One"
      And "Three" waits for "Two"
      When the scheduler ticks
      Then the started tasks are "One" in that order

    Scenario: Waiting outranks the lane
      Given a queued task "Scaffold" on a sequential workflow
      And a queued task "The model" on a sequential workflow
      And "The model" waits for "Scaffold"
      When the scheduler ticks
      # Both are true. The blocker is a task of theirs in the same project and
      # something they can act on; the lane names whatever happens to be
      # running somewhere else.
      Then "The model" was skipped because "a task it depends on is not done"

    Scenario: Waiting outranks the shared checkout
      Given a project "api" that works in its own checkout
      And a queued task "Scaffold" in "api"
      And a queued task "The model" in "api"
      And "The model" waits for "Scaffold"
      When the scheduler ticks
      Then "The model" was skipped because "a task it depends on is not done"

    Scenario: Capacity still comes first
      Given the cap is 1
      And a queued task "Scaffold" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And "The model" waits for "Scaffold"
      # Nothing can start at all, so there is nothing to say about what it
      # waits for.
      When the scheduler ticks
      Then "The model" was skipped because "at capacity"

    Scenario: A cancelled blocker blocks its dependent
      Given a queued task "Scaffold" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And "The model" waits for "Scaffold"
      And "Scaffold" is cancelled
      When the scheduler ticks
      Then "The model" is "blocked"
      And the tick reports blocking "The model"
      And the reason for "The model" says "Scaffold" was cancelled

    Scenario: A blocked blocker blocks its dependent
      Given a queued task "Scaffold" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And "The model" waits for "Scaffold"
      And "Scaffold" is blocked
      When the scheduler ticks
      Then "The model" is "blocked"
      And the reason for "The model" says "Scaffold" is blocked

    Scenario: A dependent taken out of the queue is not also reported as skipped
      Given a queued task "Scaffold" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And "The model" waits for "Scaffold"
      And "Scaffold" is cancelled
      When the scheduler ticks
      Then nothing was skipped

    Scenario: Retrying the blocker puts the dependent back to waiting
      Given a queued task "Scaffold" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And "The model" waits for "Scaffold"
      And "Scaffold" is cancelled
      And the scheduler ticks
      When "Scaffold" is queued again
      And "The model" is retried
      And the scheduler ticks again
      Then the started tasks are "Scaffold" in that order
      And "The model" was skipped because "a task it depends on is not done"

    Scenario: A blocker archived after finishing is done enough
      Given a queued task "Scaffold" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And "The model" waits for "Scaffold"
      And "Scaffold" is done
      When "Scaffold" is archived
      And the scheduler ticks
      # Tidying a finished task away must not stall everything behind it.
      Then "The model" is started

    Scenario: A blocker archived without finishing is a dead end
      Given a queued task "Scaffold" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And "The model" waits for "Scaffold"
      And "Scaffold" is cancelled
      When "Scaffold" is archived
      # `archived` is reachable from `done` and from `cancelled` alike, so the
      # state alone cannot tell "finished, then put away" from "put away".
      And the scheduler ticks
      Then "The model" is "blocked"

    Scenario: A dead blocker settles it even while another is still going
      Given a queued task "Scaffold" on a parallel workflow
      And a queued task "Groundwork" on a parallel workflow
      And a queued task "The model" on a parallel workflow
      And "The model" waits for "Scaffold"
      And "The model" waits for "Groundwork"
      And "Scaffold" is cancelled
      When the scheduler ticks
      # Waiting for something that can never come is not waiting. One dead
      # blocker settles the question however many others are merely in flight.
      Then "The model" is "blocked"
      And the reason for "The model" says "Scaffold" was cancelled
