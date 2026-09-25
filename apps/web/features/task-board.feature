Feature: The task board
  The board is where the work is watched. It shows what is queued, what is
  running, what is waiting for a person and what went wrong, and it keeps up on
  its own — a run started by the scheduler changes this page with nobody
  touching it.

  Its buttons come from the daemon. Each task is served with the actions it can
  take right now, and the board draws those and nothing else, so a button that
  is on screen is one the state machine will accept.

  Background:
    Given a project scope and a user scope
    And the project defines the workflow "hello" that prints "hello"

  Scenario: An empty board says what a task is
    When I open the tasks page
    Then the board says there is nothing yet

  Scenario: Creating a task
    When I open the tasks page
    And I create the task "Add due dates" on "hello"
    Then the task page for "Add due dates" opens
    When I go back to the board
    Then "Add due dates" is on the board
    And "Add due dates" is "draft"
    And "Add due dates" offers "Queue"

  Scenario: A task with no workflow cannot be queued
    When I open the tasks page
    And I create the task "Just an idea" with no workflow
    And I go back to the board
    Then "Just an idea" does not offer "Queue"

  Scenario: A finished task says which workflow ran
    Given the task "Add due dates" exists on "hello"
    And it has been run
    When I open the tasks page
    # Every `done` row drew an em dash, because the *current* workflow is the
    # next one and a finished task has none — so the column read as missing
    # data on exactly the rows where the answer is most obvious.
    Then the workflow column for "Add due dates" says "hello"

  Scenario: With no repository the board says what to add first
    Given no repositories are registered
    When I open the tasks page
    Then the board asks for a repository
    And it offers to add one

  Scenario: The summary counts what is there
    Given the task "Add due dates" exists on "hello"
    When I open the tasks page
    Then the board counts 1 task in total

  Scenario: Filtering by status
    Given the task "Add due dates" exists on "hello"
    When I open the tasks page
    And I filter by the status "Running"
    Then the board says there is nothing yet
    When I filter by the status "All statuses"
    Then "Add due dates" is on the board

  Scenario: The board view groups by state
    Given the task "Add due dates" exists on "hello"
    When I open the tasks page
    And I switch to the board view
    Then "Add due dates" is in the "draft" column

  Scenario: A card draws how far along the task is
    Given the task "Add due dates" exists on "hello"
    When I open the tasks page
    And I switch to the board view
    # The table has had a bar since the beginning and the card had two small
    # numbers, so a queued task in the column view was a grey separator line
    # and nothing a person reads at a glance.
    Then the card for "Add due dates" says "0/1 phases"
    And its bar is 0% full

  Scenario: The card's bar fills as the work is done
    Given the task "Add due dates" exists on "hello"
    When I open the tasks page
    And I queue "Add due dates"
    And I switch to the board view
    Then the card for "Add due dates" says "1/1 phases"
    And its bar is 100% full

  Scenario: Queueing a task runs it, and the board follows
    Given the task "Add due dates" exists on "hello"
    When I open the tasks page
    And I queue "Add due dates"
    Then "Add due dates" becomes "done" without me reloading

  Scenario: A task's run, steps and output
    Given the task "Add due dates" exists on "hello"
    When I open the tasks page
    And I queue "Add due dates"
    And "Add due dates" becomes "done" without me reloading
    And I open "Add due dates"
    # Nothing failed, so the steps arrive folded. Unfolding is the ordinary
    # way to read a finished run.
    And I unfold the steps
    Then the run for "hello" is listed
    And the step "echo hello" is listed
    And opening the step shows "hello"

  Scenario: Adding a project
    When I open the projects page
    And I add the project "work" at the project directory
    Then "work" is listed as a project

  Scenario: A project that is not there is refused with a reason
    When I open the projects page
    And I add the project "ghost" at a path that does not exist
    Then the page explains that there is nothing at that path

  Scenario: A task can be created in a project
    Given the project "work" is registered
    When I open the tasks page
    And I create the task "Add due dates" in "work" on "hello"
    And I go back to the board
    Then "Add due dates" is on the board
    And "Add due dates" shows the project "work"

  Scenario: Evidence is on the page the approval is decided on
    Given the project defines the workflow "review" that writes a report and asks for approval
    And the task "Check it" exists on "review"
    When I open the tasks page
    And I queue "Check it"
    And "Check it" becomes "awaiting_approval" without me reloading
    And I open "Check it"
    Then the evidence from "report" is shown
    And the evidence reads "looks good"

  Scenario: Approving from the task page finishes the work
    Given the project defines the workflow "review" that writes a report and asks for approval
    And the task "Check it" exists on "review"
    When I open the tasks page
    And I queue "Check it"
    And "Check it" becomes "awaiting_approval" without me reloading
    And I open "Check it"
    And I approve it
    Then the task finishes

  Scenario: The setup page says what is still missing
    Given no repositories are registered
    When I open the setup page
    Then "Add a repository" is a setup step
    And it is marked essential
    And the page says Factory cannot run work yet

  Scenario: A setup step offers the command that fixes it
    Given no repositories are registered
    When I open the setup page
    Then a setup step offers a command to copy

  Scenario: A project can be added to work in its own checkout
    When I open the projects page
    And I add the project "in-place" at the project directory, without worktrees
    Then "in-place" is listed as a project
    And "in-place" says it works in the repository, one task at a time

  Scenario: Worktrees can be turned off from the projects page
    Given the project "work" is registered
    When I open the projects page
    And I switch "work" to working in the repository
    Then "work" says it works in the repository, one task at a time

  Scenario: The daemon not running is explained
    Given the daemon is not running
    When I open the tasks page
    Then the page says it cannot reach the daemon

  Rule: the task page leads with the thing you came to do

    Seven sections sat in a flat vertical stack at one rank, so what mattered
    was wherever it happened to fall. A task waiting for a person put the
    evidence to decide on sixth of seven, below the run list and the steps; a
    task that had failed put the reason in one place and the failing step, shut,
    in another.

    The state already decides what matters. A band at the top says it in a
    sentence and carries the buttons that act on it, the wide column is what is
    happening now, and the facts that do not change while you read them are in
    a rail beside it.

    Scenario: A decision leads with the evidence
      Given the project defines the workflow "review" that writes a report and asks for approval
      And the task "Check it" exists on "review"
      When I open the tasks page
      And I queue "Check it"
      And "Check it" becomes "awaiting_approval" without me reloading
      And I open "Check it"
      Then the band says this is waiting for you
      And the evidence is above the steps

    Scenario: A failure says what stopped it, at the top
      Given the project defines the workflow "doomed" that fails
      And the task "Will fail" exists on "doomed"
      When I open the tasks page
      And I queue "Will fail"
      And "Will fail" becomes "blocked" without me reloading
      And I open "Will fail"
      Then the band says this stopped
      And the failing step's output is already open

    Scenario: The facts sit beside the work, not under it
      Given the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I open "Add due dates"
      Then the facts sit beside the work

  Rule: the long sections are folded away until they are the reason you came

    Steps and Evidence are the two that grow without limit — a phase's whole
    log, a report somebody wrote — and on a finished task they pushed the
    reliability drivers and the graph off the screen entirely. Both now start
    folded.

    Folded is not hidden, and the exception is the point: a failed step opens
    itself, because "a step nobody expanded is a step nobody read" is why the
    failing log was auto-opened in the first place, and a task waiting on a
    decision opens its evidence, because that is the one moment the evidence is
    what you came for.

    Scenario: A finished task folds its steps away
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I queue "Add due dates"
      And "Add due dates" becomes "done" without me reloading
      And I open "Add due dates"
      Then the steps are folded away
      And I can unfold them

    Scenario: A failure unfolds itself
      Given the project defines the workflow "doomed" that fails
      And the task "Will fail" exists on "doomed"
      When I open the tasks page
      And I queue "Will fail"
      And "Will fail" becomes "blocked" without me reloading
      And I open "Will fail"
      Then the steps are not folded away
      And the failing step's output is already open

    Scenario: A decision unfolds its evidence
      Given the project defines the workflow "review" that writes a report and asks for approval
      And the task "Check it" exists on "review"
      When I open the tasks page
      And I queue "Check it"
      And "Check it" becomes "awaiting_approval" without me reloading
      And I open "Check it"
      Then the evidence is not folded away
      And the evidence is above the steps

  Rule: the task page is read in the order the questions are asked

    What is it doing, what is stopping it, how did it get here, what did it
    produce, and only then the machinery. The sections are ranked by CSS rather
    than by where they sit in the markup, so the reading order is a property of
    the page and not of how it happened to be written.

    Scenario: How it got here comes before the machinery
      # The discriminating pair. Under the old ranking the steps sat third and
      # the graph fifth, so a task with both put the log above the history.
      Given a task judged four times, the third lower than the second
      And that task has a finished run
      When I open that task
      Then how it got here comes before the steps

    Scenario: The workflows still come first
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I queue "Add due dates"
      And "Add due dates" becomes "done" without me reloading
      And I open "Add due dates"
      Then the workflows come before the steps

  Rule: a row says how much to trust the task, in two numbers

    A 93 with 41% coverage is not the same claim as a 93 with 96%, and a board
    that showed only the first would be the flattery the reliability card was
    written to avoid. Both numbers or neither — and neither is an em dash, never
    a zero, because a zero on a row reads as a verdict rather than as silence.

    Scenario: The row says the score and the coverage together
      Given a task judged at 88 with 70% coverage
      When I open the tasks page
      Then the row for "Add due dates" says 88 with 70% coverage

    Scenario: A task nobody has judged shows an em dash rather than a zero
      Given a task nobody has judged
      When I open the tasks page
      Then the row for "Add due dates" shows no score

    Scenario: The card says them too
      Given a task judged at 88 with 70% coverage
      When I open the tasks page
      And I switch to the board view
      Then the card for "Add due dates" says 88 with 70% coverage

    Scenario: The table has a column for it
      Given a task judged at 88 with 70% coverage
      When I open the tasks page
      Then the table has a "Trust" column

  Rule: a count says what it counted

    "6/6 phases" on a task with five workflows reads as a miscount until you
    know that one workflow carries two phases. The page has the room to say
    which, and the row in the list does not.

    Scenario: The task page says how many workflows the phases came from
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I queue "Add due dates"
      And "Add due dates" becomes "done" without me reloading
      And I open "Add due dates"
      Then the progress does not say how many workflows it counted

    Scenario: A task with more phases than workflows says so
      Given the project defines the workflow "twostep" with two phases
      And the task "Add due dates" exists on "twostep"
      When I open the tasks page
      And I queue "Add due dates"
      And "Add due dates" becomes "done" without me reloading
      And I open "Add due dates"
      Then the progress says it counted 1 workflow

  Rule: a project is created and edited on a page, not in the row it lives in

    The projects page carried a seven-control strip above the list and then the
    same settings again inside every row — as buttons labelled with the state
    they would move to, so "Use worktrees" meant worktrees were off. Nothing
    said what a path was for, and Remove destroyed a project on one click.

    Name and branch were the two fields nobody could change at all: the only
    way was to remove the project and add it again, which leaves every task
    that ever ran in it pointing at nothing. The path stays fixed for that same
    reason, and the page says so rather than leaving a box that refuses.

    Scenario: The list offers no way to change a project in place
      Given the project "work" is registered
      When I open the projects page
      Then no project setting can be changed from the list

    Scenario: Opening a project shows what it is for
      Given the project "work" is registered
      When I open the projects page
      And I open the project "work"
      Then the name field explains what it is for
      And the path is shown as fixed

    Scenario: A project can be renamed
      Given the project "work" is registered
      When I open the projects page
      And I open the project "work"
      And I rename the project to "work-core"
      Then "work-core" is listed as a project

    Scenario: The branch work starts from can be re-pointed
      Given the project "work" is registered
      When I open the projects page
      And I open the project "work"
      And I point it at the branch "develop"
      Then "work" starts work from "develop"

    Scenario: A name already taken is refused against the field
      Given the project "work" is registered
      And the project "other" is registered
      When I open the projects page
      And I open the project "other"
      And I rename the project to "work"
      Then the name field says the name is taken

    Scenario: A project can choose its own square
      Given the project "work" is registered
      When I open the projects page
      And I open the project "work"
      And I choose colour 3 and the letters "wk"
      Then the rail square for "work" says "WK"

    Scenario: The square follows the name until it is chosen
      Given the project "work" is registered
      When I open the projects page
      And I open the project "work"
      Then the square is on automatic

    Scenario: Authority can be handed back to the installation
      Given the project "work" is registered
      When I open the projects page
      And I open the project "work"
      Then the authority field offers following the installation

    Scenario: Removing a project takes two clicks
      Given the project "work" is registered
      When I open the projects page
      And I open the project "work"
      And I press remove once
      Then the project is still there
      When I confirm the removal
      Then "work" is no longer listed

    Scenario: Adding a repository says what it put in it
      When I add a project at a repository with no Factory directory
      # Not because a `git status` is coming — one is not, which is the point.
      # Git ignores the directory Factory just created and the editor's file
      # tree probably hides it, so this notice is the only place the files are
      # named at all.
      Then the page lists the scope it created
      And the page lists the worktree definitions it copied in
      And the page says git ignores all of it

    Scenario: A project with work still in it is not removed
      Given the project "work" is registered
      And the task "Add due dates" exists in "work" on "hello"
      When I open the projects page
      And I open the project "work"
      And I press remove once
      And I confirm the removal
      # Said on screen, with the count, rather than the project quietly
      # vanishing and its task with it.
      Then the page says 1 task is still in it
      And "work" is still listed

  Rule: The rail says which project the board is about

    Factory runs work in several repositories at once, and a board that mixes
    them is a board you have to read carefully. The rail picks one; everything
    that is genuinely about that project then narrows to it — including the
    definitions, which are files in the project and not rows to be filtered.

    Scenario: Every project has a square, and All is chosen to begin with
      Given the project "work" is registered
      When I open the tasks page
      Then the rail offers "work"
      And the board is showing every project

    Scenario: Choosing a project shows only its tasks
      Given the project defines the workflow "hello" that prints "hello"
      And the project "work" is registered
      And the task "In the repo" exists in "work" on "hello"
      And the task "Loose" exists on "hello"
      When I open the tasks page
      And I choose the project "work"
      Then "In the repo" is on the board
      And "Loose" is not on the board
      And the board counts 1 task in total

    Scenario: All brings everything back
      Given the project defines the workflow "hello" that prints "hello"
      And the project "work" is registered
      And the task "In the repo" exists in "work" on "hello"
      And the task "Loose" exists on "hello"
      When I open the tasks page
      And I choose the project "work"
      And I choose every project
      Then "Loose" is on the board

    Scenario: The choice is still there after a reload
      Given the project defines the workflow "hello" that prints "hello"
      And the project "work" is registered
      And the task "In the repo" exists in "work" on "hello"
      And the task "Loose" exists on "hello"
      When I open the tasks page
      And I choose the project "work"
      And I reload the page
      Then "Loose" is not on the board

    Scenario: A project's own workflows are what it can use
      Given a second project "other" that defines the workflow "deploy"
      When I open the workflows page
      And I choose the project "other"
      Then the workflow "deploy" is listed
      And "deploy" shows the project scope

    Scenario: Another project's workflows are not on offer
      Given the project defines the workflow "development"
      And the project "work" is registered
      And a second project "other" that defines the workflow "deploy"
      When I open the workflows page
      And I choose the project "work"
      Then the workflow "development" is listed
      And the workflow "deploy" is not listed

    Scenario: A project's square looks the same after a reload
      Given the project "work" is registered
      When I open the tasks page
      And I remember the colour of "work"
      And I reload the page
      Then "work" is the same colour

  Rule: A task's workflows are an ordered list, editable until it starts

    The order is what decides what runs when, so it is shown as an order:
    numbered, with the controls to change it. The old form had toggle buttons
    and no visible order at all.

    Scenario: New task has a page of its own
      When I open the tasks page
      And I start a new task
      Then the new task page is open

    Scenario: With no repository there is nowhere to put a task
      Given no repositories are registered
      When I open the new task page
      # A task happens in a project. Rather than a form that refuses on submit,
      # the one thing worth doing is offered.
      Then the page says a task needs a project
      And it offers to add a repository

    Scenario: A refusal is shown at the top, not under the buttons
      # The same reason the project form's banner moved. On a form with five
      # fields and a workflow list, a message below all of them is off the
      # screen at the moment it appears.
      Given the daemon refuses the next task
      When I open the new task page
      And I try to create the task
      Then the form says the task was refused
      And it says so above the first field

    Scenario: Workflows keep the order they were added in
      Given the project defines the workflow "hello" that prints "hello"
      And the project defines the workflow "development"
      When I start a new task from the board
      And I add the workflow "development"
      And I add the workflow "hello"
      Then the workflows are "development, hello"

    Scenario: The order can be changed before the task is made
      Given the project defines the workflow "hello" that prints "hello"
      And the project defines the workflow "development"
      When I start a new task from the board
      And I add the workflow "development"
      And I add the workflow "hello"
      And I move the second workflow up
      Then the workflows are "hello, development"

    Scenario: A workflow can be taken back out
      Given the project defines the workflow "hello" that prints "hello"
      And the project defines the workflow "development"
      When I start a new task from the board
      And I add the workflow "development"
      And I add the workflow "hello"
      And I remove the first workflow
      Then the workflows are "hello"

    Scenario: Two clicks in the same instant both count
      Given the project defines the workflow "hello" that prints "hello"
      And the project defines the workflow "development"
      When I start a new task from the board
      And I add "development" and "hello" in the same instant
      Then the workflows are "development, hello"

    Scenario: The same workflow can be run more than once
      Given the project defines the workflow "development"
      When I start a new task from the board
      And I add the workflow "development"
      And I add the workflow "development"
      Then the workflows are "development, development"

    Scenario: A task that has not started can be replanned from its page
      Given the project defines the workflow "hello" that prints "hello"
      And the project defines the workflow "development"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I open "Add due dates"
      And I add the workflow "development"
      And I save the workflows
      Then the workflows are "hello, development"

    Scenario: A task waiting for a person cannot be replanned
      Given the project defines the workflow "review" that writes a report and asks for approval
      And the task "Check it" exists on "review"
      When I open the tasks page
      And I queue "Check it"
      And "Check it" becomes "awaiting_approval" without me reloading
      And I open "Check it"
      Then the workflows cannot be changed

  Rule: The board says what each page is about

    Scenario: The menu is grouped into sections
      When I open the tasks page
      Then the menu has a "library" section
      And the menu has a "system" section
      And "Agents" is in the menu
      And "Environments" is in the menu

  Rule: A task can be renamed from its own page

    Scenario: Renaming a task
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I open "Add due dates"
      And I rename it to "Add due dates and times"
      Then the task is called "Add due dates and times"

    Scenario: A task waiting for a person cannot be renamed
      Given the project defines the workflow "review" that writes a report and asks for approval
      And the task "Check it" exists on "review"
      When I open the tasks page
      And I queue "Check it"
      And "Check it" becomes "awaiting_approval" without me reloading
      And I open "Check it"
      Then it cannot be renamed

  Rule: Environments are tracked by the flag the workflows earn

    Scenario: A project that does not use environments has nothing to show
      Given the project "work" is registered
      When I open the environments page
      Then the environments page is empty

    Scenario: Turning environments on writes the workflows into the project
      Given the project "work" is registered
      When I open the projects page
      And I turn environments on for "work"
      Then "work" says it gives each task an environment
      And the page lists what it copied in

    Scenario: A task holding an environment is listed under its project
      Given the project "work" is registered, using environments
      And the task "Seeded" in "work" is holding an environment
      # The flag is earned by a workflow that ran, not set by the test.
      When I open the environments page
      Then "Seeded" is listed as holding an environment

  Rule: A step chooses its agent from what exists

    Scenario: The provider field offers what is installed
      When I open the new phase page
      And I add a step
      And I set the step kind to "agent"
      Then the step's "provider" field offers "claude"

    Scenario: The agent field offers the agents this project can see
      Given the project defines the agent "developer"
      When I open the new phase page
      And I add a step
      And I set the step kind to "agent"
      Then the step's "agent" field offers "developer"

    Scenario: Naming an agent leaves only the prompt to fill in
      Given the project defines the agent "developer"
      When I open the new phase page
      And I add a step
      And I set the step kind to "agent"
      And I name the agent "developer" on the step
      Then the step still asks for a "prompt"
      And the step no longer asks for a "provider"
      And the step no longer asks for a "model"
      And the step says "developer" supplies them

    Scenario: One setting can still be overridden on the step
      Given the project defines the agent "developer"
      When I open the new phase page
      And I add a step
      And I set the step kind to "agent"
      And I name the agent "developer" on the step
      And I choose to override one
      Then the step asks for a "model" again

    Scenario: A setting already on the step is never hidden
      Given the project defines the agent "developer"
      When I open the new phase page
      And I add a step
      And I set the step kind to "agent"
      And I set the step's "effort" to "high"
      And I name the agent "developer" on the step
      Then the step still asks for a "effort"

  Rule: A task carries what it is for, and it is editable where it is read

    Scenario: Describing a task from its page
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I open "Add due dates"
      And I describe it as "Every todo gets an optional due date."
      Then the task's description is "Every todo gets an optional due date."

    Scenario: A task with no description invites one
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I open "Add due dates"
      Then the description asks what the task is for

    Scenario: A task waiting for a person cannot be described
      Given the project defines the workflow "review" that writes a report and asks for approval
      And the task "Check it" exists on "review"
      When I open the tasks page
      And I queue "Check it"
      And "Check it" becomes "awaiting_approval" without me reloading
      And I open "Check it"
      Then it cannot be described

  Rule: A phase's steps come with the vocabulary they can be written in

    Nothing in the builder used to say that `{{ task.directory }}` existed. The
    only way to find out was to read the daemon, so the dictionary is served
    from the same list the resolver uses rather than typed into the page.

    Scenario: The dictionary is collapsed until it is asked for
      When I open the new phase page
      Then the token dictionary is offered
      And the token list is not showing

    Scenario: Opening it lists the tokens a step may use
      When I open the new phase page
      And I open the token dictionary
      Then "{{ task.description }}" is listed
      And "{{ task.artifacts }}" is listed
      And "{{ project.path }}" is listed

    Scenario: A variable the phase declares is listed too
      When I open the new phase page
      And I declare the variable "region" as "eu-west-1"
      And I open the token dictionary
      Then "{{ phase.region }}" is listed

    Scenario: A phase that declares nothing says so rather than showing a gap
      When I open the new phase page
      And I open the token dictionary
      Then the phase namespace says it declares none yet

  Rule: A task is only offered workflows its project can actually run

    Scenario: A project that does not use worktrees is not offered them
      Given the project "plain" is registered, without worktrees
      When I start a new task from the board
      And I pick the project "plain" for the task
      Then "worktree-create" is not on offer
      And "worktree-delete" is not on offer

    Scenario: A project that uses worktrees still is
      Given the project "isolated" is registered, using worktrees
      When I start a new task from the board
      And I pick the project "isolated" for the task
      Then "worktree-create" is on offer

  Rule: picking a workflow brings in what it needs

    `verify` reads artifacts that three earlier workflows write. Picking it on
    its own used to make a task whose prompt pointed at files nothing produced.

    Scenario: Picking the last of a chain brings in the rest
      Given the project defines the chain "first" then "second" then "third"
      When I start a new task from the board
      And I pick the project "chained" for the task
      And I add the workflow "third"
      Then the workflows are "first, second, third"
      And it says what was brought in

    Scenario: Only the missing ones are added
      Given the project defines the chain "first" then "second" then "third"
      When I start a new task from the board
      And I pick the project "chained" for the task
      And I add the workflow "second"
      And I add the workflow "third"
      Then the workflows are "first, second, third"

    Scenario: A workflow that needs nothing is added on its own
      Given the project defines the chain "first" then "second" then "third"
      When I start a new task from the board
      And I pick the project "chained" for the task
      And I add the workflow "first"
      Then the workflows are "first"

  Rule: a workflow unticks itself when it is done, and you can tick it back

    Scenario: A workflow that has run is shown as having run
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I queue "Add due dates"
      And "Add due dates" becomes "done" without me reloading
      And I open "Add due dates"
      Then "hello" is marked as having run
      And "hello" is unticked

    Scenario: It cannot be taken off the list
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I queue "Add due dates"
      And "Add due dates" becomes "done" without me reloading
      And I open "Add due dates"
      Then "hello" has no remove button

    Scenario: A finished task offers to tick them all again
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I queue "Add due dates"
      And "Add due dates" becomes "done" without me reloading
      And I open "Add due dates"
      Then it offers to tick them all again

  Rule: an artifact is a document, and the task page is where you find it

    Five documents of Markdown were readable only as monospace source inside a
    run's evidence panel, and only if you opened the right run.

    Background:
      Given the project defines the workflow "review" that writes a report and asks for approval
      And the report it writes is a Markdown document
      And the task "Check it" exists on "review"
      When I open the tasks page
      And I queue "Check it"
      And I open "Check it"
      And I approve it
      And the task finishes

    Scenario: The task lists its artifacts
      Then "report" is listed as an artifact

    Scenario: They sit between the plan and the runs
      # The order the page reads in: what this task will do, what it produced,
      # then the machinery that produced it.
      Then the artifacts come after the workflows and before the runs

    Scenario: An artifact opens on a page of its own
      When I open the artifact "report"
      Then the artifact page shows its path

    Scenario: It is rendered, not printed
      When I open the artifact "report"
      Then "Findings" is a heading
      And the source markup is not on screen

    Scenario: The evidence header links to the readable version
      Then the path in the evidence header opens "report"

  Rule: an artifact is text an agent wrote, so nothing in it runs

    The prototype this follows renders the same content through `v-html` with no
    sanitiser. A model that emits an onerror attribute — quoting a bug report,
    say — would then be running script in the board.

    Background:
      Given the project defines the workflow "review" that writes a report and asks for approval
      And the report it writes tries to run something
      And the task "Check it" exists on "review"
      When I open the tasks page
      And I queue "Check it"
      And I open "Check it"
      And I approve it
      And the task finishes

    Scenario: A script attribute is stripped
      When I open the artifact "report"
      Then nothing on the page can run
      And the text around it is still shown

  Rule: a task says where its work is, and offers a way in

    The directory a task's steps run in was computed on every run and never left
    the daemon, so the first question anybody asks about a task that needs
    looking at by hand had no answer on screen.

    Nothing in Community can open a terminal — starting one is thoroughly
    platform-specific, and the open core has no platform detection in it
    anywhere. So this is the degrading half: the same command, to copy.

    Background:
      Given the project defines the workflow "hello" that prints "hello"
      And the project "work" is registered
      And the task "Add due dates" exists on "hello" in "work"
      When I open the tasks page
      And I open "Add due dates"

    Scenario: The row names the project and the directory
      Then the workspace row names the project "work"
      And the workspace row shows the project's directory

    Scenario: The path can be copied
      When I copy the workspace path
      Then the clipboard holds the project's directory
      And the page says it copied it

    Scenario: With nothing able to open a terminal, the command is offered
      Then the button offers to copy the command
      When I ask for a terminal
      Then the clipboard holds a command that changes directory there

    Scenario: The session control is there from the start, and says why it is not ready
      # Disabled rather than hidden: a control that only appears once a task
      # has run is one nobody knew to look for. Its reason now comes from the
      # plugin that owns it rather than being written into the page.
      Then the session control is offered but not ready
      And it says a session is recorded the first time an agent runs

    Scenario: Every button on the row comes from a plugin
      Then the row offers "Open terminal", "Open session" and "Diffity"


  Rule: a session an agent really had is offered back

    Factory chooses the session id, which is the only way to offer the exact
    conversation again: Claude's interactive `--continue` refuses the sessions
    `claude -p` creates, and "the most recent one in this directory" is the
    wrong one as soon as two tasks share a directory.

    The control is there either way and only becomes usable once an agent has
    run, because until then there is no conversation — and the id is recorded
    when the process starts, not when the run is planned.

    Background:
      Given the project defines the workflow "review" whose agent carries a session
      And the project "work" is registered
      And the task "Check it" exists on "review" in "work"
      When I open the tasks page

    Scenario: Before anything runs the session control is not ready
      When I open "Check it"
      Then the session control is offered but not ready

    Scenario: After the agent has run the session can be opened
      When I queue "Check it"
      And the task finishes
      And I open "Check it"
      Then the session control is ready
      And the session command resumes by id

    Scenario: Copying the session gives the resuming command
      When I queue "Check it"
      And the task finishes
      And I open "Check it"
      And I ask for the session
      Then the clipboard holds a command that resumes by id

    Scenario: The plain control still only changes directory
      When I queue "Check it"
      And the task finishes
      And I open "Check it"
      And I ask for a terminal
      # Having a session has not stopped "where is this happening" being a
      # question worth asking.
      Then the clipboard holds a command that changes directory there

  Rule: the buttons are a registry, so somebody else can add one

    Background:
      Given the project defines the workflow "hello" that prints "hello"
      And the project declares a plugin contributing its own task tool
      And the project "work" is registered
      And the task "Add due dates" exists on "hello" in "work"
      When I open the tasks page
      And I open "Add due dates"

    Scenario: An outsider's button appears with no change to Factory
      Then the row offers a button labelled "Acme docs"
      And it says which plugin provided it

    Scenario: Switching that plugin off takes its button away
      When I open the plugins page
      And I switch off the plugin providing "Acme docs"
      And I open the task again
      Then the row does not offer "Acme docs"

  Rule: the interface scale is the whole interface, and the rails give way

    Scaling with CSS `zoom` has two traps, and both only appear above 1×.
    `100vh` is measured in unzoomed pixels, so a full-height shell lays out
    taller than the window and the document grows a scrollbar of its own —
    which would carry the menu off the top, undoing the point. And a media
    query measures the unzoomed window, so a layout that collapses "on a narrow
    screen" never collapses however far you zoom in.

    Background:
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page
      And I open "Add due dates"

    Scenario: At three times the size the window is still the window
      When I set the interface size to 3
      Then the page itself does not scroll
      And the shell is exactly the height of the window

    Scenario: And the rails give up their room
      When I set the interface size to 3
      Then the project rail is hidden
      And the menu is still there

    Scenario: Back at one the rail returns
      When I set the interface size to 3
      And I set the interface size to 1
      Then the project rail is shown

  Rule: the theme is applied through tokens, not hard-coded colors

    Background:
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page

    Scenario: Setting data-theme to light switches the page to the light palette
      When the root element's data-theme becomes "light"
      Then the page background is the light base color

    Scenario: The veil tokens flip from a white tint to a black tint under light
      When the root element's data-theme becomes "light"
      Then the veil tokens are black-based
      When the root element's data-theme becomes "dark"
      Then the veil tokens are white-based

    Scenario: A draft badge's fill follows the tokens, not a fixed white tint
      When the root element's data-theme becomes "light"
      Then the draft badge's background is the light veil-strong color

  Rule: the theme is remembered, and system means the browser decides

    Background:
      Given the project defines the workflow "hello" that prints "hello"
      And the task "Add due dates" exists on "hello"
      When I open the tasks page

    Scenario: Choosing light applies it and it survives a reload
      When I open the settings page
      And I choose the "Light" theme
      Then the page uses the "light" theme
      When the page is reloaded
      Then the page uses the "light" theme

    Scenario: Choosing dark applies it and it survives a reload
      When I open the settings page
      And I choose the "Dark" theme
      Then the page uses the "dark" theme
      When the page is reloaded
      Then the page uses the "dark" theme

    Scenario: System follows what the browser reports
      Given the browser prefers a light color scheme
      When I open the settings page
      And I choose the "System" theme
      Then the page uses the "light" theme

    Scenario: And keeps following it after the browser changes its mind
      Given the browser prefers a light color scheme
      When I open the settings page
      And I choose the "System" theme
      And the browser starts preferring a dark color scheme
      Then the page uses the "dark" theme

    Scenario: Choosing light on the settings page actually repaints a formerly white-tinted element
      When I open the settings page
      And I choose the "Light" theme
      And I open the tasks page
      Then the draft badge's background is the light veil-strong color

  Rule: nobody starts an agent without being told what one can reach

    Factory coordinates other people's coding agents against real repositories.
    Until this increment it did that with no boundary of its own and said
    nothing about it, so the first way anybody found out was by reading the
    source.

    The daemon is the gate — the CLI and `curl` start runs too — and the board's
    job is to turn its refusal into something a person can act on, wherever they
    pressed the button.

    Background:
      Given nothing has been accepted on this installation

    Scenario: Browsing costs nothing
      When I open the tasks page
      # Reading is not running. Gating the whole app would be the wrong shape:
      # the thing that needs agreement is starting an agent.
      Then the board says there is nothing yet
      And no disclaimer is in the way

    Scenario: Queueing shows what an agent can reach
      When I open the tasks page
      And I create the task "Add due dates" on "hello"
      And I queue it
      Then the disclaimer appears
      And it says what an agent can do inside the workspace
      And it names the profile that removes the boundaries
      And it says plainly that Factory is not a sandbox

    Scenario: Accepting it continues what was refused
      When I open the tasks page
      And I create the task "Add due dates" on "hello"
      And I queue it
      And I accept the disclaimer
      Then the disclaimer is gone
      # The button says "Continue", so continuing is what it does: the queue
      # that was refused happens. A person who has just read a page about agent
      # autonomy has already decided, and making them press it twice is a worse
      # reading of the same word.
      And "Add due dates" leaves "draft"

    Scenario: Reviewing the permissions puts the panel away
      When I open the tasks page
      And I create the task "Add due dates" on "hello"
      And I queue it
      And I follow "Review permissions"
      # The panel is fixed over the whole viewport in the shell, so a route
      # change does not touch it — and the one link that sends somebody to read
      # was blocking the page it sent them to.
      Then the disclaimer is gone
      And the settings page says nothing has been accepted

    Scenario: Reviewing it does not accept it, and starts nothing
      When I open the tasks page
      And I create the task "Add due dates" on "hello"
      And I queue it
      And I follow "Review permissions"
      # Somebody who chose to go and read has not asked for the run to start.
      Then "Add due dates" is still "draft"

    Scenario: It can be accepted from the settings page
      When I open the tasks page
      And I create the task "Add due dates" on "hello"
      And I queue it
      And I follow "Review permissions"
      And I accept it there
      Then the settings page says it is accepted
      # Accepting from a settings page is not "continue what I was doing".
      And "Add due dates" is still "draft"

  Rule: Full Access is impossible to miss

    Background:
      Given the installation runs under Full Access

    Scenario: The marker is in the shell, on every page
      When I open the tasks page
      Then the Full Access marker is visible
      And it is still visible on the settings page

    Scenario: The marker survives the largest interface scale
      When I open the tasks page
      And the interface scale becomes 3
      # The rails give up their room at that scale; the nav narrows and stays,
      # which is why the marker lives there and not in a banner.
      Then the Full Access marker is visible

  Rule: a project's work is queued and stopped from its own board

    The board knew which project it was showing and never said so: the title
    read "Tasks" whatever was chosen, and the only sign was a ring on a 40px
    square. Buttons that act on every task in a project cannot be that quiet —
    "Stop all" has to be able to say all of what.

    So the header names the project, and the two buttons appear only when one is
    chosen. Under "All" there is no graph to order and no project to stop.

    Scenario: The header names the board you are looking at
      Given the project "work" is registered
      When I open the tasks page
      And I choose the project "work"
      Then the header says "Tasks · work"

    Scenario: Under All there is nothing to queue or stop
      Given the project "work" is registered
      When I open the tasks page
      Then Queue all is not offered
      And Stop all is not offered

    Scenario: Choosing a project offers both
      Given the project "work" is registered
      When I open the tasks page
      And I choose the project "work"
      Then Queue all is offered
      And Stop all is offered

    Scenario: Queue all starts the project's work
      Given the project "work" is registered
      And the task "One" exists in "work" on "hello"
      And the task "Two" exists in "work" on "hello"
      When I open the tasks page
      And I choose the project "work"
      And I queue the whole project
      Then "One" leaves "draft"
      And "Two" leaves "draft"

    Scenario: Queue all leaves another project's work alone
      Given the project "work" is registered
      And the task "One" exists in "work" on "hello"
      And the task "Loose" exists on "hello"
      When I open the tasks page
      And I choose the project "work"
      And I queue the whole project
      And I choose every project
      # The buttons are project-level because the graph is.
      Then "Loose" is still "draft"

    Scenario: Queue all says how many it queued
      Given the project "work" is registered
      And the task "One" exists in "work" on "hello"
      And the task "Two" exists in "work" on "hello"
      When I open the tasks page
      And I choose the project "work"
      And I queue the whole project
      Then the board says "Queued 2 tasks."

    Scenario: Queue all says what it left alone, and why
      Given the project "work" is registered
      And the task "One" exists in "work" on "hello"
      And the task "Unplanned" exists in "work" with no workflow
      When I open the tasks page
      And I choose the project "work"
      And I queue the whole project
      Then the board says "Queued 1 task."
      # The names, not a count: "1 was skipped" sends somebody hunting through
      # the board for which one.
      And it says "Unplanned" was left alone because nothing in its plan is ticked

    Scenario: Queue all with nothing to queue says so rather than nothing
      Given the project "work" is registered
      And the task "Unplanned" exists in "work" with no workflow
      When I open the tasks page
      And I choose the project "work"
      And I queue the whole project
      # The first use of this button against a real project queued nothing,
      # because every draft in it had an empty plan, and the board said
      # nothing at all. A button that answers silence looks broken.
      Then the board says "Nothing was queued."
      And it says "Unplanned" was left alone because nothing in its plan is ticked

    Scenario: The report can be dismissed
      Given the project "work" is registered
      And the task "One" exists in "work" on "hello"
      When I open the tasks page
      And I choose the project "work"
      And I queue the whole project
      And I dismiss the report
      Then the board says nothing about a batch

    Scenario: Stop all says when there was nothing to stop
      Given the project "work" is registered
      And the task "One" exists in "work" on "hello"
      When I open the tasks page
      And I choose the project "work"
      And I stop the whole project
      Then the board says "Nothing was running."

    Scenario: Stopping everything asks first
      Given the project "work" is registered
      And the task "One" exists in "work" on "hello"
      When I open the tasks page
      And I choose the project "work"
      And I press Stop all
      # Killing an agent mid-sentence has no undo. The definition editor asks
      # twice before deleting for the same reason.
      Then it asks whether I really mean it

    Scenario: Stop all cancels what is running, and nothing starts again
      Given the project defines a workflow "slow" that does not finish
      And the project "work" is registered
      And the task "One" exists in "work" on "slow"
      And the task "Two" exists in "work" on "slow"
      When I open the tasks page
      And I choose the project "work"
      And I queue the whole project
      And "One" is running
      And I stop the whole project
      Then the board says "Stopped 2 tasks."
      And "One" is "cancelled"
      And "Two" is "cancelled"
      # The clause worth watching: cancelling wakes the scheduler, so a stop
      # that only killed processes would start the next task within a tick.
      And nothing starts again

  Rule: a task says what it waits for, and the task page is where you say it

    A dependency decides when work starts, so it belongs beside the plan, which
    decides what the work is.

    The board draws what it is still waiting for and not what it already has:
    a line listing finished blockers never goes away.

    Scenario: A new task waits for nothing
      Given the project "work" is registered
      And the task "One" exists in "work" on "hello"
      When I open the tasks page
      And I open "One"
      Then the page says it waits for nothing

    Scenario: A task can be made to wait for another
      Given the project "work" is registered
      And the task "Scaffold" exists in "work" on "hello"
      And the task "The model" exists in "work" on "hello"
      When I open the tasks page
      And I open "The model"
      And I make it wait for "Scaffold"
      Then it waits for "Scaffold"
      And "Scaffold" has not happened yet

    Scenario: The board row says what it is waiting for
      Given the project "work" is registered
      And the task "Scaffold" exists in "work" on "hello"
      And the task "The model" exists in "work" on "hello"
      When I open the tasks page
      And I open "The model"
      And I make it wait for "Scaffold"
      And I go back to the board
      Then the row for "The model" says it is waiting for "Scaffold"

    Scenario: A ring is refused where it was asked for
      Given the project "work" is registered
      And the task "Scaffold" exists in "work" on "hello"
      And the task "The model" exists in "work" on "hello"
      When I open the tasks page
      And I open "The model"
      And I make it wait for "Scaffold"
      And I go back to the board
      And I open "Scaffold"
      And I make it wait for "The model"
      # The daemon's sentence, which is the store's sentence. Rewording it in
      # the browser would be a second explanation of one rule.
      Then the refusal says it would make a ring

    Scenario: The dependency can be taken back
      Given the project "work" is registered
      And the task "Scaffold" exists in "work" on "hello"
      And the task "The model" exists in "work" on "hello"
      When I open the tasks page
      And I open "The model"
      And I make it wait for "Scaffold"
      And I stop it waiting for "Scaffold"
      Then the page says it waits for nothing

    Scenario: A task does not start while it is waiting
      Given the project "work" is registered
      And the task "Scaffold" exists in "work" with no workflow
      And the task "The model" exists in "work" on "hello"
      When I open the tasks page
      And I choose the project "work"
      And I open "The model"
      And I make it wait for "Scaffold"
      And I go back to the board
      And I queue the whole project
      # "Scaffold" has nothing to run, so Queue all leaves it a draft and
      # nothing can satisfy the dependency until somebody says it is done.
      Then "The model" is still "queued"

    Scenario: Marking the blocker done by hand releases it
      Given the project "work" is registered
      And the task "Scaffold" exists in "work" with no workflow
      And the task "The model" exists in "work" on "hello"
      When I open the tasks page
      And I choose the project "work"
      And I open "The model"
      And I make it wait for "Scaffold"
      And I go back to the board
      And I queue the whole project
      And I open "Scaffold"
      And I mark it done
      # Work done outside Factory is still work done. Its dependents stop
      # waiting the moment it is marked.
      Then "The model" leaves "queued"
      # And the row stops saying it: a line listing blockers that have already
      # happened would never go away.
      And the row for "The model" says nothing about waiting

    Scenario: Another project's tasks are not on offer
      Given the project "work" is registered
      And the task "One" exists in "work" on "hello"
      And the task "Two" exists in "work" on "hello"
      And the task "Loose" exists on "hello"
      When I open the tasks page
      And I open "One"
      Then "Two" can be chosen to wait for
      # A dependency between projects has no owner, and the store refuses one.
      # Offering it would be offering a refusal.
      And "Loose" cannot be chosen to wait for

  Rule: the settings page is where an installation is configured

    The theme and the interface scale are driven through this page by the
    scenarios above, so it is opened — but the setting worth the most care had
    no coverage at all: what agents may reach. It is the one a person is most
    likely to change without knowing what it costs, and choosing the option
    that removes the workspace boundary should never be quiet.

    Background:
      Given the project defines the workflow "hello" that prints "hello"
      When I open the tasks page

    Scenario: The page says where the settings file is
      When I open the settings page
      Then it names the file it writes
      And the file is in the user scope

    Scenario: The execution profile is chosen here and stays chosen
      When I open the settings page
      And I choose Full Access
      Then Full Access is marked as chosen
      And the page warns what Full Access costs
      When the page is reloaded
      Then Full Access is marked as chosen

    Scenario: Confining agents again takes the warning away
      When I open the settings page
      And I choose Full Access
      And I choose the default profile
      Then the page does not warn about Full Access

  Rule: a task says how much to trust it, and what is still uncertain

    "Is it done" is answered by the state. "How much should I trust that" was
    the question this page could not answer at all.

    Two numbers, always together: a 93 with 20% coverage is not the same claim
    as a 93 with 96%, and showing only the first is how a confidence number
    becomes flattery.

    Scenario: A task nobody has judged says so rather than showing a zero
      Given a task nobody has judged
      When I open that task
      Then the reliability card says it is not assessed
      And it offers to assess it

    Scenario: A judged task shows the score and the coverage together
      Given a task judged at 88 with 70% coverage
      When I open that task
      Then the reliability card shows 88
      And it shows the coverage

    Scenario: A fall is shown with an arrow, not with colour alone
      Given a task judged at 88 with 70% coverage
      When I open that task
      Then the card shows a downward arrow

    Scenario: The breakdown is there for anybody who wants it
      Given a task judged at 88 with 70% coverage
      When I open that task
      And I show the breakdown
      Then every dimension is listed

    Scenario: A ceiling says what applied it
      Given a task capped at 70 by a critical risk
      When I open that task
      Then the card says what capped it

    Scenario: A stale judgement says so
      Given a task whose judgement is stale
      When I open that task
      Then the card says it is stale

    Scenario: The card sits beside the work, not under it
      Given a task judged at 88 with 70% coverage
      When I open that task
      Then the reliability card is in the rail

  Rule: the graph shows the score falling, because that is the useful part

    A validation that finds a regression has learned something. A graph that
    could only rise would hide the most valuable thing this feature produces.

    Scenario: A history of several judgements is drawn
      Given a task judged four times, the third lower than the second
      When I open that task
      Then the graph is drawn
      And it has 4 points

    Scenario: The fall is visible in the drawing
      # Read off the geometry, not off a label: a point that fell is lower on
      # the screen, and a graph that normalised that away would pass a test
      # that only read the numbers back.
      Given a task judged four times, the third lower than the second
      When I open that task
      Then the third point is below the second

    Scenario: A point says why it moved
      Given a task judged four times, the third lower than the second
      When I look at the third point
      Then it says what changed

    Scenario: One judgement is not a graph
      Given a task judged once
      When I open that task
      Then no graph is drawn

  Rule: the drivers say who should deal with them

    Scenario: A driver is listed with its owner
      Given a task with a high driver the agent can resolve
      When I open that task
      Then the drivers list names it
      And it says the agent can resolve it

    Scenario: The worst thing is listed first
      Given a task with a critical driver and a low one
      When I open that task
      Then the critical group comes before the low group

    Scenario: A resolved driver moves out of the way
      Given a task with a high driver the agent can resolve
      When I resolve that driver
      Then it is no longer in the list
      And it is counted among the ones dealt with

    Scenario: Accepting a risk asks why first
      # An acceptance nobody explained is indistinguishable afterwards from one
      # nobody meant.
      Given a task with a high driver the agent can resolve
      When I click to accept that risk
      Then it asks why

    Scenario: A task with nothing outstanding says so
      Given a task judged at 88 with 70% coverage
      When I open that task
      Then the drivers list is not drawn

