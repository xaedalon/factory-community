Feature: Where a task's steps run

  One question — "which directory is this task's work happening in?" — had two
  answers in the codebase. The daemon built the path to decide where to run, and
  `doctor.worktreeMissing` built it again to decide whether to complain, and
  nothing would have failed if the two had drifted apart. This is the one
  answer, and both of them now ask it.

  It takes `exists` as a parameter, the way the rest of this module takes
  `join`, so the rule can be exercised without a filesystem and core still
  needs no import from `node:fs`.

  There is always an answer. This used to return nothing for a task that
  belonged to no project, and every caller carried a fallback to the directory
  the daemon happened to be started in. A task belongs to a project now, so the
  question is always answerable and the fallbacks are gone.

  Scenario: A project that works in place runs in its own checkout
    Given the project "todolist" at "/repos/todolist" works in place
    And the task's directory is "add-due-dates"
    When I ask where its steps run
    Then the workspace is "/repos/todolist"
    And it is not a worktree

  Scenario: A project that works in place never looks for a worktree
    Given the project "todolist" at "/repos/todolist" works in place
    And the task's directory is "add-due-dates"
    And a directory is left over at "/worktrees/todolist/add-due-dates"
    When I ask where its steps run
    # The setting doing its job, and something more: a directory left over from
    # before the setting was turned off cannot silently win.
    Then the workspace is "/repos/todolist"
    And no worktree was considered

  Scenario: A project using worktrees runs in the task's own one
    Given the project "todolist" at "/repos/todolist" uses worktrees
    And the task's directory is "add-due-dates"
    And a directory is left over at "/worktrees/todolist/add-due-dates"
    When I ask where its steps run
    Then the workspace is "/worktrees/todolist/add-due-dates"
    And it is a worktree

  Scenario: A worktree that is not there falls back to the repository
    Given the project "todolist" at "/repos/todolist" uses worktrees
    And the task's directory is "add-due-dates"
    When I ask where its steps run
    Then the workspace is "/repos/todolist"
    And it is not a worktree
    And the worktree it looked for was "/worktrees/todolist/add-due-dates"

  Scenario: A task with no directory of its own runs in the repository
    Given the project "todolist" at "/repos/todolist" uses worktrees
    And the task has no directory
    When I ask where its steps run
    Then the workspace is "/repos/todolist"
    And no worktree was considered

  Rule: the disk is trusted, not the flag

    `hasWorktree` records that a workflow claimed to create one. It is not
    evidence that one is there — and it is not evidence that one is not.
    Resolution looks, every time, because a step that runs in the wrong
    directory is worse than a flag that is out of date.

    Scenario: A worktree that exists is used even without the flag
      Given the project "todolist" at "/repos/todolist" uses worktrees
      And the task's directory is "add-due-dates"
      And the task does not have the flag "hasWorktree"
      And a directory is left over at "/worktrees/todolist/add-due-dates"
      When I ask where its steps run
      Then the workspace is "/worktrees/todolist/add-due-dates"
      And it is a worktree

    Scenario: The flag alone does not conjure one
      Given the project "todolist" at "/repos/todolist" uses worktrees
      And the task's directory is "add-due-dates"
      And the task has the flag "hasWorktree"
      When I ask where its steps run
      Then the workspace is "/repos/todolist"
      And it is not a worktree
