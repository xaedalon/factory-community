Feature: The factory command
  The command line is where the definition layer becomes usable. Everything it
  needs — a scope chain, a capability host, an environment — is passed in, so
  the commands are functions of their arguments rather than of the machine.

  Two of these exist because of specific incidents in the prototype's backlog.
  `why` answers "which file am I actually running?", which layered resolution
  makes non-obvious. `doctor` answers "why doesn't this work?", which used to
  mean reading YAML by eye after a failure that named no file, no line and no
  field.

  Background:
    Given a project scope and a user scope

  Scenario: config path shows where Factory is reading from
    When I run "config path"
    Then it succeeds
    And the output lists the scopes in order "project, user, builtin"
    And the output says new definitions go to the project scope

  Scenario: init creates a scope that is ready to use
    Given the project scope does not exist yet
    When I run "init"
    Then it succeeds
    And a scope config is written
    And a workflows directory is created
    And a phases directory is created

  Scenario: init is safe to run twice
    When I run "init"
    And I run "init"
    Then it succeeds
    And the output says it is already initialised

  Scenario: workflow list shows what is available and where it came from
    Given the project scope defines the workflow "release"
    When I run "workflow list"
    Then it succeeds
    And the output mentions "release"
    And the output mentions "hello-world"

  Scenario: workflow list marks a definition that shadows another
    Given the project scope defines the workflow "hello-world"
    When I run "workflow list"
    Then it succeeds
    And the output says something shadows the builtin scope

  Scenario: workflow show prints the file and where it came from
    Given the project scope defines the workflow "release"
    When I run "workflow show release"
    Then it succeeds
    And the output mentions the project scope
    And the output contains the file's own text

  Scenario: workflow show explains a name that does not exist
    When I run "workflow show nowhere"
    Then it fails
    And the output suggests running why

  Scenario: why lists every path that was tried
    Given the project scope defines the workflow "hello-world"
    When I run "why workflow hello-world"
    Then it succeeds
    And the output marks the project copy as used
    And the output marks the builtin copy as hidden
    And the output mentions the user scope path that does not exist

  Scenario: doctor is quiet when nothing is wrong
    When I run "doctor"
    Then the output reports the number of rules run

  Scenario: doctor reports a definition that does not validate
    Given the project scope defines a broken workflow "oops"
    When I run "doctor"
    Then it fails
    And the output names the file and line
    And the output names the field "mode"

  Scenario: doctor reports a workflow naming a phase that does not exist
    Given the project scope defines the workflow "dangling" naming a missing phase
    When I run "doctor"
    Then it fails
    And the output says the phase does not exist

  Scenario: doctor warns about an agent that is not installed
    When I run "doctor"
    Then the output warns that a provider is not installed
    And the output says how to point Factory at it

  Scenario: a warning alone does not fail the command
    Given the project scope defines the workflow "hello-world"
    When I run "doctor"
    Then it succeeds

  Scenario: capabilities lists what is installed and who provided it
    When I run "capabilities"
    Then it succeeds
    And the output mentions "step-kind"
    And the output mentions "provider"
    And the output mentions "doctor-rule"

  Scenario: provider list says which agents are actually present
    When I run "provider list"
    Then it succeeds
    And the output mentions "claude"
    And the output marks codex as having an unverified descriptor

  Scenario: step-kind list says which kinds can run
    When I run "step-kind list"
    Then it succeeds
    And the output marks "shell" as runnable

  Scenario: json output is machine-readable
    Given the project scope defines the workflow "release"
    When I run "workflow list --json"
    Then it succeeds
    And the output parses as JSON

  Scenario: an unknown command explains itself
    When I run "frobnicate"
    Then it is a usage error
    And the output shows the usage

  Scenario: no arguments shows the usage
    When I run ""
    Then it is a usage error
    And the output shows the usage

  Scenario: running the built-in workflow works out of the box
    When I run "run hello-world --yes"
    Then it succeeds
    And the output says it completed

  Scenario: a dry run prints the command and runs nothing
    Given the project defines a workflow that writes a file
    When I run "run writes --dry-run"
    Then it succeeds
    And no file was written

  Scenario: running it for real writes the file
    Given the project defines a workflow that writes a file
    When I run "run writes --yes"
    Then it succeeds
    And the file was written

  Scenario: task details fill the template tokens
    Given the project defines a workflow that echoes the ticket
    When I run "run greeting --ticket WW2-1234 --yes"
    Then it succeeds
    And the output mentions "WW2-1234"

  Scenario: an approval gate stops a run with no terminal
    When I run "run hello-world"
    Then it fails
    And the output says there is no terminal to ask

  Scenario: running a workflow that does not exist explains itself
    When I run "run nowhere"
    Then it fails
    And the output says there is no such workflow

  Scenario: colour is suppressed when NO_COLOR is set
    When I run "config path" with NO_COLOR set
    Then it succeeds
    And the output contains no escape codes

  Scenario: tasks are listed from the daemon
    Given a daemon with a task "Add due dates" that is queued
    When I run "task list"
    Then the output contains "Add due dates"
    And the output contains "queued"

  Scenario: nothing to list says how to make one
    Given a daemon with no tasks
    When I run "task list"
    Then the output contains "No tasks"
    And the output contains "factory task new"

  Scenario: a task is created with its workflows in order
    Given a daemon with no tasks
    When I run "task new Add due dates --workflow worktree-create --workflow development"
    Then the daemon was asked to create a task with workflows "worktree-create, development"
    And the output says how to start it

  Scenario: a task is moved to another project
    Given a daemon with the projects "work" and "elsewhere"
    When I run "task move task-1 elsewhere"
    Then the daemon was asked to move it to "elsewhere"
    And the output says where it is now

  Scenario: moving to a project that is not there says which exist
    Given a daemon with the projects "work" and "elsewhere"
    When I run "task move task-1 nowhere"
    Then it fails
    And the output names both projects

  Scenario: a task lands in the only project there is
    Given a daemon with one project "work"
    When I run "task new Add due dates"
    # Not typed, because there is nothing to choose between. A task needs a
    # project, and asking which of one is busywork.
    Then the daemon was asked to create it in "work"

  Scenario: with no project there is nowhere to put a task
    Given a daemon with no projects
    When I run "task new Add due dates"
    Then it fails
    And the output contains "needs a project"
    And the output says how to add one

  Scenario: with more than one project the task says which
    Given a daemon with the projects "work" and "elsewhere"
    When I run "task new Add due dates"
    Then it fails
    And the output contains "--project"
    And the output names both projects

  Scenario: showing a task lists what it can do next
    Given a daemon with a task "Add due dates" that is queued
    When I run "task show task-1"
    Then the output contains "factory task cancel"

  Scenario: an action the task cannot take explains what it can
    Given a daemon that refuses with the actions "queue, cancel"
    When I run "task approve task-1"
    Then the command fails
    And the output contains "Available: queue, cancel"

  Scenario: no daemon is explained rather than reported as a crash
    Given no daemon is running
    When I run "task list"
    Then the command fails
    And the output contains "Cannot reach the Factory daemon"
    And the output contains "factory-daemon"

  Scenario: the short id the listing prints is enough to act on
    Given a daemon with a task "Add due dates" that is queued
    When I run "task cancel task-1a2"
    Then the daemon was asked to act on the full id

  Scenario: an id that matches two tasks is refused rather than guessed
    Given a daemon with two tasks whose ids start the same way
    When I run "task cancel task-1"
    Then the command fails
    And the output says which ones it matched

  Scenario: setup says what is missing when nothing is installed
    When I run "setup"
    Then the output contains "Install a coding agent"
    And the output says how to install one
    And the output says Factory cannot run work yet

  Scenario: setup works without a daemon, and says so
    Given no daemon is running
    When I run "setup"
    Then the output says the daemon is not running

  Scenario: setup prefers the daemon, which can see the database
    Given a daemon reporting one outstanding step
    When I run "setup"
    Then the output contains "Add a repository"


  Rule: a foreground run is one conversation too

    `factory run` has no task to hang a session on, so the invocation itself is
    the scope. Without one, a workflow's phases would each be a fresh
    conversation — which is what `session: task` exists to prevent, and it
    should not depend on whether the daemon happened to start the run.

    Scenario: The phases of one run share one session
      Given the project defines a workflow with two agent phases carrying a session
      When I run "run pipeline --dry-run"
      Then it succeeds
      And the first phase starts a session
      And the second phase resumes the same one

  Rule: the plugin switches are reachable when the board is not

    The board can switch a plugin off, and the one time you most need to is
    when a plugin is stopping the daemon from starting — which is exactly when
    the board cannot help. So the same list and the same switch are here,
    reading and writing the same file.

    Scenario: The list says what is installed and whether it is on
      When I run "plugins"
      Then it succeeds
      And the output mentions "@factory/task-diffity"
      And the output says the core built-ins are required

    Scenario: Switching one off writes the settings
      When I run "plugins disable @factory/task-diffity"
      Then it succeeds
      And the settings file holds "@factory/task-diffity"
      And it says a restart will unload it

    Scenario: Switching it back on removes it
      Given "@factory/task-diffity" is switched off
      When I run "plugins enable @factory/task-diffity"
      Then it succeeds
      And nothing is switched off

    Scenario: A core built-in cannot be switched off
      When I run "plugins disable @factory/core/builtin-steps"
      Then it fails
      And the output says it would leave Factory unable to do anything

    Scenario: Switching off something nothing claims is refused
      When I run "plugins disable @acme/imaginary"
      Then it fails

    Scenario: A verb nobody recognises is a usage error
      When I run "plugins wiggle @factory/task-diffity"
      Then it is a usage error

  Rule: the terminal can accept the disclaimer, read the profile, and stop everything

    The daemon refuses to start a run until somebody has been told what a run
    can reach, and it refuses that for every client. So the terminal needs a way
    to say yes — otherwise the gate is a browser feature with a command-line
    hole in it, and anybody automating Factory is told to go and click
    something.

    Scenario: The disclaimer can be read without agreeing to it
      Given nothing has been accepted
      When I run "accept --show"
      Then it succeeds
      And the output says what an agent can do inside the workspace
      And the output names the profile that removes the boundaries
      And the output says it has not been accepted
      And nothing was recorded

    Scenario: Accepting it records the current version
      Given nothing has been accepted
      When I run "accept"
      Then it succeeds
      And the output says Factory will not ask again
      And the settings file records the accepted version

    Scenario: Accepting it twice says so and changes nothing
      Given nothing has been accepted
      And I have run "accept"
      When I run "accept"
      Then it succeeds
      And the output says it was already accepted

    Scenario: Running a workflow before accepting is refused
      Given nothing has been accepted
      When I run "run hello-world --yes"
      Then it fails
      And the output says how to accept it

    Scenario: A dry run needs no acceptance
      Given nothing has been accepted
      When I run "run hello-world --dry-run"
      # Refusing to *show* somebody what would happen until they have agreed to
      # what happens is backwards. Nothing executes.
      Then it succeeds

    Scenario: The installation profile can be read
      When I run "profile"
      Then it succeeds
      And the output says the profile is "Default"

    Scenario: The installation profile can be changed
      When I run "profile full-access"
      Then it succeeds
      And the output says the profile is "Full Access"
      And the output warns about what Full Access removes

    Scenario: A profile that is not one is refused
      When I run "profile sort-of-safe"
      Then it fails
      And the output names the profiles

    Scenario: Stopping needs to be asked for plainly
      When I run "stop"
      # "stop" alone reads as though it might mean one thing, and the one thing
      # it means is everything.
      Then the exit code is 2
      And the output mentions "--all"

    Scenario: Stopping everything reports what it stopped
      Given the daemon says two process groups were stopped
      When I run "stop --all"
      Then it succeeds
      And the output says 2 process groups were stopped

    Scenario: Stopping when nothing runs says so
      Given the daemon says nothing was running
      When I run "stop --all"
      Then it succeeds
      And the output says nothing was running

  Rule: the terminal can order the work as well as watch it

    Dependencies and the two whole-project buttons are the same two routes the
    board uses. A terminal that could only watch would make the board the only
    way to arrange work, which is the hole `accept` was added to close.

    Ids are resolved from a prefix at both ends of a dependency, because the
    listing prints eight characters and nobody types a uuid.

    Scenario: One task can be made to wait for another
      Given a daemon that accepts a dependency
      When I run "task depends task-1 task-2"
      Then it succeeds
      And the output says it waits for "Scaffold"
      And the daemon was asked to add the dependency

    Scenario: The dependency can be taken back
      Given a daemon that accepts a dependency
      When I run "task depends task-1 task-2 --remove"
      Then it succeeds
      And the daemon was asked to remove the dependency

    Scenario: Both ids are resolved from a prefix
      Given a daemon with two tasks and a dependency to add
      When I run "task depends task-100 task-200"
      Then it succeeds
      And the daemon was asked about the full ids

    Scenario: A refusal is passed through in the daemon's own words
      Given a daemon that refuses a dependency as a ring
      When I run "task depends task-1 task-2"
      Then it fails
      And the output says it would make a ring

    Scenario: Asking for a dependency without both ends says so
      When I run "task depends task-1"
      Then the exit code is 2
      And the output mentions "waits-for-id"

    Scenario: A task can be marked done from the terminal
      Given a daemon that accepts an action
      When I run "task done task-1"
      Then it succeeds
      # `done` to type, `mark_done` on the wire: the wire name says which of
      # two ways of reaching done this is, and a person has only one.
      And the daemon was asked to mark it done

    Scenario: A whole project can be queued
      Given a daemon with a project to queue
      When I run "project queue work"
      Then it succeeds
      And the output lists the tasks it queued in order
      And the output says what it skipped

    Scenario: Queueing a project with nothing to queue says so
      Given a daemon with a project and nothing to queue
      When I run "project queue work"
      Then it succeeds
      And the output says there was nothing to queue

    Scenario: A project is found by part of its name
      Given a daemon with a project to queue
      When I run "project queue wo"
      Then it succeeds

    Scenario: A name matching two projects is refused
      Given a daemon with two projects whose names start alike
      When I run "project queue we"
      Then it fails
      And the output names both projects

    Scenario: An exact name wins over a longer one starting the same way
      Given a daemon with two projects whose names start alike
      When I run "project queue web"
      # "web" is not ambiguous because "webhooks" exists. A prefix match that
      # did not try the whole name first would make the shorter name unusable.
      Then it succeeds
      And it was "web" that was queued

    Scenario: A project that is not there is refused
      Given a daemon with a project to queue
      When I run "project queue nowhere"
      Then it fails
      And the output says there is no such project

    Scenario: A whole project can be stopped
      Given a daemon with a project to stop
      When I run "project stop work"
      Then it succeeds
      And the output says 2 tasks were cancelled

    Scenario: Stopping a project where nothing runs says so
      Given a daemon with a project and nothing running
      When I run "project stop work"
      Then it succeeds
      And the output says nothing was running there

    Scenario: A project command needs a name
      When I run "project queue"
      Then the exit code is 2

    Scenario: An unknown project command says what there is
      When I run "project nonsense work"
      Then the exit code is 2
      And the output mentions "queue"

    Scenario: A repository can be added from the terminal
      Given a daemon that accepts a project
      When I run "project add work /repos/work"
      Then it succeeds
      And the output says where it was added
      And the daemon was told the name and the path

    Scenario: A project can be added to work in its own checkout
      Given a daemon that accepts a project
      When I run "project add work /repos/work --in-place"
      Then it succeeds
      # One task at a time in that repository, which is a fact worth printing
      # rather than leaving somebody to discover when two tasks collide.
      And the output says work happens in that checkout
      And the daemon was told not to use worktrees

    Scenario: What scaffolding wrote is said out loud
      Given a daemon that accepts a project and scaffolds two files
      When I run "project add work /repos/work"
      Then it succeeds
      # They will find these in `git status`; better to have been told.
      And the output names both files

    Scenario: A path the repository refuses comes back in its own words
      Given a daemon that refuses the path
      When I run "project add work /nowhere"
      Then it fails
      And the output says it is not a git repository

    Scenario: Adding a project needs a name and a path
      When I run "project add work"
      Then the exit code is 2
      And the output mentions "<path>"

