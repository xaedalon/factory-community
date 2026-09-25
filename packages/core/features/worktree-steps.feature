Feature: The worktree step kind
  Two agents working in one checkout is the failure Factory exists to prevent:
  they overwrite each other's edits, and one `git checkout` throws away work
  nobody committed. A worktree per task is the boring, built-in answer.

  It is a step kind rather than something the engine does behind the scenes, so
  a workflow asks for isolation and a project that does not want it simply never
  does. What the step adds over writing the git command by hand is the three
  cases people get wrong: the directory already exists, the branch already
  exists, and a removal while something still holds the worktree.

  Scenario: Creating a worktree on a new branch
    Given the step:
      """
      uses: worktree
      action: create
      path: /tmp/worktrees/add-due-dates
      branch: feature/due-dates
      """
    When the step is planned
    Then the command is bash
    And the script would create a worktree at "/tmp/worktrees/add-due-dates"
    And the script checks whether the directory already exists
    And the script uses the existing branch when there is one

  Scenario: Creating from a named starting point
    Given the step:
      """
      uses: worktree
      action: create
      path: /tmp/worktrees/hotfix
      branch: hotfix/login
      from: origin/main
      """
    When the step is planned
    Then the script starts the branch from "origin/main"

  Scenario: A path with a space is quoted
    Given the step:
      """
      uses: worktree
      action: create
      path: /tmp/my worktrees/add-due-dates
      branch: feature/due-dates
      """
    When the step is planned
    Then the script quotes the path

  Scenario: Creating without a branch is refused
    Given the step:
      """
      uses: worktree
      action: create
      path: /tmp/worktrees/add-due-dates
      """
    When the step is planned
    Then the step would fail with a message about the branch

  Scenario: Removing a worktree
    Given the step:
      """
      uses: worktree
      action: remove
      path: /tmp/worktrees/add-due-dates
      """
    When the step is planned
    Then the script removes the worktree
    And the script prunes git's record of it
    And the script does nothing when the directory is already gone
    # Because the step usually runs *in* the worktree it is removing: the
    # workspace is resolved when the plan is made, while it is still there.
    # Removing the directory a process is sitting in leaves git with no
    # current directory to read — "fatal: Unable to read current working
    # directory" — and the prune that follows never happens.
    And the script leaves the worktree before removing it

  Scenario: An action the kind does not have is a validation error
    Given the step:
      """
      uses: worktree
      action: teleport
      path: /tmp/worktrees/add-due-dates
      """
    When the step is parsed
    Then parsing fails
    And the problem names the field "action"
