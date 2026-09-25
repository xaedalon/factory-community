Feature: A project gets its own copy of the built-ins that ask for one
  Some built-in workflows cannot know your setup. Where a worktree goes differs
  per repository; what an environment is made of differs far more. Those
  workflows say so — `override: required` — and turning on the project setting
  that needs them is what puts an editable copy in the project.

  Copying rather than warning, because the warning on its own leaves someone to
  work out which file to create and what to put in it. The copy is the answer
  to both, and it lands in the repository ready to share the moment that
  project shares its Factory directory — whereupon everyone who clones it gets
  the same one.

  Background:
    Given a project scope and a user scope

  Scenario: Turning worktrees on copies the worktree workflows in
    When the worktree definitions are scaffolded
    Then "worktree-create" is written into the project
    And "worktree-delete" is written into the project

  Scenario: The phases they need come with them
    When the worktree definitions are scaffolded
    Then the phase "worktree-add" is written into the project
    And the phase "worktree-remove" is written into the project

  Scenario: The copy resolves from the project afterwards
    When the worktree definitions are scaffolded
    Then "worktree-create" resolves from the "project" scope

  Scenario: Scaffolding twice changes nothing the second time
    Given the worktree definitions have been scaffolded
    When the worktree definitions are scaffolded
    Then nothing new is written
    And "worktree-create" is reported as already there

  Scenario: A copy someone has edited is never overwritten
    Given the project defines its own "worktree-create"
    When the worktree definitions are scaffolded
    Then "worktree-create" is reported as already there
    And the project's own "worktree-create" is untouched

  Scenario: Environments bring their own three
    When the environment definitions are scaffolded
    Then "environment-create" is written into the project
    And "environment-update" is written into the project
    And "environment-delete" is written into the project
