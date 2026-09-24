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

  Rule: what a workflow declares reaches the judgement it refines

    The block is YAML, so it is written the way YAML is written —
    `expected_evidence`, not `expectedEvidence`. The engine is the one place
    that crosses from one spelling to the other, and it was handing the plan's
    object straight through: every field whose name differs arrived undefined,
    which meant a declared workflow earned exactly the coverage an undeclared
    one does. Both shapes are all-optional, so nothing said so.

    Scenario: A workflow that declares its evidence earns coverage for it
      # Two keys, because the first is credited against an artifact actually
      # arriving and this plan is one shell step. What is being read here is the
      # declaration reaching the judgement at all — with the spellings crossed,
      # neither key was credited and a declared workflow scored 0% coverage.
      Given a workflow that succeeds declaring it collects "technical_approach" and "compatibility_considered"
      When the engine works on the task
      Then the coverage is above zero

    Scenario: A workflow that declares nothing earns no coverage
      Given a workflow that succeeds
      When the engine works on the task
      Then the coverage is zero

    Scenario: A workflow that says not to judge it is not judged
      # For the handful that change nothing worth judging — a worktree being
      # created, an environment torn down.
      Given a workflow that succeeds and asks not to be judged
      When the engine works on the task
      Then the task has not been assessed

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

    Scenario: The assessment records the dimensions the score came from
      # Reported from a real task: the card read "implementation 60" beside a
      # score of 66.4, which was computed from 48 — the driver's cost had moved
      # the dimension, and what was written down was the value from before it
      # moved. The breakdown could not add up to the number above it.
      Given a task assessed once
      When the task is assessed again with a regression found
      Then the recorded dimensions carry the finding's cost
      And the breakdown adds up to the raw score

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
