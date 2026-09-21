Feature: Projects — the repositories Factory works in
  Everything before this ran wherever the daemon happened to be started, which
  is fine for one repository and wrong for two. A project says where a piece of
  work happens: a name, a path, the branch work starts from, and where its
  worktrees go.

  A task belongs to a project, or to none — `factory run` in a directory needs
  no project, and refusing to record work without one would mean the only tasks
  Factory can keep are the ones created through the board.

  The path is checked when it is written rather than when something tries to run
  there. A project pointing at a directory that does not exist fails at the
  moment someone can still fix it easily, not in the middle of a run.

  A project decides whether each of its tasks gets a worktree of its own. When it
  does not, work happens in the repository itself — which is a reasonable thing
  to want, and has one consequence that cannot be negotiated: two agents in one
  working copy overwrite each other, so that project runs one task at a time.
  Somewhere without a `.git` directory cannot have worktrees at all, so it works
  that way from the start.

  Background:
    Given an empty store
    And a directory that is a git repository

  Scenario: Adding a project
    When I add the project "factory" at that directory
    Then the project is stored
    And the project's branch is "main"
    And the project has somewhere to put worktrees

  Scenario: A project needs a directory that exists
    When I add the project "ghost" at a path that does not exist
    Then it is refused
    And the error names the path

  Scenario: A project needs a directory, not a file
    When I add the project "afile" at a file
    Then it is refused

  Scenario: A directory that is not a repository is allowed, and said so
    Given a directory that is not a git repository
    When I add the project "notes" at that directory
    Then the project is stored
    And the project is marked as not being a repository

  Scenario: Names are unique
    Given the project "factory" exists
    When I add the project "factory" at that directory again
    Then it is refused
    And the error says the name is taken

  Scenario: A task can belong to a project
    Given the project "factory" exists
    When I create a task "Add due dates" in "factory"
    Then the task belongs to "factory"

  Scenario: A task need not belong to one
    When I create a task "Add due dates" with no project
    Then the task belongs to no project

  Scenario: Removing a project leaves its tasks without one
    Given the project "factory" exists
    And a task "Add due dates" in "factory"
    When I remove the project
    Then the task still exists
    And the task belongs to no project

  Scenario: Projects are listed by name
    Given the project "zebra" exists
    And the project "alpha" exists
    When I list the projects
    Then they are "alpha, zebra" in that order

  Scenario: A project gives each task its own worktree unless it says otherwise
    When I add the project "factory" at that directory
    Then the project uses worktrees

  Scenario: A project can be added to work in its own checkout instead
    When I add the project "factory" at that directory, working in place
    Then the project does not use worktrees
    And the project still remembers where worktrees would go

  Scenario: A directory that is not a repository works in place from the start
    Given a directory that is not a git repository
    When I add the project "notes" at that directory
    Then the project does not use worktrees

  Scenario: Asking for worktrees where there is no repository is refused
    Given a directory that is not a git repository
    When I add the project "notes" at that directory, using worktrees
    Then it is refused
    And the error says it is not a git repository

  Scenario: Worktrees can be turned off after the project was added
    Given the project "factory" exists
    When I turn its worktrees off
    Then the project does not use worktrees

  Scenario: Turning worktrees back on needs a repository
    Given a directory that is not a git repository
    And the project "notes" exists there
    When I turn its worktrees on
    Then it is refused

  Scenario: Turning worktrees on notices a directory that has since become one
    Given a directory that is not a git repository
    And the project "notes" exists there
    And the directory becomes a git repository
    When I turn its worktrees on
    Then the project uses worktrees
    And the project is no longer marked as not being a repository

  Scenario: Changing the setting is announced
    Given the project "factory" exists
    When I turn its worktrees off
    Then a "project.changed" event says so

  Scenario: Changing a project that is not there is refused
    When I turn worktrees off on a project that does not exist
    Then it is refused

  Rule: a project can be renamed, and its branch re-pointed

    A project is identified by what it is, not by what it was called when
    somebody typed it in. Renaming and re-pointing were the two fields a person
    could only change by removing the project and adding it again — which nulls
    the `project_id` of every task that ever ran in it, so the record of the
    work survives pointing at nothing.

    The branch matters more than it looks. Aiming Factory's merges somewhere
    other than `main` is the obvious way to keep a published repository's
    default branch clean, and until now that cost you every task in the project.

    The path is deliberately not in this list. Worktree roots are derived from
    it and every run that ever happened recorded it, so a project that moves is
    a different project, and saying so is kinder than pretending otherwise.

    Scenario: A project can be renamed
      Given the project "factory" exists
      When I rename it to "factory-core"
      Then the project is called "factory-core"
      And its tasks still belong to it

    Scenario: Renaming is announced
      Given the project "factory" exists
      When I rename it to "factory-core"
      Then a "project.changed" event says so

    Scenario: A name still has to be unique
      Given the project "factory" exists
      And the project "notes" exists there
      When I rename "notes" to "factory"
      Then it is refused

    Scenario: A project keeps its name when renamed to what it already is
      Given the project "factory" exists
      When I rename it to "factory"
      Then the project is called "factory"

    Scenario: An empty name is refused
      Given the project "factory" exists
      When I rename it to ""
      Then it is refused

    Scenario: The branch work starts from can be re-pointed
      Given the project "factory" exists
      When I point it at the branch "develop"
      Then the project's branch is "develop"

    Scenario: Re-pointing the branch is announced
      Given the project "factory" exists
      When I point it at the branch "develop"
      Then a "project.changed" event says so

    Scenario: An empty branch is refused
      Given the project "factory" exists
      When I point it at the branch ""
      Then it is refused

    Scenario: Renaming a project that is not there is refused
      When I rename a project that does not exist
      Then it is refused


  Rule: a project says how much authority its runs get, and what else they may reach

    Two fields, two questions. The profile is inherited when unstated, because a
    project that has never been asked should follow the installation's choice —
    storing `default` for everyone would freeze every existing project against a
    setting they never saw.

    The granted directories are what "allow for this project" leaves behind, and
    they are directories rather than permission classes because a class is not
    something Factory can honour: it does not mediate the action, the agent's
    own CLI refuses it, so the only lever is what Factory passes next time.

    Scenario: A new project states no profile
      Given the project "factory" exists
      Then it states no profile
      And it has granted no directories

    Scenario: A profile can be stated and read back
      Given the project "factory" exists
      When I set its profile to "full-access"
      Then its profile is "full-access"

    Scenario: A profile can be cleared back to unstated
      Given the project "factory" exists
      And its profile is "full-access"
      When I clear its profile
      # Not the same as setting "default": unstated follows the installation,
      # and that is a position somebody may want to return to.
      Then it states no profile

    Scenario: Changing the profile is announced
      Given the project "factory" exists
      When I set its profile to "full-access"
      Then a "project.changed" event says so

    Scenario: Setting a profile on a project that is not there is refused
      When I set the profile of a project that does not exist
      Then it is refused

    Scenario: A granted directory is remembered
      Given the project "factory" exists
      When I grant it the directory "/repos/shared-library"
      Then its granted directories are "/repos/shared-library"

    Scenario: Granting the same directory twice changes nothing
      Given the project "factory" exists
      And it has been granted "/repos/shared-library"
      When I grant it the directory "/repos/shared-library"
      # Pressing the button twice is not an error.
      Then its granted directories are "/repos/shared-library"

    Scenario: Granted directories are kept in order
      Given the project "factory" exists
      And it has been granted "/repos/zoo"
      When I grant it the directory "/repos/aardvark"
      Then its granted directories are "/repos/aardvark, /repos/zoo"

    Scenario: A relative directory cannot be granted
      Given the project "factory" exists
      When I grant it the directory "../shared-library"
      # It would mean a different directory depending on which task was
      # running, which is the opposite of what a persistent grant is for.
      Then it is refused

    Scenario: A granted directory can be taken back
      Given the project "factory" exists
      And it has been granted "/repos/shared-library"
      When I revoke the directory "/repos/shared-library"
      Then it has granted no directories

    Scenario: A column edited by hand into nonsense reads as no grants
      Given the project "factory" exists
      And its granted directories column says "not json"
      # "None" is the safe direction for a list whose whole purpose is to widen
      # a boundary, and a project nobody can load is worse than a lost grant.
      Then it has granted no directories

    Scenario: A profile edited by hand into nonsense reads as unstated
      Given the project "factory" exists
      And its profile column says "sort-of-safe"
      Then it states no profile
