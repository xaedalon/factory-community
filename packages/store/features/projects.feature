Feature: Projects — the repositories Factory works in
  Everything before this ran wherever the daemon happened to be started, which
  is fine for one repository and wrong for two. A project says where a piece of
  work happens: a name, a path, the branch work starts from, and where its
  worktrees go.

  A task always belongs to a project. This used to say otherwise, on the grounds
  that `factory run` in a directory needs no project — which is true and beside
  the point: `factory run` creates no task at all. It plans against the scope
  chain of wherever it was invoked and runs in the foreground, touching neither
  repository. So nothing was ever kept on a task's behalf by allowing one to
  belong nowhere; what it bought instead was a task that runs in whatever
  directory the daemon happened to be started in, which the doctor's own setup
  rule calls "fine for a demonstration and wrong for work".

  A project is therefore removable only while nothing is left in it. Orphaning
  the record of work was the old answer and it produced tasks that could not be
  queued as a batch, could not be given a worktree, and wrote their artifacts
  beside the daemon.

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

  Scenario: A task cannot be created without one
    When I create a task "Add due dates" with no project
    Then it is refused
    And the error says a task needs a project

  Scenario: A project with nothing in it is removed
    Given the project "factory" exists
    When I remove the project
    Then the project is gone

  Scenario: Removing a project that still has tasks is refused
    Given the project "factory" exists
    And a task "Add due dates" in "factory"
    When I remove the project
    Then it is refused
    And the error says 1 task is still in it
    And the project is still there
    And the task still exists

  Scenario: An archived task counts, and the refusal says so
    Given the project "factory" exists
    And a task "Add due dates" in "factory"
    And a task "Ship it" in "factory" that has been archived
    When I remove the project
    Then it is refused
    And the error says 2 tasks are still in it
    And the error says 1 of them is archived

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

  Rule: a project can choose its own square, or let the name decide

    The rail draws a coloured square with two letters, and both were a pure
    function of the name — consistent everywhere, storing nothing, needing no
    decision from anybody. That is still what a new project gets.

    What a derivation cannot do is survive a rename: the hash changes, so the
    square somebody had learned changes colour under them. And six hues across
    a handful of projects collide often enough to matter. So a project may
    override either half, and unset means derived, exactly as before.

    Scenario: A new project has chosen neither
      When I add the project "factory" at that directory
      Then the project has no chosen colour
      And the project has no chosen letters

    Scenario: A colour can be chosen
      Given the project "factory" exists
      When I choose colour 3 for it
      Then the project's colour is 3

    Scenario: Letters can be chosen
      Given the project "factory" exists
      When I choose the letters "fx" for it
      Then the project's letters are "FX"

    Scenario: More than two letters is cut to two
      Given the project "factory" exists
      When I choose the letters "abcd" for it
      Then the project's letters are "AB"

    Scenario: Empty letters hand the square back to the name
      Given the project "factory" exists
      And the letters "FX" are chosen for it
      When I choose the letters "" for it
      Then the project has no chosen letters

    Scenario: A colour can be handed back to the name
      Given the project "factory" exists
      And colour 3 is chosen for it
      When I clear its colour
      Then the project has no chosen colour

    Scenario: A colour outside the palette is refused
      Given the project "factory" exists
      When I choose colour 9 for it
      Then it is refused

    Scenario: Choosing the square is announced
      Given the project "factory" exists
      When I choose colour 3 for it
      Then a "project.changed" event says so

    Scenario: A chosen square survives a rename
      Given the project "factory" exists
      And colour 3 is chosen for it
      When I rename it to "factory-core"
      Then the project's colour is 3

    Scenario: A colour edited into nonsense reads as unchosen
      Given the project "factory" exists
      And its colour column is edited by hand to 99
      Then the project has no chosen colour


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

    Scenario: A profile the store does not recognise is kept, not discarded
      # Changed when custom profiles arrived, and it is a change for the safer.
      # The store cannot know what is defined — that needs a scope chain it does
      # not have — so a name it does not recognise used to read as *unstated*,
      # which means inheriting the installation's profile. A project that had
      # asked for something particular would quietly run under something else.
      #
      # The name is kept now, and the guard moved to the two places that can
      # actually answer: the route refuses an unknown name before storing it,
      # and planning refuses to run a profile no scope defines. A row edited by
      # hand into nonsense therefore stops the work loudly instead of loosening
      # it silently.
      Given the project "factory" exists
      And its profile column says "sort-of-safe"
      Then its profile is "sort-of-safe"

    Scenario: A blank profile column still reads as unstated
      # Empty is absence, which is a real answer and the one every project
      # starts from.
      Given the project "factory" exists
      And its profile column says ""
      Then it states no profile

  Rule: the database refuses it too, not only the repository

    `ProjectRepository.remove` counts first so the refusal can name what is in
    the way, and `TaskRepository.create` refuses so the message says what is
    missing rather than quoting a constraint. Both are courtesies. The column
    and the foreign key are what make the rule true for everything that does
    not come through those two methods — a plugin, a migration written later, a
    hand-edited database — and a constraint nothing exercises is one that can be
    dropped in a rebuild without anybody noticing.

    Scenario: A task written straight into the database without a project is refused
      Given the project "factory" exists
      When a task with no project is written straight into the database
      Then the database refuses it

    Scenario: A project deleted straight out of the database is refused
      Given the project "factory" exists
      And a task "Add due dates" in "factory"
      When the project row is deleted straight out of the database
      Then the database refuses it
      And the task still exists

  Rule: a directory is asked which project it is in

    Every client so far has known a project's id or its name, because a person
    picked it from a list. An agent standing in a directory knows neither, and
    the question it can answer — "where am I?" — had nowhere to go: projects
    were looked up by id and by name, and nothing ever read the path column.

    Longest match wins, so a project nested inside another resolves to the
    inner one. Equal-length matches are refused by name rather than picked
    between, because a wrong project is a task queued against somebody else's
    repository.

    Both sides are canonicalised. A macOS temporary directory is a symlink, a
    home directory often is, and a comparison of the written strings answers
    "no project" for a directory that plainly is one.

    Scenario: A project's own directory is the project
      Given the project "factory" exists
      When I ask which project is at that directory
      Then the answer is "factory"
      And it matched the project's own directory

    Scenario: A directory inside a project is the project
      Given the project "factory" exists
      When I ask which project is at "packages/core/src" inside it
      Then the answer is "factory"
      And it matched an ancestor

    Scenario: A directory the project is inside is not the project
      Given the project "factory" exists
      When I ask which project is at the directory above it
      Then there is no project there

    Scenario: A sibling whose name starts the same way is not inside
      Given the project "factory" exists
      # "/repos/factory-pro" is not inside "/repos/factory", and a bare
      # prefix test says it is.
      When I ask which project is at the sibling "factory-pro"
      Then there is no project there

    Scenario: The innermost project wins
      Given the project "factory" exists
      And the project "web" exists at "apps/web" inside it
      When I ask which project is at "apps/web/src" inside "factory"
      Then the answer is "web"

    Scenario: Two projects at one directory are refused by name
      Given the project "factory" exists
      And the project "factory-again" exists at the same directory
      When I ask which project is at that directory
      Then it is refused
      And the refusal names "factory" and "factory-again"

    Scenario: A task's worktree is the project, and says which task
      Given the project "factory" exists
      And a task "Add due dates" in "factory" has a worktree
      When I ask which project is at that worktree
      Then the answer is "factory"
      And it matched a worktree
      And it names the directory "add-due-dates"

    Scenario: A relative path is refused
      Given the project "factory" exists
      # There is no current directory here to resolve it against, and guessing
      # one is how the prototype answered questions about the wrong machine.
      When I ask which project is at "../somewhere"
      Then it is refused

  Rule: a project carries the one command that checks its own work

    A supervised run's `validate` workflow passed ten times by asking an agent
    whether the work was good. An agent's report is a claim; only a command is
    a result. So a project carries the command, and the built-in
    `project-check` phase is nothing but it.

    Blank is stored as nothing rather than as an empty command. That is the
    whole reason the distinction is kept here: `bash -c ''` exits 0, so a
    project carrying "" would have made the gate a tick beside nothing.

    Scenario: A new project has no check command
      When I add the project "factory" at that directory
      Then the project has no check command

    Scenario: A check command can be given when the project is added
      When I add the project "factory" with the check command "pnpm test"
      Then the project's check command is "pnpm test"

    Scenario: A check command can be set later
      Given the project "factory" exists
      When I set its check command to "make check"
      Then the project's check command is "make check"

    Scenario: Whitespace around it is not part of the command
      Given the project "factory" exists
      When I set its check command to "  pnpm test  "
      Then the project's check command is "pnpm test"

    Scenario: A blank check command clears it
      Given the project "factory" exists
      And its check command is "pnpm test"
      When I set its check command to "   "
      Then the project has no check command

    Scenario: A check command edited to blank by hand reads as unset
      # The gate refuses to plan on a project with no command, and reads a
      # column of spaces the same way — otherwise editing the database by hand
      # would produce exactly the silent success the column exists to stop.
      Given the project "factory" exists
      And its check command column is edited by hand to "   "
      Then the project has no check command

    Scenario: Setting it is announced
      Given the project "factory" exists
      When I set its check command to "pnpm test"
      Then a "project.changed" event says so

    Scenario: It survives a rename
      Given the project "factory" exists
      And its check command is "pnpm test"
      When I rename it to "factory-core"
      Then the project's check command is "pnpm test"

  Rule: a project says which model judges its work, and whether one does at all

    The deterministic evaluator is free and always runs. An agent evaluator
    costs tokens on every run that produced something, and the model worth
    spending them on is not the same in a weekend project and in a payments
    service — so it is the project's choice, not the installation's and not a
    constant in the source.

    Absent means "nobody has said", which is not the same as "off". A project
    that has never chosen has no agent evaluator; a project that has switched
    judging off has none either, and the difference matters because only one of
    them starts working the moment a model is named.

    Scenario: A new project has no judging model
      When I add the project "factory" at that directory
      Then the project names no judging model

    Scenario: A judging model can be chosen
      Given the project "factory" exists
      When I set its judging model to "claude-opus-5-5"
      Then the project's judging model is "claude-opus-5-5"

    Scenario: Whitespace around it is not part of the model
      Given the project "factory" exists
      When I set its judging model to "  claude-opus-5-5  "
      Then the project's judging model is "claude-opus-5-5"

    Scenario: A blank model clears it
      Given the project "factory" exists
      And its judging model is "claude-opus-5-5"
      When I set its judging model to "   "
      Then the project names no judging model

    Scenario: A model edited to blank by hand reads as unset
      Given the project "factory" exists
      And its judging model column is edited by hand to "   "
      Then the project names no judging model

    Scenario: Judging is on until somebody turns it off
      When I add the project "factory" at that directory
      Then the project is judged

    Scenario: Judging can be turned off
      Given the project "factory" exists
      When I stop its work being judged
      Then the project is not judged

    Scenario: Turning judging off keeps the model that was chosen
      # So switching it back on does not silently cost nothing: the choice is
      # still there, and turning it on is one click rather than two decisions.
      Given the project "factory" exists
      And its judging model is "claude-opus-5-5"
      When I stop its work being judged
      Then the project's judging model is "claude-opus-5-5"

    Scenario: Choosing a model is announced
      Given the project "factory" exists
      When I set its judging model to "claude-opus-5-5"
      Then a "project.changed" event says so

    Scenario: The choice survives a rename
      Given the project "factory" exists
      And its judging model is "claude-opus-5-5"
      When I rename it to "factory-core"
      Then the project's judging model is "claude-opus-5-5"
