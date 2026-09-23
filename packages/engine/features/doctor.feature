Feature: Doctor, for an installation that is running
  The built-in rules check what is installed — do the definitions parse, does
  every phase exist, is the agent on PATH. They answer from files alone, so
  they run anywhere, including a CLI invocation with no database open.

  These rules answer the other half: why is this task not running, what is
  waiting for me, and what did the last crash cost. They exist only where the
  store does, and they arrive the same way any plugin's rules do — so a process
  without a database simply has fewer rules, with nothing to configure and
  nothing to switch off.

  Background:
    Given an empty store
    And the workflow "hello" exists

  Scenario: A healthy installation has nothing to say
    Given a task "Add due dates" on "hello"
    When doctor runs
    Then doctor reports nothing

  Scenario: A task waiting on a flag is explained
    Given the workflow "deploy" requires "hasWorktree"
    And a queued task "Ship it" on "deploy"
    When doctor runs
    Then doctor says "Ship it" is waiting for "hasWorktree"

  Scenario: A task waiting on a flag it already has is not reported
    Given the workflow "deploy" requires "hasWorktree"
    And a queued task "Ship it" on "deploy"
    And "Ship it" has the flag "hasWorktree"
    When doctor runs
    Then doctor reports nothing

  Scenario: A task pointed at a workflow that no longer exists
    Given a task "Add due dates" on "gone"
    When doctor runs
    Then doctor says "gone" does not exist

  Scenario: A task waiting for a person is surfaced
    Given a task "Add due dates" on "hello" that is awaiting approval
    When doctor runs
    Then doctor says someone needs to approve "Add due dates"

  Scenario: A blocked task carries its reason into the report
    Given a task "Add due dates" on "hello" that is blocked because "the tests failed"
    When doctor runs
    Then doctor repeats "the tests failed"

  Scenario: What the boot had to close is reported
    Given the last stop left a run of "hello" marked running
    When Factory starts and reconciles
    And doctor runs
    Then doctor says a run was closed because Factory stopped

  Scenario: A run and its task disagreeing is an error
    Given a task "Add due dates" on "hello" that is blocked because "the tests failed"
    And a run of "hello" for it is still marked running
    When doctor runs
    Then doctor reports an error about a run whose task is not running

  Scenario: A project whose directory has gone is an error
    Given the project "factory" exists
    And its directory is deleted
    When doctor runs
    Then doctor reports an error about the project's path

  Scenario: A task claiming a worktree that is not there
    Given the project "factory" exists
    And a task "Add due dates" in it with the flag "hasWorktree"
    When doctor runs
    Then doctor reports an error about the missing worktree
    And the error says where the work would run instead

  Scenario: Somewhere to work is a setup step, not a fault
    Given no projects
    When setup is checked
    Then "a-project" is not done
    And it is marked essential
    And it offers the projects page
    # And a command for the terminal, which must not name an address. It
    # printed `curl 127.0.0.1:7317/api/projects` until an agent following the
    # setup runbook on FACTORY_PORT=7717 was handed a port nothing was
    # listening on. The CLI resolves the daemon in one place; a hint that
    # repeats that decision is a second copy of it, and this is the wrong half
    # of the codebase to keep it in.
    And its terminal hint is a command, not a port

  Scenario: A registered project finishes the step
    Given the project "factory" exists
    When setup is checked
    Then "a-project" is done
    And the detail names the repository

  Scenario: A worktree that is not there is not a fault where worktrees are off
    Given the project "in-place" exists and works in its own checkout
    And a task "Add due dates" in it with the flag "hasWorktree"
    When doctor runs
    Then doctor reports nothing about a missing worktree

  Scenario: A task waiting for a person in a shared checkout says what it holds up
    Given the project "in-place" exists and works in its own checkout
    And a task "Add due dates" in it is awaiting approval
    When doctor runs
    Then doctor says nothing else in "in-place" can start

  Scenario: A blocked task in a shared checkout says what it left behind
    Given the project "in-place" exists and works in its own checkout
    And a task "Add due dates" in it is blocked
    When doctor runs
    Then doctor says what it left behind is still there

  Scenario: A flag nothing the task is assigned provides is a dead end
    Given the workflow "deploy" requires "hasWorktree"
    And a queued task "Ship it" on "deploy"
    When doctor runs
    Then doctor reports an error about the flag
    And the error says nothing it is assigned provides it

  Scenario: A flag provided by a workflow that runs later is a dead end too
    Given the workflow "deploy" requires "hasWorktree"
    And the workflow "prepare" provides "hasWorktree"
    And a queued task "Ship it" on "deploy" and then "prepare"
    When doctor runs
    Then doctor reports an error about the flag
    And the error says "prepare" comes too late

  Scenario: Without a store there are no running rules
    When doctor runs with no store
    Then doctor has only the installation rules

  Rule: a built-in that asks to be overridden is reported where it is used

    Some built-ins cannot know your setup — where a worktree goes, what an
    environment is made of. They declare `override: required`, and Factory reads
    the declaration rather than recognising the name. The prototype switched on
    workflow names in the engine, so only four blessed names could mean anything
    and renaming one broke it silently.

    Reported on use, never on existence: a workflow nobody has assigned is not a
    problem waiting to happen, and a project that never uses worktrees should
    hear nothing about worktree-create.

    Scenario: A task about to run the built-in copy is reported
      Given the project "in-place" exists and works in its own checkout
      And the workflow "worktree-create" must be overridden and resolves from the builtin scope
      And a task "Ship it" in that project on "worktree-create"
      When doctor runs
      Then doctor reports an error naming the file to create

    Scenario: A project that has made its own copy is not reported
      Given the project "in-place" exists and works in its own checkout
      And the workflow "worktree-create" must be overridden and resolves from the project scope
      And a task "Ship it" in that project on "worktree-create"
      When doctor runs
      Then doctor reports nothing

    Scenario: A workflow that asks for nothing is never reported
      Given the project "in-place" exists and works in its own checkout
      And a task "Ship it" in that project on "hello"
      When doctor runs
      Then doctor reports nothing

    Scenario: A task nobody assigned it to is not reported
      Given the project "in-place" exists and works in its own checkout
      And the workflow "worktree-create" must be overridden and resolves from the builtin scope
      And a task "Ship it" in that project on "hello"
      When doctor runs
      Then doctor reports nothing

  Rule: a task that runs a workflow before what it needs is reported

    The builder assembles the list correctly. This is for one assembled another
    way — by the API, by hand, or before the predecessor existed. Reported
    rather than repaired, for the same reason a flag dead end is: a task's list
    is a plan somebody wrote, and quietly rewriting it is worse than saying it
    is wrong.

    Scenario: A predecessor that comes later in the list is an error
      Given "verify" needs "validate"
      And a task assigned "verify" then "validate"
      When doctor runs
      Then it says "verify" runs before "validate"

    Scenario: A predecessor missing from the list altogether is an error
      Given "verify" needs "validate"
      And a task assigned only "verify"
      When doctor runs
      Then it says "validate" is not in the list

    Scenario: A correctly ordered task is not reported
      Given "verify" needs "validate"
      And a task assigned "validate" then "verify"
      When doctor runs
      Then nothing is out of order

    Scenario: A finished task is left alone
      Given "verify" needs "validate"
      And a task assigned only "verify" that is already done
      When doctor runs
      Then nothing is out of order

  Rule: a task waiting for something that can never finish is reported

    The scheduler already blocks a *queued* task whose blocker is dead, with
    the reason — that is what `doctor.taskBlocked` repeats. A task that has not
    been queued yet says nothing at all, so a plan assembled in advance can sit
    there with an edge to a task somebody cancelled last week, and the first
    anybody hears of it is when the batch refuses to start it.

    Only the edges that can never be satisfied. Waiting for something that has
    not run yet is what waiting is for, and reporting it would make doctor's
    output a list of everything in progress.

    Scenario: A draft waiting on a cancelled task is reported
      Given a task "Ship it" waiting for "Build" in the same project
      And "Build" was cancelled
      When doctor runs
      Then doctor says "Ship it" is waiting for something that cannot finish
      And it names "Build" and why

    Scenario: Waiting for something still to run is not reported
      Given a task "Ship it" waiting for "Build" in the same project
      When doctor runs
      Then nothing is reported about the graph

    Scenario: Waiting for something already done is not reported
      Given a task "Ship it" waiting for "Build" in the same project
      And "Build" is done
      When doctor runs
      Then nothing is reported about the graph

    Scenario: A task already blocked is left to the rule that covers it
      Given a task "Ship it" waiting for "Build" in the same project
      And "Build" was cancelled
      And "Ship it" is blocked
      When doctor runs
      # `doctor.taskBlocked` says so already, with the reason it was blocked
      # for, and two rules saying the same thing about one task is noise.
      Then nothing is reported about the graph

  Rule: a Factory directory git has half an opinion about is reported

    Two states are coherent and say nothing. Everything ignored is somebody
    trying Factory out on their own machine, which is the default. Everything
    committed is a team sharing its workflows, which is the decision they made.

    What is worth a sentence is the middle. A task's artifacts or Factory's own
    database in somebody's history will grow and conflict on every run. And
    definitions committed into a directory that has *since* been ignored are
    the expensive one: the workflows already there keep working, so nothing
    looks wrong, while every workflow anybody writes afterwards never appears
    in `git status` — nobody finds out it is missing.

    Only git can answer this, so the rule asks it. A machine with no git, a
    project that is not a repository and a directory that has gone all answer
    the same way: nothing, because a diagnosis nobody can act on is worse than
    silence.

    The user scope is not examined. `~/.xaedalon` inside somebody's dotfiles
    repository is a legitimate choice, and this rule walks registered projects.

    Scenario: A project whose Factory directory is entirely ignored says nothing
      Given a project in a repository
      And git tracks nothing of its Factory directory
      When doctor runs
      Then doctor says nothing about git

    Scenario: A project whose definitions are committed and visible says nothing
      Given a project in a repository
      And git tracks its definitions
      And nothing ignores them
      When doctor runs
      Then doctor says nothing about git

    Scenario: A committed database is reported
      Given a project in a repository
      And git tracks its database
      When doctor runs
      Then doctor says a run's output is committed
      And it names the file
      And it says how to untrack it

    Scenario: Committed task artifacts are reported
      Given a project in a repository
      And git tracks two of its task artifacts
      When doctor runs
      Then doctor says a run's output is committed

    Scenario: Definitions committed into a directory that is now ignored is an error
      Given a project in a repository
      And git tracks its definitions
      And something ignores them
      When doctor runs
      Then doctor says a new workflow would never be seen
      And it names the file and line that hid them

    Scenario: A partial opt-in that re-includes the definitions is not reported
      Given a project in a repository
      And git tracks its definitions
      And something ignores them and then takes it back
      When doctor runs
      # A negated pattern is a re-inclusion. Reading it as an exclusion would
      # report the person who did exactly the right thing.
      Then doctor says nothing about git

    Scenario: A machine with no git says nothing
      Given a project in a repository
      And git cannot be asked
      When doctor runs
      # And says nothing because it did not run, not because it threw — a rule
      # that throws becomes a problem of its own, which would look like silence
      # to anybody only counting this rule's findings.
      Then doctor says nothing about git

    Scenario: A project that is not a repository is never asked about
      Given a project that is not a repository, and a git that would answer
      When doctor runs
      Then doctor says nothing about git
      And git was not asked
