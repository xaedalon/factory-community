Feature: Which agent reads the work

  A project names the agent that judges it — which CLI, which model, how hard to
  think. Absent means "nobody has said", and what fills that silence is the
  installation's choice; absent there too means Factory uses whatever is
  installed, which is what it always did.

  One function decides this, for the same reason `resolveProfile` exists: two
  callers deciding it independently is two rules, and the one nobody reads is
  the one in force.

  Rule: a project's choice beats the installation's, field by field

    Field by field and never as a trio. Every project that named a model before
    a provider could be named has no provider — so its model must inherit
    nothing while its provider inherits the installation's. Taking the three
    together would have silently stopped judging exactly those projects the day
    this shipped, which is the kind of migration nobody notices until a score
    stops moving.

    Scenario: A project's provider wins
      Given the installation judges with "claude"
      And the project judges with "codex"
      Then the judge's provider is "codex"

    Scenario: A project that names nothing follows the installation
      Given the installation judges with "claude"
      And the project names no judge
      Then the judge's provider is "claude"

    Scenario: A project that named only a model keeps it and inherits the rest
      Given the installation judges with "claude" using "balanced" at "low"
      And the project judges with the model "opus" and nothing else
      Then the judge's provider is "claude"
      And the judge's model is "opus"
      And the judge's effort is "low"

    Scenario: With nothing named anywhere the judge is nothing at all
      Given neither the project nor the installation names a judge
      Then the judge names no provider
      And the judge names no model
      And the judge names no effort
