Feature: Keeping a task's judgement, and never rewriting it

  Three tables and no fourth for "the current state". The current score is the
  newest assessment plus the drivers that are still active — two indexed
  queries — and a stored copy of that would be a second source of truth for
  something the history already says. `progress` on a task is derived for the
  same reason, and the two would disagree the first time an assessment was
  replayed.

  History is append-only. There is no way to edit an assessment and there is not
  going to be one: a judgement is never changed because interpretation changed,
  and a correction is a later assessment that supersedes. A history that can be
  rewritten is not evidence of anything.

  Background:
    Given an empty store with a project and a task

  Rule: a task that has never been judged says so rather than scoring zero

    Scenario: A new task has no assessment
      Then the task has no newest assessment
      And the task has no history

    Scenario: A new task has no drivers
      Then the task has no drivers

  Rule: assessments accumulate, in an order that cannot tie

    Scenario: The first assessment is sequence one
      When an assessment scoring 93 is recorded
      Then the newest assessment scores 93
      And its sequence is 1

    Scenario: The next assessment is sequence two
      Given an assessment scoring 93 was recorded
      When an assessment scoring 95 is recorded
      Then the newest assessment scores 95
      And its sequence is 2
      And the history holds 2 assessments

    Scenario: History is oldest first, which is the order a graph wants
      Given an assessment scoring 93 was recorded
      And an assessment scoring 95 was recorded
      Then the history reads 93 then 95

    Scenario: Two assessments written in the same instant still order
      # A timestamp can tie. A sequence cannot, and the sequence is taken
      # inside the transaction that inserts.
      Given the clock does not move
      When an assessment scoring 93 is recorded
      And an assessment scoring 95 is recorded
      Then their sequences are 1 and 2

    Scenario: Recording an assessment is announced
      When an assessment scoring 93 is recorded
      Then a "reliability.assessed" event says so
      And the event carries the delta

  Rule: the whole arithmetic survives, because the logs will not

    A score has to stay explainable after the run logs have been trimmed, which
    they are, on a budget.

    Scenario: The dimensions come back as they went in
      When an assessment with a dimension breakdown is recorded
      Then every dimension comes back with its score

    Scenario: The caps and their reasons come back
      When an assessment capped at 70 is recorded
      Then the cap comes back with its reason

    Scenario: The working comes back
      When an assessment with a full explanation is recorded
      Then the contributions come back
      And the causes come back

    Scenario: What it saw comes back
      When an assessment that observed a failed gate is recorded
      Then the observation comes back
      And it still names what failed

  Rule: a row edited by hand does not take the task with it

    A score that reads zero is a bug worth seeing. A board that will not open is
    a bug that hides every other one.

    Scenario: Unparseable dimensions read as zeroes, not as a throw
      Given an assessment scoring 93 was recorded
      And its dimensions column is edited by hand to nonsense
      Then the assessment still loads
      And every dimension reads 0

    Scenario: An unparseable explanation reads as empty
      Given an assessment scoring 93 was recorded
      And its explanation column is edited by hand to nonsense
      Then the assessment still loads
      And it has no contributions

    Scenario: An unparseable list of caps reads as no caps
      # A different parser from the one the dimensions go through, and it has
      # to degrade the same way. This scenario exists because a mutation that
      # made it throw survived without it.
      Given an assessment capped at 70 was recorded
      And its caps column is edited by hand to nonsense
      Then the assessment still loads
      And it has no caps

    Scenario: A dimension the column omits still comes back
      # A missing key is indistinguishable from zero downstream, so it is
      # filled in rather than left out.
      Given an assessment scoring 93 was recorded
      And its dimensions column holds only "design"
      Then every dimension the model lists is present

  Rule: what a board draws is one read, not one per task

    The card on a task page assembles three queries — the newest assessment, the
    drivers, the runs — and that is right for one task. A board of forty rows
    asking the same three would be a hundred and twenty statements for one
    answer, and the task list already reads its dependency graph once for the
    whole page rather than once per row.

    So a list reads a projection: the newest score and coverage of every task
    that has one, in a single statement, parsing none of the JSON columns a row
    never draws. A task nobody has judged is **absent** from the answer rather
    than present with a zero — `unassessed` is a state, and a missing key is the
    honest shape for it.

    Scenario: Every task's newest score comes back in one answer
      Given a second task in the same project
      And the first task was judged at 88 with 70% coverage
      And the second task was judged at 61 with 40% coverage
      Then the board read says the first task is 88 with 70% coverage
      And the board read says the second task is 61 with 40% coverage

    Scenario: The newest of several judgements is the one that comes back
      Given the task was judged at 40 with 10% coverage
      And the task was judged at 91 with 95% coverage
      Then the board read says the task is 91 with 95% coverage

    Scenario: A task nobody has judged is absent rather than scoring zero
      Given a second task in the same project
      And the first task was judged at 88 with 70% coverage
      Then the board read does not mention the second task

  Rule: drivers are found, moved, and never quietly dropped

    Scenario: A driver is stored with everything it was given
      When a "high" driver owned by the agent is added
      Then the task has 1 driver
      And it is "open"
      And it carries its owner and severity
      And a "reliability.driver.created" event says so

    Scenario: Resolving a driver records when
      Given a "high" driver owned by the agent was added
      When it is resolved
      Then it is "resolved"
      And it records when it was resolved
      And a "reliability.driver.changed" event says so

    Scenario: Accepting a driver records who and why
      Given a "high" driver owned by the agent was added
      When it is accepted by "alex" because "the browser is out of support"
      Then it is "accepted"
      And it records who accepted it
      And it records why

    Scenario: A resolved driver is no longer active
      Given a "high" driver owned by the agent was added
      When it is resolved
      Then the task has no active drivers
      And the task still has 1 driver in all

    Scenario: An accepted risk stays in the record
      # Acceptance stops it holding the number down. It does not erase it.
      Given a "high" driver owned by the agent was added
      When it is accepted by "alex" because "the browser is out of support"
      Then the task still has 1 driver in all

  Rule: deleting a task takes its judgement with it

    Scenario: Nothing is left behind
      Given an assessment scoring 93 was recorded
      And a "high" driver owned by the agent was added
      When the task is deleted
      Then no assessments remain
      And no drivers remain
      And no observations remain
