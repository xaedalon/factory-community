Feature: The buttons on a task come from plugins

  "Open terminal" and "Open session" were two buttons written into the board,
  with their commands resolved by name inside a route. A diff viewer would have
  made three, and the fourth would have been somebody else's and impossible.

  So a tool returns *data* — a directory and, optionally, argv — and never
  performs anything. That is what lets the same tool work where a terminal can
  be opened and where it cannot, and it is what makes one testable without an
  operating system.

  Background:
    Given a host with no terminal capability

  Rule: a tool is offered in the order it asked for

    Scenario: Lower order lists first
      Given a tool "second" with order 20
      And a tool "first" with order 10
      When the tools for a task are gathered
      Then the tools are "first, second"

    Scenario: A tool with no order lands after the ones that named one
      Given a tool "built-in" with order 10
      And a tool "third-party" with no order
      When the tools for a task are gathered
      Then the tools are "built-in, third-party"

    Scenario: Tools with the same order keep the order they registered in
      Given a tool "alpha" with order 10
      And a tool "beta" with order 10
      When the tools for a task are gathered
      Then the tools are "alpha, beta"

  Rule: unavailable is a reason, not a disappearance

    A control that only appears once a task has run is one nobody knew to look
    for. So "you cannot use this yet" is a disabled button carrying its reason,
    and only "this is not for you at all" is absent.

    Scenario: A tool that cannot be used is still offered, with its reason
      Given a tool "diffity" that is unavailable because "diffity is not installed"
      When the tools for a task are gathered
      Then "diffity" is offered
      And "diffity" says it is unavailable because "diffity is not installed"

    Scenario: A tool that does not apply to this task is not offered at all
      Given a tool "jira" that offers nothing for this task
      When the tools for a task are gathered
      Then there are no tools

    Scenario: A tool from a plugin that is switched off is not offered
      Given a tool "diffity" that opens a diff
      And the plugin that provided it is switched off
      When the tools for a task are gathered
      # The host has no unload, so the switch has to bite here to bite at all
      # before a restart.
      Then there are no tools

  Rule: what you copy is what the host would run

    Scenario: A tool with no command is a shell in the workspace
      Given a tool "open-terminal" with no command
      When the tools for a task are gathered
      Then "open-terminal" would run "cd /repos/todolist"

    Scenario: A tool with a command appends it
      Given a tool "open-session" that runs "claude --resume abc"
      When the tools for a task are gathered
      Then "open-session" would run "cd /repos/todolist && claude --resume abc"

    Scenario: A workspace path with a space is quoted, not interpolated
      Given the task's workspace is "/repos/my work"
      And a tool "open-terminal" with no command
      When the tools for a task are gathered
      Then "open-terminal" would run "cd '/repos/my work'"

    Scenario: A tool on a task whose project is missing says no directory
      Given the task's project is not in the database
      And a tool "jira" that runs "open https://example.test"
      When the tools for a task are gathered
      # `cd ''` is a worse answer than none.
      Then "jira" would run "open https://example.test"

  Rule: whether it can be performed is served, not guessed

    A client cannot know whether a terminal capability is registered. Asking it
    to guess is how a board ends up drawing a button that fails on click.

    Scenario: With nothing able to open a terminal, a terminal tool is not runnable
      Given a tool "open-terminal" with no command
      When the tools for a task are gathered
      Then "open-terminal" is not runnable

    Scenario: With something able to open one, it is
      Given something that can open a terminal is installed
      And a tool "open-terminal" with no command
      When the tools for a task are gathered
      Then "open-terminal" is runnable

    Scenario: A detached tool is runnable either way
      Given a tool "diffity" that runs "diffity main" detached
      When the tools for a task are gathered
      # The daemon starts it itself; nothing needs to be installed to perform it.
      Then "diffity" is runnable

  Rule: one misbehaving plugin does not take the page down

    Scenario: A tool that throws is reported as unavailable
      Given a tool "broken" that throws when asked
      And a tool "fine" with no command
      When the tools for a task are gathered
      Then "broken" says it is unavailable
      And "fine" is offered

    Scenario: A tool that never answers is given a deadline
      Given a tool "slow" that never answers
      And a tool "fine" with no command
      When the tools for a task are gathered with a 50ms deadline
      Then "slow" says it is unavailable
      And "fine" is offered

  Rule: the label is the one a capability already has

    Scenario: displayName is the button
      Given a tool "diffity" whose display name is "Diffity"
      When the tools for a task are gathered
      Then "diffity" is labelled "Diffity"

    Scenario: With no display name the id is the label
      Given a tool "open-terminal" with no command
      When the tools for a task are gathered
      Then "open-terminal" is labelled "open-terminal"
