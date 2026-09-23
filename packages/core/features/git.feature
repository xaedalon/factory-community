Feature: Asking git a question, and the answers that are not answers
  One rule needs to know what git ignores, and only git can say: matching
  `.gitignore` files here would be a second implementation of a specification
  we do not own, and the answer has to include every file between the project
  and the repository root as well as the user's own `core.excludesFile`.

  So this spawns git — the only thing in Factory that does, outside the runner
  that spawns a task's steps. What matters is the other half: every way of not
  getting an answer has to look the same to a caller, because a diagnosis
  drawn from a failed question is worse than no diagnosis. Git missing, git
  timing out, and git's own fatal status — which covers "not a git repository",
  a bad pathspec and a corrupt index — all come back as nothing at all.

  Scenario: A question with an answer
    Given a repository with a committed file
    When git is asked which files it tracks
    Then the answer is yes
    And it names the committed file

  Scenario: A question whose answer is no
    Given a repository with a committed file
    When git is asked whether that file is ignored
    # Exit 1 is git saying "no", which is an answer and must not be confused
    # with not being able to ask.
    Then the answer is no

  Scenario: A directory that is not a repository
    Given a directory that is not a repository
    When git is asked which files it tracks
    # Status 128. The rule that asks this walks registered projects, one of
    # which may be a plain directory, and a fatal is not a finding.
    Then there is no answer

  Scenario: No git on this machine
    Given a machine with no git
    When git is asked which files it tracks
    Then there is no answer

  Scenario: The environment a question is asked in
    Given a repository with a committed file
    And the environment points git at another repository
    When git is asked which files it tracks
    # GIT_DIR and its relatives are inherited by a daemon started from a hook,
    # and they would answer the question about somebody else's repository.
    Then it answers about the repository it was pointed at by the caller
