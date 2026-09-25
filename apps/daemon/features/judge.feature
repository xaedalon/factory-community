Feature: The agent that reads the work

  A project names the agent that judges it — which CLI, which model, how hard to
  think — and the installation carries the default a project inherits. Choosing
  which of those wins is `resolveJudge`'s job and has its own specification. What
  is here is the half that has consequences: whether a judge is produced at all,
  and what is said when one cannot be.

  Nothing here refuses a run. The workflow succeeded; only the reading of it did
  not happen. But an absence nobody is told about is a flag that reads correctly
  and does nothing, so the absences that follow from somebody's own choice are
  reported.

  Rule: a judge that cannot be asked says so, and is not replaced

    Scenario: A project's own provider is the one asked
      Given "claude" and "codex" are both installed
      And the project judges with "codex" using "strong"
      Then the judge is "codex"

    Scenario: A named provider whose command is missing yields no judge
      Given "claude" is installed and "codex" is not
      And the project judges with "codex" using "strong"
      Then there is no judge

    Scenario: And it says which provider, and why
      Given "claude" is installed and "codex" is not
      And the project judges with "codex" using "strong"
      Then it warns that "codex" could not be found
      And the warning is a "reliability.judgeUnavailable"

    Scenario: The installed one is not quietly used instead
      # Honouring two thirds of the trio means asking Claude for a Codex model
      # id and billing somebody for a pairing they never chose.
      Given "claude" is installed and "codex" is not
      And the project judges with "codex" using "strong"
      Then the judge is not "claude"

    Scenario: A provider nobody registered reads differently
      Given "claude" is installed and "codex" is not
      And the project judges with "nonesuch" using "strong"
      Then it warns that no such provider is registered

    Scenario: Naming nothing at all is silent
      # Nobody stated anything, so nothing was disappointed. This is what
      # Factory always did.
      Given "claude" and "codex" are both installed
      And the project names no provider but judges using "strong"
      Then the judge is "claude"
      And nothing is warned about

    Scenario: Judging switched off asks nothing and says nothing
      Given "claude" and "codex" are both installed
      And the project has judging switched off
      Then there is no judge
      And nothing is warned about

    Scenario: An effort the provider ignores still asks, and says it was ignored
      # Effort is an optimisation, not an identity: `render` drops it, and an
      # agent step with the same mismatch behaves identically — same function,
      # same words.
      Given "claude" and "codex" are both installed
      And the project judges with "codex" using "strong" at "high"
      Then there is a judge
      And it warns that the effort is ignored
