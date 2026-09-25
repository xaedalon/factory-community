Feature: Work that starts work, and how far that may go
  Until Factory served MCP, everything that could start work was a person: one
  at the board, one at a terminal. An agent Factory launches can reach the
  daemon too — it is on 127.0.0.1, there is no authentication, and the address
  is not credential-shaped so it survives the environment filter. Serving MCP
  did not create that reach. It made it ergonomic, and an ergonomic way to start
  work from inside work is an ergonomic way to start work from inside that.

  So there is a limit, and it lives here rather than in whichever client is
  asking. The disclaimer settled that argument once: a rule only the web app
  enforces is advice, with `curl` as the exception.

  Two things the rules are careful about. A request with nothing behind it is a
  person — depth zero, no limit to reach — and that is the direction a client
  can move itself in by staying quiet, which loses authority rather than gaining
  it. And a refusal changes nothing that is already running: the work in flight
  is somebody's, and stopping it because its agent asked for one task too many
  would punish the wrong thing.

  Background:
    Given nothing has run yet

  Rule: work started by a person is at the top of the tree

    Scenario: A request with no run behind it is depth zero
      When somebody with no run asks for a task
      Then it is allowed
      And its run would be at depth 0

    Scenario: A request from inside a run is one deeper
      Given a run "run-1" at depth 0
      When the agent in "run-1" asks for a task
      Then it is allowed
      And its run would be at depth 1

    Scenario: A run whose parent Factory has never heard of is treated as the top
      # A hand-edited database, or a stamp from an installation that was
      # rebuilt. Treating it as depth 0 is the safe direction: it bounds the
      # tree from here rather than refusing work somebody is waiting on.
      When the agent in a run nobody has heard of asks for a task
      Then it is allowed
      And its run would be at depth 1

  Rule: the tree has a bottom

    Scenario: Three deep is allowed
      Given a run "run-3" at depth 2
      When the agent in "run-3" asks for a task
      Then it is allowed
      And its run would be at depth 3

    Scenario: Four deep is refused
      Given a run "run-4" at depth 3
      When the agent in "run-4" asks for a task
      Then it is refused as RECURSION_LIMIT
      And the refusal says to do it itself or ask a person

    Scenario: The limit is the installation's to set
      Given the installation allows only one level
      And a run "run-1" at depth 1
      When the agent in "run-1" asks for a task
      Then it is refused as RECURSION_LIMIT

  Rule: one run may only ask for so much

    Scenario: The tenth task is allowed
      Given a run "run-1" at depth 0 that has asked for 9 tasks
      When the agent in "run-1" asks for a task
      Then it is allowed

    Scenario: The eleventh is refused
      Given a run "run-1" at depth 0 that has asked for 10 tasks
      When the agent in "run-1" asks for a task
      Then it is refused as FAN_OUT_LIMIT
      And the refusal says to finish or cancel some first

  Rule: an agent may not reach around the run it is in

    The mildest outcome is a deadlock nobody can see: a task waiting on itself,
    with the agent that would finish it waiting for the queue.

    Scenario: It cannot queue its own task
      Given an agent running task "task-1" in run "run-1"
      When it tries to queue "task-1"
      Then it is refused as SELF_ORCHESTRATION_BLOCKED
      And the refusal tells it to create a separate task

    Scenario: It cannot cancel its own task
      Given an agent running task "task-1" in run "run-1"
      When it tries to cancel "task-1"
      Then it is refused as SELF_ORCHESTRATION_BLOCKED

    Scenario: It may act on another task
      Given an agent running task "task-1" in run "run-1"
      When it tries to queue "task-2"
      Then it is allowed

    Scenario: A person is not running inside anything
      When somebody with no run tries to queue "task-1"
      Then it is allowed

  Rule: an agent may not approve what its own branch asked for

    The rule this whole model exists for. An agent that can approve the
    escalation it requested has no gate at all, only a delay.

    Scenario: It cannot approve a task it asked for itself
      Given an agent in run "run-1"
      And the task "task-2" was asked for by "run-1"
      When it tries to approve "task-2"
      Then it is refused as APPROVAL_SEPARATION
      And the refusal says an approval an agent can give itself is not a gate

    Scenario: It cannot approve a task its parent asked for
      Given a run "run-2" that came from "run-1"
      And an agent in run "run-2"
      And the task "task-3" was asked for by "run-1"
      When it tries to approve "task-3"
      Then it is refused as APPROVAL_SEPARATION

    Scenario: It may approve work from outside its own branch
      Given an agent in run "run-1"
      And the task "task-9" was asked for by a run in another tree
      When it tries to approve "task-9"
      Then it is allowed

    Scenario: It may approve work a person asked for
      Given an agent in run "run-1"
      And the task "task-9" was asked for by a person
      When it tries to approve "task-9"
      Then it is allowed

    Scenario: A ring in the ancestry is walked once, not for ever
      # A hand-edited database. The alternative to guarding it is a daemon that
      # hangs on one request until somebody restarts it.
      Given a run "run-1" that came from "run-2"
      And a run "run-2" that came from "run-1"
      And an agent in run "run-1"
      And the task "task-9" was asked for by a person
      When it tries to approve "task-9"
      Then it is allowed
