Feature: A scope Factory creates leaves the repository alone
  A repository is the user's. Most repositories that exist are not using
  Factory, and somebody trying it on their own machine should not have to
  explain a directory of untracked files to their team — so registering a
  project, or running `factory init`, writes nothing git can see.

  The mechanism is one file. `.xaedalon/.gitignore` contains `*`, which hides
  the whole family directory and the file itself, so `git status` after adding
  a project is exactly what it was before. Sharing the definitions is then a
  decision somebody makes, and it costs one edit — which is why the file spends
  most of its length explaining how to make it.

  This is the opposite of the recipe written everywhere else, which is `*`
  followed by `!.gitignore` to keep the ignore file in version control. Here the
  point is that git sees nothing at all.

  Nothing is written over a directory Factory did not create. A scope that is
  already there may already be committed and shared, and an ignore file dropped
  beside it would hide that team's next workflow while leaving the ones already
  committed in plain sight.

  Scenario: A new project scope hides itself from git
    Given a repository with no Factory directory
    When a project scope is created in it
    Then the scope has an ignore file
    And it ignores everything in the directory
    And it ignores itself

  Scenario: The file says how to share the directory
    Given a repository with no Factory directory
    When a project scope is created in it
    Then the ignore file names the three directories a run writes into
    And it says that deleting it does the same thing

  Scenario: The config file points at the ignore file rather than repeating it
    Given a repository with no Factory directory
    When a project scope is created in it
    Then the config says the directory is hidden from git
    And the config does not tell anybody to commit it

  Scenario: A user scope gets no ignore file
    When a user scope is created
    # A home directory is not a repository, and where it is one it is
    # somebody's dotfiles — not a thing for Factory to have an opinion about.
    Then there is no ignore file

  Scenario: A directory that is already a scope is left alone
    Given a repository whose Factory scope is already there
    When a project scope is created in it
    Then nothing was created
    And there is no ignore file

  Scenario: An ignore file somebody has already written is never replaced
    Given a repository with no Factory directory
    And an ignore file somebody wrote by hand
    When a project scope is created in it
    Then the ignore file still says what they wrote
