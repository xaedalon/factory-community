Feature: Tasks, runs and live updates over HTTP
  The board is a client of this API and nothing more. Everything it shows comes
  from here, including which buttons to draw: a task is served with the list of
  actions currently available to it, because a client that works that out for
  itself will disagree with the state machine sooner or later, and the
  disagreement looks like a button that does nothing.

  The daemon is also where work actually happens. It opens the database,
  corrects whatever a crash left behind, and runs the scheduler — so queueing a
  task through this API is enough to make it run.

  Background:
    Given a running daemon with a project scope
    And a workflow "hello" that prints "hello"
    And a project to create tasks in

  Scenario: Creating a task
    When I create the task "Add due dates"
    Then the response is 201
    And the task is "draft"
    And the available actions do not include "start"

  Scenario: A task with a workflow can be queued
    When I create the task "Add due dates" with the workflow "hello"
    Then the available actions include "queue"

  Scenario: Listing tasks
    Given the task "Add due dates" exists
    And the task "Old news" exists and is archived
    When I list the tasks
    Then 1 task is listed
    When I list the tasks including archived ones
    Then 2 tasks are listed

  Scenario: Reading one task
    Given the task "Add due dates" exists
    When I read the task
    Then the response is 200
    And the task comes with its actions, history and runs

  Scenario: A task that does not exist
    When I read the task "nope"
    Then the response is 404

  Scenario: Assigning workflows
    Given the task "Add due dates" exists
    When I assign the workflow "hello"
    Then the task is on "hello"
    And the available actions include "queue"

  Scenario: An action the task cannot do right now
    Given the task "Add due dates" exists
    When I ask to approve the task
    Then the response is 409
    And the response says what the task can do instead

  Scenario: An action that belongs to the engine
    Given the task "Add due dates" exists with the workflow "hello"
    When I ask to start the task
    Then the response is 409

  Scenario: An action that does not exist
    Given the task "Add due dates" exists
    When I ask to teleport the task
    Then the response is 400

  Scenario: Deleting a task
    Given the task "Add due dates" exists
    When I delete the task
    Then the response is 204
    And the task is gone

  Scenario: Queueing a task runs it
    Given the task "Add due dates" exists with the workflow "hello"
    When I queue the task
    And the work finishes
    Then the task is "done"
    And the task has a run
    And the run is "completed"

  Scenario: A run's steps and output are readable
    Given the task "Add due dates" exists with the workflow "hello"
    And the task has been queued and has finished
    When I read the run
    Then the run has 1 step
    And the step's output contains "hello"
    And nothing was dropped from the output

  Scenario: Adding a project
    When I add the project "work" at the scope's directory
    Then the response is 201
    And the project is listed

  Scenario: A repository with no Factory scope is given one
    When I add the project "fresh" at a repository with no scope
    Then the response is 201
    # Without it, every write that asks for the project scope fails — and the
    # first thing a new project does is copy its worktree workflows in, which
    # asks for exactly that. It answered 500 with "No project scope in this
    # chain", and the reply that had already tried said only `written: []`.
    Then the project has a scope of its own
    And the response says the scope was created

  Scenario: A repository that already has a scope keeps it
    Given a repository whose scope says something of its own
    When I add the project "fresh" at that repository
    Then the response is 201
    And the scope still says what it said
    And the response does not claim to have created one

  Scenario: A project at a path that does not exist is refused
    When I add the project "ghost" at a path that does not exist
    Then the response is 400
    And the response explains why

  Scenario: A task can be given a project
    Given the project "work" exists
    When I create the task "Add due dates" in that project
    Then the response is 201
    And the task belongs to the project

  Scenario: A task without a project is refused
    When I create the task "Add due dates" naming no project
    # Not defaulted to anything. The default this used to have was the
    # directory the daemon happened to be started in, which is how an agent
    # ended up committing to the wrong repository.
    Then the response is 400
    And the response says a task needs a project

  Scenario: A project with nothing in it can be removed
    Given the project "work" exists
    When I remove that project
    Then the response is 204

  Scenario: A project that still has tasks cannot be removed
    Given the project "work" exists
    And the task "Add due dates" exists in that project
    When I remove that project
    Then the response is 409
    And the response says 1 task is still in it
    And the response carries the count
    And the project is still listed

  Scenario: A task in a project runs in that project's directory
    Given a project in a directory the daemon was not started in
    And a workflow "where" that prints the directory it runs in
    And the task "Add due dates" exists in that project with the workflow "where"
    When I queue the task
    And the work finishes
    Then the output names the project's directory

  Scenario: A task gets its own worktree, and the work happens there
    Given a project that is a real git repository
    And the task "Add due dates" in it, on "worktree-create" and then "where"
    When I queue the task
    And the work finishes
    Then the task has the flag "hasWorktree"
    And a worktree exists for the task
    And the second workflow ran inside the worktree

  Scenario: A worktree is removed even though the step runs inside it
    Given a project that is a real git repository
    And the task "Add due dates" in it, on "worktree-create" and then "worktree-delete"
    When I queue the task
    And the work finishes
    # The workspace is resolved when the plan is made, so the removal step runs
    # in the worktree it is about to remove. Git cannot read a current
    # directory that has gone, and everything after it in the script is skipped.
    Then no worktree is left for the task
    And the task no longer has the flag "hasWorktree"
    And nothing in the run mentions being unable to read the current directory

  Scenario: Setup says what is still missing
    Given no repositories have been added
    When I ask what setup is left
    Then the response is 200
    And adding a repository is one of the steps
    And it is marked essential

  Scenario: Adding a repository finishes that step
    Given the project "work" exists
    When I ask what setup is left
    Then adding a repository is done

  Scenario: A project can be added to work in its own checkout
    When I add the project "in-place" working in its own checkout
    Then the response is 201
    And the project does not use worktrees

  Scenario: Worktrees can be turned off on a project that already exists
    Given a project that is a real git repository
    When I turn its worktrees off
    Then the response is 200
    And the project does not use worktrees

  Scenario: Turning worktrees on where there is no repository is refused
    Given a project at a directory that is not a repository
    When I turn its worktrees on
    Then the response is 400
    And the response says it is not a git repository

  Scenario: Changing a project that does not exist is not found
    When I turn worktrees off on a project that does not exist
    Then the response is 404

  Scenario: A change that says nothing is refused
    Given the project "work" exists
    When I send a change with no setting in it
    Then the response is 400

  Scenario: A task in a project that works in its own checkout runs there
    Given a project that is a real git repository, working in its own checkout
    And a worktree directory left over from before
    And the task "Add due dates" exists in that project with the workflow "where"
    When I queue the task
    And the work finishes
    Then the output names the repository itself, not the leftover worktree

  Scenario: Health reports what the boot recovered
    When I ask for health
    Then the response is 200
    And health says how many runs were recovered

  Scenario: The live stream carries what happens
    Given I am listening to the live stream
    When I create the task "Add due dates"
    Then the stream delivers "task.created"
    # As an ordinary `message` frame, not one named after the event. A named
    # frame only reaches a client that already knew to listen for that name, so
    # naming them made every consumer keep its own copy of the vocabulary — and
    # the board's copy had 14 of the 23 names in it, which is not an error
    # anywhere: the board simply stopped updating for the others.
    And the event was not named on the wire
    And the event carries its name in the payload

  # The board holds this stream open for as long as it is on screen, so this is
  # the ordinary case rather than an edge one: quit the app, and the engine has
  # a live stream when it is asked to stop. `close()` waits for in-flight
  # requests and a hijacked stream is never not in flight — so the port was
  # released while the process stayed alive for ever, which reads as "Factory is
  # down" with a running daemon in the process table.
  #
  # Note the scenario closes the server *with the stream still open*. The suite's
  # own teardown closes the stream first, which is why the scenario above never
  # caught this.
  Scenario: Stopping does not wait for a live stream for ever
    Given I am listening to the live stream
    When the server is asked to stop
    Then it stops rather than hanging on the open stream

  Rule: A project's definitions are its own

    A workflow committed to a repository is part of that repository. Factory
    resolves definitions through a chain of scopes, and until now the daemon
    used one chain for everything — the one belonging to whatever directory it
    was started in. So a project's own workflows were invisible to its own
    tasks unless you launched the daemon inside it.

    Scenario: A project's own workflows are listed for that project
      Given a project with a workflow of its own
      When I list the workflows for that project
      Then "deploy" is listed
      And it says it came from the project

    Scenario: A project sees the installation's workflows too
      Given a workflow "greeting" everyone shares
      And a project with a workflow of its own
      When I list the workflows for that project
      Then "greeting" is listed
      And it says it came from the user

    Scenario: A project's own workflow belongs to nobody else
      Given a project with a workflow of its own
      When I list the workflows
      Then "deploy" is not listed

    Scenario: Asking about a project that does not exist
      When I list the workflows for a project that does not exist
      Then the response is 404

    Scenario: A task runs a workflow its own project defines
      Given a project with a workflow of its own
      And the task "Ship it" exists in that project with the workflow "deploy"
      When I queue it
      And the work finishes
      Then the output says the project's own workflow ran

  Rule: A plan can only be changed while the task is not carrying it out

    Scenario: Workflows cannot be changed while the task is running
      Given a workflow "waiting" that takes its time
      And the task "Add due dates" exists with the workflow "waiting"
      When I queue it
      And it is running
      And I assign the workflow "hello"
      Then the response is 409
      And it says the task is running

    Scenario: An edit keeps what has run and adds what is new
      Given the task "Add due dates" exists with the workflow "hello"
      And the work finishes
      When I assign a different list of workflows
      Then the workflow that ran is still marked as having run
      And the one just added is ticked

    Scenario: A workflow that has already run cannot be taken off the list
      Given the task "Add due dates" exists with the workflow "hello"
      And the work finishes
      When I take every workflow off the list
      Then the response is 409
      And the refusal names "hello"

  Rule: a task can be moved to another project

    Created in the wrong project was a mistake with no remedy but deleting the
    task and making it again, which throws away its history and its runs. A
    task has to be created in some project, so choosing the wrong one is an
    ordinary mistake.

    Scenario: A task is moved
      Given the project "elsewhere" also exists
      And the task "Add due dates" exists
      When I move it to "elsewhere"
      Then the response is 200
      And the task belongs to "elsewhere"

    Scenario: Moving to a project that is not there is a bad request
      Given the task "Add due dates" exists
      When I move it to a project that does not exist
      Then the response is 400

    Scenario: Moving a task that is running is refused
      Given the project "elsewhere" also exists
      And the task "Add due dates" exists
      And "Add due dates" is running
      When I move it to "elsewhere"
      # The request is well formed; the state is what will not have it.
      Then the response is 409

  Rule: A task can be renamed, and agents are definitions like any other

    Scenario: A task can be renamed
      Given the task "Add due dates" exists
      When I rename it to "Add due dates and times"
      Then the response is 200
      And the task is called "Add due dates and times"

    Scenario: Renaming does not move where its work lives
      Given the task "Add due dates" exists
      When I rename it to "Something else entirely"
      Then its directory is unchanged

    Scenario: A task cannot be renamed while it is running
      Given a workflow "waiting" that takes its time
      And the task "Add due dates" exists with the workflow "waiting"
      When I queue it
      And it is running
      And I rename it to "Too late"
      Then the response is 409

    Scenario: A change that says nothing at all is refused
      Given the task "Add due dates" exists
      When I send a change with neither a name nor workflows
      Then the response is 400

    Scenario: A task can be described
      Given the task "Add due dates" exists
      When I describe it as "Every todo gets an optional due date."
      Then the response is 200
      And the task's description is "Every todo gets an optional due date."

    Scenario: A description can be cleared, unlike a name
      Given the task "Add due dates" exists
      When I describe it as ""
      Then the response is 200
      And the task's description is empty

    Scenario: A description that is not text is refused
      Given the task "Add due dates" exists
      When I describe it as the number 7
      Then the response is 400

    Scenario: The description a task was created with is kept
      Given the task "Add due dates" is created with a description
      Then the task's description is "Every todo gets an optional due date."

    Scenario: A step can write the description into its prompt
      Given a project with a workflow whose step echoes "{{ task.description }}"
      And the task "Ship it" exists in that project with that workflow and a description
      When I queue it
      And the work finishes
      Then the output says what the task was for

    Scenario: Agents are listed, written and read back
      When I write the agent "developer"
      Then the response is 201
      When I list the agents
      Then "developer" is listed

    Scenario: A step can name an agent and the plan uses its model
      Given a project with an agent "developer" and a workflow that uses it
      And the task "Ship it" exists in that project with the workflow "greeting"
      When I queue it
      And the work finishes
      Then the output says which agent ran

  Rule: Turning a project setting on gives the project its own copies

    Scenario: Turning environments on scaffolds the environment workflows
      Given the project "work" exists
      When I turn environments on
      Then the response is 200
      And the project uses environments
      And "environment-create" was written into the project

    Scenario: Those copies resolve from the project afterwards
      Given the project "work" exists
      When I turn environments on
      And I list the workflows for that project
      Then "environment-create" came from the project

    Scenario: Turning a setting off writes nothing and removes nothing
      Given the project "work" exists
      And environments are on
      When I turn environments off
      Then the project does not use environments
      And nothing was written

  Rule: A workflow gated on a facility the project has switched off is not offered

    Nothing provides `hasWorktree` for a project that does not use worktrees, so
    a workflow dealing in that flag would sit in the queue for ever or build
    something the project has said it does not want. It is marked rather than
    dropped: the file is still the project's to open, edit and delete, and only
    the list of what to run next has no business offering it.

    Matching is on the flag, never the name — a renamed copy of
    `worktree-create` still declares `provides: [hasWorktree]`, and that is the
    property this codebase protects everywhere else.

    Scenario: Worktree workflows are unavailable where worktrees are off
      Given the project "work" exists
      And worktrees are off
      When I list the workflows for that project
      Then "worktree-create" is unavailable because of "worktrees"
      And "worktree-delete" is unavailable because of "worktrees"

    Scenario: A project that uses worktrees is offered them
      Given the project "work" exists
      When I list the workflows for that project
      Then "worktree-create" is available

    Scenario: A workflow that only requires the flag is unavailable too
      Given the project "work" exists
      And environments are on
      When I turn environments off
      And I list the workflows for that project
      Then "environment-update" is unavailable because of "environments"

    Scenario: A renamed copy is judged by its flags, not its name
      Given the project "work" exists
      And the project has its own workflow "spin-up" that provides "hasEnvironment"
      When I list the workflows for that project
      Then "spin-up" is unavailable because of "environments"

    Scenario: A workflow that deals in neither is always offered
      Given the project "work" exists
      When I list the workflows for that project
      Then "greeting" is available

  Rule: progress counts phases across the whole plan

    It used to count steps of whichever run was newest. That was right when a
    task had one workflow and has been wrong ever since a task became a list of
    them: each workflow is a fresh run, so the number never climbed past that
    one run's own steps — a five-stage pipeline sat at "0/1" throughout.

    Phases, because that is the unit the interface reference counts in
    both show, and the only one that moves smoothly.

    Scenario: A task that has run nothing reports none of its phases
      Given the task "Add due dates" exists with the workflow "hello"
      When I ask for the task list
      Then "Add due dates" reports 0 of 1 phases

    Scenario: A finished workflow reports its phases
      Given the task "Add due dates" exists with the workflow "hello"
      And the work finishes
      When I ask for the task list
      Then "Add due dates" reports 1 of 1 phases

    Scenario: A workflow that ran twice counts once
      Given the task "Add due dates" exists with the workflow "hello"
      And the work finishes
      And it is ticked back on and finishes again
      When I ask for the task list
      Then "Add due dates" reports 1 of 1 phases

    Scenario: Two workflows are two sets of phases
      Given the task "Add due dates" exists with the workflows "hello, hello"
      And the work finishes
      When I ask for the task list
      Then "Add due dates" reports 2 of 2 phases

    Scenario: A workflow that cannot be planned still leaves the rest counted
      Given the task "Add due dates" exists with the workflow "hello" then "nowhere"
      And the work stops
      When I ask for the task list
      Then "Add due dates" reports 1 of 1 phases

    Scenario: The task's own page reports it too
      Given the task "Add due dates" exists with the workflow "hello"
      And the work finishes
      When I ask for the task
      Then it reports 1 of 1 phases

  Rule: a run says what it actually executed

    A step recorded what the phase said it would do and the kind that ran it.
    What was executed was nowhere, so "what did this agent run, and with what
    authority?" could only be answered by reading the phase file back — a
    different question as soon as anybody has edited it. The profile was
    recorded for this reason; the argv was still missing.

    Scenario: The step carries the command that ran
      Given the task "Add due dates" exists with the workflow "hello"
      When I queue the task and it finishes
      Then the step says it ran "echo hello"

  Rule: a task's artifacts are listed, and one can be read

    Artifacts are read out of the evidence rows rather than off disk. That is
    what evidence is copied into the database for — and it means these routes
    take a task and a name rather than a path, so there is nothing to traverse.

    Scenario: The task lists what it produced, without the content
      Given the task "Check it" exists with a workflow that writes a report
      And the work finishes
      When I ask for the task
      Then "report" is one of its artifacts
      And the listing carries no content

    Scenario: One artifact comes back with its content
      Given the task "Check it" exists with a workflow that writes a report
      And the work finishes
      When I ask for the artifact "report"
      Then the response is 200
      And it carries the text that was written

    Scenario: A name it never produced is not found
      Given the task "Check it" exists with a workflow that writes a report
      And the work finishes
      When I ask for the artifact "nowhere"
      Then the response is 404

    Scenario: An artifact on a task that does not exist is not found
      When I ask for an artifact of a task that does not exist
      Then the response is 404

  Rule: a task says where its work is

    The path was already computed on every run — it is what the engine spawns
    steps in — and it never left the daemon. The ingredients were served
    separately, on two different routes, and no client joined them, so the first
    question anybody asks about a running task had no answer on screen.

    Scenario: The task detail carries the directory its steps run in
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      When I ask for the task
      Then its workspace is the project's directory
      And the workspace is not a worktree
      And the workspace names the project "work"

    Scenario: A worktree on the disk is where the work is
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      And a worktree for it exists on the disk
      When I ask for the task
      Then its workspace is that worktree
      And the workspace is a worktree

    Scenario: The task list does not carry it
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      When I ask for the task list
      Then no listed task carries a workspace

  Rule: each tool answers its own question, and says why it cannot

    The buttons on a task come from plugins now. Where the work is happening is
    worth asking of a task that has never run; carrying on the conversation the
    agent was having only means anything once there has been one. A single
    control that silently became the second as soon as a session existed would
    have taken the first away.

    Scenario: The tools come from plugins, in their own order
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      When I ask for the task
      Then its tools are "open-terminal, open-session, diffity"
      And each tool says which plugin provided it

    Scenario: The tools are beside the actions, not inside the workspace
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      When I ask for the task
      # A tool that needs no directory — a ticket system, say — would be
      # unreachable nested inside a workspace.
      Then its tools are beside its workspace, not inside it

    Scenario: A terminal tool only changes directory
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      When I ask for the task
      Then "open-terminal" would run "cd" to the workspace

    Scenario: A path with a space in it is quoted, not interpolated
      Given the project "my work" exists at a directory with a space in its name
      And the task "Add due dates" exists in it with the workflow "hello"
      When I ask for the task
      Then "open-terminal" quotes the directory

    Scenario: The session tool is the provider's own flag and the task's id
      Given the project "work" exists at the scope's directory
      And the task "Check it" exists in it, with the session "s-99" on "claude"
      When I ask for the task
      Then "open-session" would run "claude --resume s-99"
      And "open-session" is available

    Scenario: A task no agent has run for is offered the session tool anyway
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      When I ask for the task
      # Disabled with its reason, not hidden: a control that appears once a
      # task has run is one nobody knew to look for.
      Then "open-session" is offered
      And "open-session" is unavailable
      And its reason mentions a session

    Scenario: A session whose provider is no longer installed names it
      Given the project "work" exists at the scope's directory
      And the task "Check it" exists in it, with the session "s-99" on "gone"
      When I ask for the task
      Then "open-session" is unavailable
      And its reason mentions "gone"

    Scenario: Whether a tool can be performed is served, not guessed
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      When I ask for the task
      Then "open-terminal" is not runnable
      # The daemon starts a detached tool itself, so nothing need be installed.
      And "diffity" is runnable

  Rule: the route runs the tool that was named

    `{ session: true }` is gone: even the choice between two commands is the
    server's now. A client sends a tool id, and the directory and the argv come
    from the tool, which got them from the task — so there is still nothing
    anybody sends that reaches a process.

    Scenario: A terminal tool is handed to whatever can open one
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      And something that can open a terminal is installed
      When I run the tool "open-terminal"
      Then the response is 200
      And it was asked to open the workspace
      And it was asked to run nothing

    Scenario: The session tool resumes by id
      Given the project "work" exists at the scope's directory
      And the task "Check it" exists in it, with the session "s-99" on "claude"
      And something that can open a terminal is installed
      When I run the tool "open-session"
      Then it was asked to run "claude --resume s-99"

    Scenario: A detached tool is started by the daemon itself
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      And "diffity" is installed
      When I run the tool "diffity"
      Then the response is 200
      # No terminal capability anywhere, which is the point: this is the half
      # that works in Community.
      And it reports a detached run
      And the detached launcher was asked to run diffity

    Scenario: The client never says which directory
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      And something that can open a terminal is installed
      # Nothing the client sends reaches a process. The claim is stronger than
      # it was: a tool id is not even a command.
      When I run the tool "open-terminal" while asking for somewhere else
      Then it was asked to open the workspace

    Scenario: A tool nobody registered is not found
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      When I run the tool "nonsense"
      Then the response is 404

    Scenario: A tool that cannot be used here is refused with its own reason
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      And something that can open a terminal is installed
      When I run the tool "open-session"
      Then the response is 409
      And the error mentions a session
      And nothing was opened

    Scenario: A tool from a plugin switched off since the page loaded is refused
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      And something that can open a terminal is installed
      And the plugin providing "open-terminal" is switched off
      When I run the tool "open-terminal"
      Then the response is 404
      And nothing was opened

    Scenario: A tool for a task that does not exist is not found
      When I run a tool for a task that does not exist
      Then the response is 404

  Rule: performing a terminal tool is a capability, and its absence is an answer

    Community has no platform detection in it anywhere, and starting a terminal
    application is the most platform-specific act there is. So the route asks
    the host and reports 501 when nothing answers — with the command in the
    body, which is what the board offers to copy.

    Scenario: With nothing installed the route hands back the command instead
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      When I run the tool "open-terminal"
      Then the response is 501
      And the response carries the command to run

    Scenario: A terminal that will not open says why
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      And something that refuses to open a terminal is installed
      When I run the tool "open-terminal"
      Then the response is 500
      And the response explains why

    Scenario: A detached tool that will not start says why
      Given the project "work" exists at the scope's directory
      And the task "Add due dates" exists in it with the workflow "hello"
      And "diffity" is installed
      And starting something detached will fail
      When I run the tool "diffity"
      Then the response is 500
      And the response explains why

  Rule: a client chooses a task's name, never a path

    `POST /api/tasks` accepts a `directory`, and that value is not a label. It
    becomes the task's worktree name, its artifacts root, and — through
    `workspaceFor` — the directory the agent process itself runs in. It used to
    be stored exactly as sent.

    The route forwards it to the store, which slugs it, so this asserts the
    route has not grown a way around that.

    Scenario: A directory sent by a client is slugged
      When I create the task "Add due dates" asking for the directory "Add Due Dates"
      Then the task's directory is "add-due-dates"

    Scenario: A directory sent by a client cannot climb out of the worktrees root
      When I create the task "Add due dates" asking for the directory "../../escape"
      Then the task's directory is "escape"
      And the task's directory is a single path segment

    Scenario: An absolute directory sent by a client cannot restart the path
      When I create the task "Add due dates" asking for the directory "/etc/passwd"
      Then the task's directory is "etc-passwd"
      And the task's directory is a single path segment

  Rule: no run starts until somebody has been told what a run can reach

    The gate is in the daemon, not the browser, because the browser is not the
    only client: the CLI and `curl` start runs too, and a disclaimer only the
    web app enforces is advice rather than a gate.

    On `queue` and `retry` alone — the two actions that lead to an agent
    running. Cancelling or approving something already under way must never be
    blocked by it, because that would trap the person who most needs to stop
    what is happening.

    Scenario: Queueing before the disclaimer is accepted is refused
      Given nothing has been accepted on this installation
      And the task "Add due dates" exists with the workflow "hello"
      When I queue it
      Then the response is 409
      And the response carries the disclaimer to show

    Scenario: Queueing after accepting it works
      Given nothing has been accepted on this installation
      And the task "Add due dates" exists with the workflow "hello"
      And the disclaimer is accepted
      When I queue it
      Then the response is 200

    Scenario: Cancelling is never gated on the disclaimer
      Given nothing has been accepted on this installation
      And the task "Add due dates" exists with the workflow "hello"
      When I cancel it
      # The one action a person reaches for when something is going wrong.
      Then the response is 200

    Scenario: Marking a task done by hand is never gated either
      Given nothing has been accepted on this installation
      And the task "Add due dates" exists with the workflow "hello"
      # Nothing runs, so there is nothing to be warned about. Gating it would
      # trap somebody tidying up after work they did themselves.
      When I mark it done
      Then the response is 200

  Rule: everything can be stopped at once

    Scenario: Stopping everything when nothing is running is not an error
      When I stop everything
      Then the response is 200
      And it reports nothing signalled

  Rule: a project says how much authority its runs get

    Scenario: A new project states no profile
      Given the project "work" exists at the scope's directory
      When I ask for the projects
      Then the project states no profile

    Scenario: A project's profile can be set
      Given the project "work" exists at the scope's directory
      When I set the project's profile to "full-access"
      Then the project's profile is "full-access"
      And nothing was scaffolded

    Scenario: A project's profile can be cleared back to unstated
      Given the project "work" exists at the scope's directory
      And the project's profile is "full-access"
      When I clear the project's profile
      Then the project states no profile

    Scenario: A profile that is not one is refused
      Given the project "work" exists at the scope's directory
      When I set the project's profile to "sort-of-safe"
      Then the response is 400
      And the response says what a profile can be

    Scenario: An empty project patch says the profile is an option
      Given the project "work" exists at the scope's directory
      When I send an empty project patch
      Then the response is 400
      And the response says what a profile can be

  Rule: a task says what it is waiting for

    Derived per request rather than stored, the way progress is. The scheduler
    and the route both ask the same function what counts as done, so there is
    one rule and no column to go stale.

    The task carries the ids, which is what a client sends back when it edits
    the graph. The names and the verdict travel beside them, because a row that
    said "waiting for 0f3a-91c2" would be useless.

    Scenario: A task with no dependencies lists none
      When I create the task "Add due dates"
      And I ask for the task
      Then it waits for nothing

    Scenario: A dependency is written and read back
      Given the task "Scaffold" exists
      And the task "The model" exists
      When "The model" is made to wait for "Scaffold"
      Then the response is 200
      And "The model" waits for 1 task
      And the blocker is called "Scaffold"
      And the blocker is "waiting"

    Scenario: The list says it too
      Given the task "Scaffold" exists
      And the task "The model" exists
      And "The model" is made to wait for "Scaffold"
      When I ask for every task
      # One read for the whole board. A client that asked per row would make
      # twenty requests to draw twenty rows.
      Then "The model" waits for "Scaffold" in the list

    Scenario: A blocker that is done is met
      Given the task "Scaffold" exists
      And the task "The model" exists
      And "The model" is made to wait for "Scaffold"
      When "Scaffold" is marked done
      And I ask for "The model"
      Then the blocker is "met"

    Scenario: A blocker that was cancelled is dead
      Given the task "Scaffold" exists
      And the task "The model" exists
      And "The model" is made to wait for "Scaffold"
      When "Scaffold" is cancelled
      And I ask for "The model"
      Then the blocker is "dead"

    Scenario: A dependency can be taken back
      Given the task "Scaffold" exists
      And the task "The model" exists
      And "The model" is made to wait for "Scaffold"
      When "The model" stops waiting for "Scaffold"
      Then the response is 200
      And "The model" waits for 0 tasks

    Scenario: A ring is refused with the store's own words
      Given the task "Scaffold" exists
      And the task "The model" exists
      And "The model" is made to wait for "Scaffold"
      When "Scaffold" is made to wait for "The model"
      Then the response is 400
      And the response says it would make a ring

    Scenario: Waiting for itself is refused
      Given the task "Scaffold" exists
      When "Scaffold" is made to wait for itself
      Then the response is 400

    Scenario: A dependency on a task that is not there is refused
      Given the task "The model" exists
      When "The model" is made to wait for a task that does not exist
      Then the response is 400

    Scenario: A dependency for a task that is not there is not found
      When a task that does not exist is made to wait for something
      Then the response is 404

    Scenario: Asking what to wait for is required
      Given the task "The model" exists
      When I post a dependency with no blocker
      Then the response is 400
      # In words, not as whatever the store throws when it is handed nothing.
      # Both are 400s; only one of them can be read.
      And the response asks which task it should wait for

    Scenario: A task can be marked done over the wire
      Given the task "Scaffold" exists
      When "Scaffold" is marked done
      Then the response is 200
      And the task is "done"

  Rule: a project can be queued and stopped in one request

    One request rather than one per task. The board holds one error and one
    acting id, with nowhere to put a partial refusal, and the disclaimer should
    be answered once for a batch rather than ten times over.

    Queue all takes the drafts and the blocked tasks, in dependency order, so
    the queue reads in the order the work will happen. Stop all takes what is
    in flight or in line, and deliberately leaves the drafts and the blocked
    alone: neither is happening, both are what Queue all picks up from, and one
    click must not quietly clear work somebody has planned.

    Scenario: Queue all queues every draft in the project
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      And the task "Two" exists in the project with a workflow
      When I queue the whole project
      Then the response is 200
      And 2 tasks were queued
      And both are "queued"

    Scenario: Queue all queues in dependency order
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      And the task "Two" exists in the project with a workflow
      And "One" is made to wait for "Two"
      When I queue the whole project
      # The queue is a priority, not a barrier, so this is not what holds the
      # work back — the scheduler does that. It is so the board reads in the
      # order things will happen.
      Then the queued tasks are "Two, One" in that order
      And "Two" is earlier in the queue than "One"

    Scenario: Queue all leaves a task with nothing ticked alone, and says so
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      And the task "Nothing planned" exists in the project
      When I queue the whole project
      Then 1 task was queued
      And "Nothing planned" was skipped because nothing in its plan is ticked

    Scenario: Queue all picks up a blocked task
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      And "One" is blocked
      When I queue the whole project
      Then 1 task was queued

    Scenario: Queue all leaves finished work finished
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      And "One" is marked done
      When I queue the whole project
      # One click must never set five agents on work that already happened.
      Then 0 tasks were queued

    Scenario: Queue all ignores another project's tasks
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      And a task "Elsewhere" with a workflow in another project
      When I queue the whole project
      Then 1 task was queued

    Scenario: Queue all is refused until the disclaimer is accepted
      Given nothing has been accepted on this installation
      And the task "One" exists in the project with a workflow
      When I queue the whole project
      Then the response is 409
      And the response carries the disclaimer

    Scenario: A ring no route could have made refuses the whole batch
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      And the task "Two" exists in the project with a workflow
      And a ring between them written straight into the database
      When I queue the whole project
      # The store refuses a ring at the door, so only a hand-edited database
      # gets here. Refused rather than ignored: the walk cannot place a ring's
      # members, so carrying on would queue everything else and silently leave
      # those out.
      Then the response is 409
      And the response names the ring
      And nothing was queued

    Scenario: Queueing a project that is not there is not found
      When I queue a project that does not exist
      Then the response is 404

    Scenario: Stop all cancels what is in the queue
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      And the task "Two" exists in the project with a workflow
      And the whole project is queued
      When I stop the whole project
      Then the response is 200
      And 2 tasks were cancelled
      And nothing in the project is queued

    Scenario: Stop all leaves a draft alone
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      When I stop the whole project
      Then 0 tasks were cancelled
      And "One" is "draft"

    Scenario: Stop all leaves a blocked task alone
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      And "One" is blocked
      When I stop the whole project
      Then 0 tasks were cancelled
      And "One" is "blocked"

    Scenario: Stop all leaves finished work alone
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      And "One" is marked done
      When I stop the whole project
      Then 0 tasks were cancelled
      And "One" is "done"

    Scenario: Stop all ignores another project's tasks
      Given the project "work" exists here
      And the task "One" exists in the project with a workflow
      And a task "Elsewhere" with a workflow in another project
      And the whole project is queued
      And "Elsewhere" is queued
      When I stop the whole project
      Then 1 task was cancelled
      And "Elsewhere" is "queued"

    Scenario: Stop all is never gated on the disclaimer
      Given nothing has been accepted on this installation
      When I stop the whole project
      # Refusing to stop work because nobody agreed to a notice would be the
      # most hostile possible reading of a safety feature.
      Then the response is 200

    Scenario: Stopping a project that is not there is not found
      When I stop a project that does not exist
      Then the response is 404

  Rule: adding a project leaves the repository exactly as it was

    Most repositories that exist are not using Factory, and somebody may want
    to use it on this machine only. So registering one writes nothing git can
    see: the `.xaedalon/.gitignore` Factory creates contains `*`, which hides
    the family directory and that file with it.

    Asserted against real git rather than against the file's contents, because
    the contents are the mechanism and `git status` is the promise.

    Scenario: Registering a project adds nothing to git status
      Given a repository with nothing to commit
      When I add it as a project
      Then the response is 201
      And it has a Factory scope of its own
      And git still has nothing to say about it

    Scenario: A repository that already shares its definitions is left sharing them
      Given a repository whose Factory definitions are committed
      When I add it as a project
      Then the response is 201
      # Never over a directory Factory did not create. The other half of that
      # decision is this: the worktree definitions copied in as the project is
      # registered are *visible*, because this repository shares its
      # definitions and its team should see the new ones and commit them.
      And no ignore file was written
      And the definitions it copied in are there for the team to commit

  Rule: doctor asks git what it can see of a project

    The rule itself is specified against a stub in the engine's own suite. What
    only a real repository can answer is whether the question Factory asks git
    is the one it means — the flags, the NUL-separated records, and every way
    of not getting an answer at all.

    Scenario: A committed artifact is found in a real repository
      Given a project that is a real repository with a committed task artifact
      When I GET "/api/doctor"
      Then the response is 200
      And the findings say a run's output is committed

    Scenario: A project that is not a repository produces no finding
      Given a project that is a plain directory
      When I GET "/api/doctor"
      Then the response is 200
      And the findings say nothing about git

  Rule: a directory can ask which project it is in

    Everything that asks the daemon about a project has so far known its id or
    its name, because a person picked it. An agent knows the directory it was
    started in and nothing else, so the question has to be answerable over the
    wire — and answerable *here*, because the CLI and the board want the same
    answer and a client that worked it out for itself would disagree with this
    one the first time the rule changed.

    Scenario: A directory inside a project resolves to it
      Given a project "factory" at a repository
      When I ask which project is at a directory inside it
      Then the response is 200
      And the project is "factory"
      And it matched an ancestor

    Scenario: A directory nobody registered is not found
      Given a project "factory" at a repository
      When I ask which project is at a directory outside every project
      Then the response is 404

    Scenario: A task's worktree resolves to the project and the task
      Given a project "factory" at a repository
      And a task "Add due dates" in it with a worktree on disk
      When I ask which project is at that worktree
      Then the response is 200
      And the project is "factory"
      And the answer names the task "Add due dates"

    Scenario: Two projects at one directory are a conflict
      Given a project "factory" at a repository
      And a second project "factory-again" at the same repository
      When I ask which project is at that repository
      Then the response is 409
      And both project names are in the answer

    Scenario: Asking without a path is a usage error
      When I ask which project is at no path at all
      Then the response is 400
      # The status alone would pass without the guard: unguarded, the missing
      # path reaches the repository and comes back as a TypeError about a
      # string, which is a 400 that tells nobody what to do.
      And the answer says what to pass instead

  Rule: how far work may start work is the daemon's to decide

    An agent Factory launched can reach this API: it is on 127.0.0.1, there is
    no authentication, and the address is not credential-shaped so it survives
    the environment filter. Serving MCP did not create that reach — it made it
    ergonomic, and an ergonomic way to start work from inside work is an
    ergonomic way to start work from inside that.

    So the bound is here, for the reason the disclaimer gate is here: a rule
    only the MCP server enforced would be advice, with `curl` as the exception.

    Scenario: A request with nobody behind it is a person
      Given a project to work in
      When I create a task with no initiator
      Then the response is 201

    Scenario: Work four levels deep is refused
      Given a project to work in
      And a run "deep" at depth 3
      When I create a task from inside "deep"
      Then the response is 409
      And the answer is coded RECURSION_LIMIT
      And no task was created

    Scenario: The eleventh task from one run is refused
      Given a project to work in
      And a run "busy" at depth 0 that has already asked for 10 tasks
      When I create a task from inside "busy"
      Then the response is 409
      And the answer is coded FAN_OUT_LIMIT

    Scenario: A task created from inside a run remembers which
      Given a project to work in
      And a run "asker" at depth 0
      When I create a task from inside "asker"
      Then the response is 201
      And the task says "asker" asked for it
      And the task says who the client called itself

    Scenario: An initiator that is not an object is refused rather than half-read
      Given a project to work in
      # A half-read initiator is one whose taskId went missing, and the guard
      # that stops an agent reaching around its own run would then do nothing.
      When I create a task with an initiator of "yes please"
      Then the response is 400

    Scenario: An agent cannot queue the task it is running inside
      Given a project to work in
      And a task "Add due dates" that can be queued
      And the disclaimer has been accepted
      When the agent running that task tries to queue it
      Then the response is 409
      And the answer is coded SELF_ORCHESTRATION_BLOCKED
      And the task was not queued

    Scenario: An agent cannot approve what its own run asked for
      Given a project to work in
      And a run "asker" at depth 0
      And a task "Add due dates" that "asker" asked for, waiting for approval
      When the agent in "asker" tries to approve it
      Then the response is 409
      And the answer is coded APPROVAL_SEPARATION
      And the task is still waiting for approval

    Scenario: Queue all skips the agent's own task and queues the rest
      Given a project to work in
      And the disclaimer has been accepted
      And two tasks that can be queued
      When the agent running the first one queues the whole project
      Then the response is 200
      And one task was queued
      And the one it is running inside was skipped with a reason

  Rule: a project is asked what checks its work, and told when it cannot be guessed

    The gate a `validate` workflow needs is a command, and Factory cannot invent
    one. What it can do is read the repository it was just handed: a `test`
    script in a `package.json` is not a difficult guess, and asking somebody to
    fill in a field they were not expecting is how a field ends up empty.

    Detected only when the caller said nothing at all. A caller that sent a
    blank string meant blank — "this project has no gate" is a real answer, and
    overruling it with a guess would be help nobody can switch off.

    Scenario: Adding a repository with a test script detects its command
      Given a directory whose "package.json" declares a "test" script
      When I add a project at that directory
      Then the project's check command is "npm test"

    Scenario: A repository that says nothing gets no command
      Given a directory with nothing Factory recognises
      When I add a project at that directory
      Then the project has no check command

    Scenario: A command sent with the request is used as sent
      Given a directory whose "package.json" declares a "test" script
      When I add a project at that directory with the check command "make verify"
      Then the project's check command is "make verify"

    Scenario: The command can be changed afterwards
      Given a directory whose "package.json" declares a "test" script
      And a project added at that directory
      When I set that project's check command to "pnpm verify"
      Then the response is 200
      And the project's check command is "pnpm verify"

    Scenario: The command can be cleared afterwards
      Given a directory whose "package.json" declares a "test" script
      And a project added at that directory
      When I clear that project's check command
      Then the response is 200
      And the project has no check command

    Scenario: A check command that is not text is refused
      Given a directory with nothing Factory recognises
      And a project added at that directory
      When I set that project's check command to the number 7
      Then the response is 400

  Rule: a green project check is evidence, and Factory knows which command it was

    The one expectation Factory can satisfy without being told: a step running
    exactly the project's own check command and exiting zero *is* the project's
    checks passing. Everything else waits for a workflow to declare it.

    Knowing which command that was is the daemon's job — the engine has a run
    and a plan and no idea which project they belong to. It was never handed
    over, so the credit was reachable only from a unit test that passed the
    fact in by hand, and no real run ever earned it.

    Scenario: A run of the project's check command earns regression coverage
      Given the project checks itself with "echo checks passed"
      And the workflow "check" runs that command
      And the task "Add due dates" exists with the workflow "check"
      When I queue the task
      And the work finishes
      Then the assessment counts "regression_checks" as collected

    Scenario: A run of some other command earns none
      Given the project checks itself with "echo checks passed"
      And the task "Add due dates" exists with the workflow "hello"
      When I queue the task
      And the work finishes
      Then the assessment counts no evidence at all

  Rule: a project says which model judges its work, and whether one does

    The free evaluator always runs. An agent evaluator costs tokens on every run
    that produced something, so what it costs and whether it is worth it are the
    project's call — a weekend project and a payments service do not want the
    same model, and neither wants one chosen for them in Factory's source.

    Naming nothing is not the same as switching it off. One of them starts
    working the moment a model is named.

    Scenario: A new project names no model and is judged
      Given a directory with nothing Factory recognises
      When I add a project at that directory
      Then the project names no judging model
      And the project is judged

    Scenario: A model can be chosen
      Given a directory with nothing Factory recognises
      And a project added at that directory
      When I set that project's judging model to "claude-opus-5-5"
      Then the response is 200
      And the project's judging model is "claude-opus-5-5"

    Scenario: A model can be cleared
      Given a directory with nothing Factory recognises
      And a project added at that directory
      And that project's judging model is "claude-opus-5-5"
      When I clear that project's judging model
      Then the response is 200
      And the project names no judging model

    Scenario: Judging can be switched off without losing the model
      Given a directory with nothing Factory recognises
      And a project added at that directory
      And that project's judging model is "claude-opus-5-5"
      When I stop that project's work being judged
      Then the response is 200
      And the project is not judged
      And the project's judging model is "claude-opus-5-5"

    Scenario: A model that is not text is refused, and the refusal names the field
      # The status alone does not distinguish a validated refusal from the
      # store throwing on `7.trim()` — both are 400, and only one of them puts
      # the error against a field a form can highlight.
      Given a directory with nothing Factory recognises
      And a project added at that directory
      When I set that project's judging model to the number 7
      Then the response is 400
      And the refusal names the judging model

    Scenario: Judging that is not true or false is refused
      Given a directory with nothing Factory recognises
      And a project added at that directory
      When I set that project's judging to "maybe"
      Then the response is 400

  Rule: a task carries how much to trust it, and no surface can simply say

    The score is assembled from the history — the newest assessment plus the
    drivers still active — and assembled in one place, so the task payload and
    the reliability routes cannot describe the same task differently.

    There is no route that sets a score. There is not going to be one, and a
    scenario asserts it does not exist.

    Scenario: A task nobody has judged says so rather than scoring zero
      Given the task "Add due dates" exists
      When I read the task
      Then its reliability is "unassessed"
      And it carries no score

    Scenario: The reliability route agrees with the task payload
      Given the task "Add due dates" exists
      When I read the task
      And I read its reliability
      Then both say the same state

    Scenario: An assessment can be asked for
      Given the task "Add due dates" exists
      When I ask for an assessment
      Then the response is 200
      And its reliability is "assessed"
      And it carries a score

    Scenario: History starts empty and grows
      Given the task "Add due dates" exists
      When I read its reliability history
      Then 0 assessments are listed
      When I ask for an assessment
      And I read its reliability history
      Then 1 assessment is listed

    Scenario: Next actions are offered for a task with nothing to do
      Given the task "Add due dates" exists
      When I read its next actions
      Then the response is 200
      And no actions are offered

    Scenario: There is no route that sets a score
      Given the task "Add due dates" exists
      When I try to set its score to 100
      Then the response is 404

  Rule: accepting a serious risk is a person's, and the daemon is what knows

    An acceptance an agent can grant itself is not a gate. Factory stamps the
    run into every agent process it launches, so the daemon can tell — and a
    client that omits it looks like a person, which is the direction that loses
    authority rather than gains it.

    Scenario: An agent cannot accept a high risk
      Given a task with a "high" reliability driver
      When an agent tries to accept that driver
      Then the response is 409
      And the refusal says a person is required

    Scenario: A person can accept a high risk
      Given a task with a "high" reliability driver
      When a person accepts that driver
      Then the response is 200
      And the driver is "accepted"
      And it records who accepted it

    Scenario: An agent can resolve a high risk
      # Resolving is a claim evidence can check. Accepting is a decision.
      Given a task with a "high" reliability driver
      When an agent resolves that driver
      Then the response is 200
      And the driver is "resolved"

    Scenario: Accepting re-judges the task immediately
      # Leaving it until the next run would show a number contradicting the
      # list underneath it.
      Given a task with a "high" reliability driver
      When a person accepts that driver
      Then the reliability comes back with the reply

    Scenario: A move the driver does not offer is refused with the ones it does
      Given a task with a "high" reliability driver
      And that driver has been resolved
      When a person tries to resolve it again
      Then the response is 409
      And the refusal lists what it would accept

    Scenario: Something that is not a driver action is refused
      Given a task with a "high" reliability driver
      When a person tries to "obliterate" that driver
      Then the response is 400

