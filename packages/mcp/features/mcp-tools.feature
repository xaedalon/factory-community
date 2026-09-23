Feature: The tools an agent is given
  Fifteen tools over one HTTP API. What matters is not that each one reaches a
  route — that part is arithmetic — but what comes back, because the reader is a
  model deciding what to do next and it will act on whatever it is told.

  So three things are served rather than worked out here. What a task will
  accept right now comes from the daemon, which is the same list the board draws
  its buttons from; a client that re-derived it would offer something the daemon
  refuses. Which workflows a project can run comes from the project's own scope
  chain. And a truncated log says it is truncated, because a log that lost its
  middle and reads like a complete one is how an agent concludes a build passed.

  What is deliberately *not* here: a tool to start a run, and a tool to cancel
  one. Nothing in Factory starts a run directly — queueing a task is what starts
  work and cancelling it is what stops work — so both are actions on a task, and
  a second way to do either would be a second set of rules to keep honest.

  Background:
    Given a Factory with the project "factory"
    And an agent working in that project

  Rule: a task carries the actions it will accept, never a guess

    Scenario: A task offers what the daemon said it offers
      Given a draft task "Add due dates" the daemon says can be queued
      When the agent reads that task
      Then the actions offered are "queue"
      And it is told to queue it when the plan is right
      # What the work is *for* is the thing a model most needs and the thing a
      # summary most easily drops.
      And it says what the work is for

    Scenario: A task an agent asked for says which run asked
      Given a task "Add due dates" that a run asked for
      When the agent reads that task
      Then it says which run asked for it
      And it says what that client called itself

    Scenario: A task waiting for a person says a person has to decide
      Given a task "Add due dates" waiting for approval
      When the agent reads that task
      Then it is told a person has to approve or reject it

    Scenario: Tasks in another project are not listed
      Given a task "Add due dates" in "factory"
      And a task "Somebody else's" in another project
      When the agent lists the tasks
      Then only "Add due dates" is listed

    Scenario: Only tasks that have not finished, when that is what was asked
      Given a task "Add due dates" in "factory"
      And a finished task "Ship it" in "factory"
      When the agent lists only the active tasks
      Then only "Add due dates" is listed

  Rule: what a project can run is what it is offered

    Scenario: A workflow comes with what it needs
      Given the project offers a workflow "development" that needs "analysis"
      When the agent lists the workflows
      Then "development" is offered
      And it says it needs "analysis"

    Scenario: A workflow the project cannot run yet is marked, not hidden
      # The file is still the project's to read and edit. It is only the list
      # of what to run next that has no business offering it.
      Given the project offers a workflow "merge" it cannot run without worktrees
      When the agent lists the workflows
      Then "merge" is offered
      And it says why it is unavailable

    Scenario: A phase says whether somebody has to approve it
      Given the project offers a phase "publish" that needs approval first
      When the agent lists the phases
      Then "publish" says its approval is "before"

  Rule: a run arrives with its evidence

    Scenario: A run carries its steps and what it produced
      Given a run that wrote an artifact "report.md"
      When the agent reads that run
      Then the run's steps are listed
      And "report.md" is named with its size

    Scenario: Evidence is named and sized, never quoted
      # Five artifacts of Markdown is tens of kilobytes, and a run detail is a
      # listing rather than a reading.
      Given a run that wrote an artifact "report.md"
      When the agent reads that run
      Then the answer does not contain the artifact's contents

  Rule: logs are bounded, and a log that lost its middle says so

    A run's own log holds what the engine wrote. Everything a *command* printed
    is attached to the step that printed it, so asking for a run's output and
    reading only the run's own log returns almost nothing — which is what this
    tool did until a scenario ran a real command and read back an empty string.

    Scenario: The output of every step is gathered, and each line says which
      Given a run with two steps that each printed something
      When the agent reads that run's logs
      Then both steps' output comes back
      And each line says which step printed it

    Scenario: Only the tail comes back
      Given a run whose step printed 500 lines
      When the agent reads the last 10 lines of it
      Then 10 lines come back
      And it says 490 older lines were not sent

    Scenario: What Factory dropped is counted apart from what was not sent
      # Two different losses. Conflating them is a lie in one direction or the
      # other: one is the daemon's log budget, the other is this call's tail.
      Given a run whose log Factory had to trim by 2048 bytes
      When the agent reads that run's logs
      Then it says Factory dropped something

    Scenario: One step's output can be asked for on its own
      Given a run whose step printed 500 lines
      When the agent reads the logs of step 3
      Then Factory was asked for step 3 only
      And nothing else was asked for

  Rule: what is waiting for a person is reported, not answered

    Scenario: A parked task names its run and where it continues from
      Given a task "Add due dates" parked at a gate in the run "run-1"
      When the agent asks what is waiting
      Then "Add due dates" is waiting
      And the answer names the run "run-1"
      And it says a person has to decide

    Scenario: Nothing waiting says so plainly
      Given a task "Add due dates" in "factory"
      When the agent asks what is waiting
      Then nothing is waiting

  Rule: creating a task starts nothing

    A task is a piece of work with an ordered list of workflows. Making one is
    a note; queueing it is the thing that spawns agents against somebody's
    repository. Keeping those two apart is what lets an agent propose work
    without doing it.

    Scenario: A task lands in the project the agent is working in
      Given the agent is working in "factory"
      When the agent creates the task "Add due dates" with the workflow "development"
      Then Factory was told to put it in "factory"
      And Factory was told to run "development"
      And the agent is told to queue it when the plan is right

  Rule: queueing is what starts work, and cancelling is what stops it

    There is no tool to start a run and none to cancel one, and that is the
    design rather than an omission: nothing in Factory starts a run directly,
    and the engine kills a run's process group on any transition to cancelled,
    whoever asked for it. A second door onto either would be a second set of
    rules to keep honest.

    Scenario: There is no tool to start a run, and none to cancel one
      Then no tool is called "factory_run_start"
      And no tool is called "factory_run_cancel"

    Scenario: Queueing asks for the action by name
      Given a task "Add due dates" that can be queued
      When the agent queues it
      Then Factory was asked to queue that task

    Scenario: Queueing before anybody accepted the disclaimer carries the disclaimer
      # An agent cannot accept it. Somebody has to read what an agent run can
      # reach and agree to it, and the text is what they are agreeing to.
      Given Factory has not been told what an agent run can reach
      When the agent queues a task
      Then it is refused as NOT_ACCEPTED
      And the refusal carries the disclaimer
      And it says a person has to accept it

    Scenario: An action the task does not offer comes back with the ones it does
      Given a task that cannot be queued because it is already running
      When the agent queues it
      Then it is refused as ACTION_NOT_AVAILABLE
      And the refusal lists the actions it does offer

  Rule: a workflow is copied rather than assembled

    Assembling one out of phase names is how an agent produces a workflow that
    parses and does nothing useful. Copying one the project already runs keeps
    everything nobody thought to ask about — what it needs, what it provides,
    what happens when it fails, and its variables.

    Scenario: Copying keeps everything the original had
      Given the project has a workflow "development" that needs "analysis"
      When the agent copies it as "development-fast"
      Then Factory was asked to write "development-fast"
      And what was written still needs "analysis"

    Scenario: A workflow with no phases and nothing to copy is refused
      When the agent writes a workflow with no phases
      Then it is refused
      And nothing was written

    Scenario: It goes into the project unless somebody says otherwise
      Given the project has a workflow "development" that needs "analysis"
      When the agent copies it as "development-fast"
      Then it was written into the project's own scope

  Rule: approving is a person's, and the surface says so by not offering it

    Factory can tell an agent it launched from a person's own session: the
    first carries the run it is inside, the second carries nothing. What it
    cannot tell apart is a person's session from an agent acting unasked in
    that session, because they are the same process with the same environment.

    An approval an agent can give is not a gate, only a delay. So it is not
    offered here at all — which is the strongest form the rule can take, and
    the only one that does not depend on knowing who is typing.

    The daemon still refuses an approval from inside the branch that asked for
    the work, because this surface is not its only client.

    Scenario: The action list does not include approving
      Then an agent may not ask to "approve"
      And an agent may not ask to "reject"

    Scenario: Everything else a person can ask for is offered
      Then an agent may ask to "queue"
      And an agent may ask to "cancel"
      And an agent may ask to "mark_done"
