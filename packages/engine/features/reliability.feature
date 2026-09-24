Feature: Judging a task after something happened to it

  The order is the whole of the architecture: observations from what Factory
  saw, evaluators proposing, `normalize` refusing, the score engine deciding,
  the history appending. An evaluator never touches the number and never touches
  the database.

  Every run that reaches a verdict is judged — completed, failed, refused or
  timed out — because any workflow can change the project, including one
  somebody wrote this morning and told Factory nothing about. A workflow that
  declares what it contributes refines the judgement; not declaring never means
  invisible.

  Rule: a judgement that cannot be made does not fail the work it was judging

    Turning "the evaluator crashed" into "your work failed" is how a feature
    gets switched off.

    Scenario: An assessor that throws leaves the run completed
      Given a workflow that succeeds
      And an assessor that throws
      When the engine works on the task
      Then the run completed
      And the task is done
      And a warning says reliability could not be recalculated

    Scenario: An evaluator that throws still produces an assessment
      # One evaluator failing must not take the others with it. The
      # deterministic one alone is a judgement worth having.
      Given a task with a failing evaluator and the deterministic one
      When the task is assessed
      Then an assessment was recorded
      And a warning names the evaluator that failed

  Rule: every verdict is judged, whatever the workflow said

    Scenario: A workflow that declares nothing is still judged
      Given a workflow that succeeds
      When the engine works on the task
      Then the task has been assessed

    Scenario: A run that failed is judged too
      # A failure is evidence. Skipping it would mean the score only ever moved
      # on good news.
      Given a workflow that fails
      When the engine works on the task
      Then the task has been assessed

    Scenario: The assessment names the run it judged
      Given a workflow that succeeds
      When the engine works on the task
      Then the assessment names the run

  Rule: what the run did reaches the judgement

    Scenario: A failed step becomes a finding
      Given a workflow that fails
      When the engine works on the task
      Then the task has at least one driver

    Scenario: A clean run leaves no findings
      Given a workflow that succeeds
      When the engine works on the task
      Then the task has no drivers

  Rule: the score moves, and says why

    Scenario: A second assessment carries a delta
      Given a task assessed once
      When the task is assessed again with a regression found
      Then the newest assessment has a delta
      And its causes name the regression

    Scenario: A finding lowers the score
      Given a task assessed once
      When the task is assessed again with a regression found
      Then the score is lower than it was

    Scenario: History keeps both
      Given a task assessed once
      When the task is assessed again with a regression found
      Then the history holds 2 assessments

  Rule: an assessment knows when it has fallen behind

    Staleness is derived, not stored: an assessment records the newest run it
    took into account, so a run that finished after it means the judgement is
    behind the work. Nothing has to be written down, and nothing can be written
    down wrongly.

    Scenario: A fresh assessment is not stale
      Given an assessment that considered the newest run
      Then it is not stale

    Scenario: A run since the assessment makes it stale
      Given an assessment that considered an earlier run
      Then it is stale
      And it says how many runs have finished since

    Scenario: An assessment that considered no run is never stale
      # A manual assessment, or one triggered by a driver being resolved. There
      # is no run for it to be behind.
      Given an assessment that considered no run
      Then it is not stale
