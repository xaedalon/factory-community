Feature: Turning evidence into a number that can be explained

  Factory can say a task is done. It cannot say how much to trust that, and the
  material for the answer is already produced and then thrown away — exit codes,
  refused commands, artifacts promised and not delivered.

  The rule the whole subsystem turns on is that **no agent ever sets the score**.
  An evaluator proposes dimension assessments and drivers; the arithmetic here
  turns those into a number, the same way every time. Self-scoring is how a
  number becomes flattery.

  Every scenario below is arithmetic over values somebody else looked up. That
  is deliberate: the interesting cases are a critical risk capping a near
  perfect average, and a validation that lowers the score while raising
  coverage, and neither is a thing to reproduce from real runs to find out what
  happens.

  Rule: the policy has to add up before anything uses it

    A weights table that does not total 100 makes every score wrong by a
    constant nobody notices. It is checked rather than assumed, and the check is
    exported so the loader and this scenario cannot drift.

    Scenario: The shipped weights total one hundred
      Given the policy Factory ships
      Then the dimension weights total 100

    Scenario: Every dimension has a weight
      Given the policy Factory ships
      Then every dimension the model lists has a weight

    Scenario: Every expected piece of evidence is worth something
      # A zero-weight expectation can never be missing in a way that matters,
      # which makes it decoration in a number people are asked to trust.
      Given the policy Factory ships
      Then every expected piece of evidence has a weight above zero

  Rule: the score is a weighted average, and it shows its working

    Scenario: A perfect assessment scores one hundred
      Given every dimension scores 100
      When the score is calculated
      Then the raw score is 100

    Scenario: The weights actually weight
      # Design is worth 20 and precedent 10, so the same loss costs twice as
      # much in one as the other. A scenario that could not tell them apart
      # would pass against a plain mean.
      Given every dimension scores 100 except "design" which scores 50
      When the score is calculated
      And the same assessment is calculated with "precedent" at 50 instead
      Then the design shortfall costs twice what the precedent shortfall costs

    Scenario: The working is carried, not recoverable
      Given every dimension scores 90
      When the score is calculated
      Then there is one contribution line per dimension
      And each line carries the dimension's score and its weight
      And the contributions sum to the raw score

    Scenario: A dimension score outside the range is brought back into it
      # An evaluator that returns 150 has tried to set the score. It gets 100.
      Given every dimension scores 100 except "design" which scores 150
      When the score is calculated
      Then the raw score is 100

  Rule: a known serious risk caps the score, however good the average is

    A weighted average cannot express "there is an unresolved critical finding".
    It can only dilute it, and dilution is how a 96 ships with a hole in it.

    Scenario: A critical open driver caps the score
      Given every dimension scores 96
      And a "critical" open driver
      When the score is calculated
      Then the raw score is 96
      And the effective score is 70
      And the assessment records why it was capped

    Scenario: A resolved critical driver caps nothing
      Given every dimension scores 96
      And a "critical" driver that has been resolved
      When the score is calculated
      Then the effective score is the raw score

    Scenario: An accepted critical driver caps nothing
      # Acceptance is a person deciding to live with it. The risk is still
      # recorded; it stops holding the number down.
      Given every dimension scores 96
      And a "critical" driver that has been accepted
      When the score is calculated
      Then the effective score is the raw score

    Scenario: Caps do not compound
      # Two ceilings of 80 and 70 mean 70, not 56. A score that fell further
      # than any stated reason explains is the unexplained movement this whole
      # subsystem exists to end.
      Given every dimension scores 96
      And a "critical" open driver
      And an open "regression" driver of "high" severity
      When the score is calculated
      Then the effective score is 70

    Scenario: A high-severity driver costs its impact rather than a ceiling
      # A cap that fired on every high finding would stop the number moving,
      # and a number that does not move stops being read.
      Given every dimension scores 96
      And an open "testing" driver of "high" severity
      When the score is calculated
      Then no cap was applied

    Scenario: Evidence nobody collected caps the score too
      # "Nobody verified this" needs a ceiling, not a driver somebody
      # remembered to write.
      Given every dimension scores 99
      And nothing has been observed at all
      When the score is calculated
      Then the effective score is at most 85
      And the assessment records why it was capped

  Rule: coverage is how much of the expected evidence exists, weighted

    Counting evidence objects would let an agent raise coverage by writing three
    documents about the same thing.

    Scenario: No evidence is no coverage
      Given nothing has been observed at all
      When the score is calculated
      Then the coverage is 0

    Scenario: Everything expected is full coverage
      Given every expected piece of evidence has been observed
      When the score is calculated
      Then the coverage is 100

    Scenario: Coverage counts weight, not observations
      # Ten observations of one cheap expectation must not outweigh one
      # observation of an expensive one.
      Given the cheapest expected evidence has been observed ten times
      When the score is calculated
      Then the coverage is below 20

    Scenario: A check that ran and failed does not satisfy the expectation
      # A failing test suite is evidence about the code. It is not evidence
      # that the code is tested.
      Given the project's own checks ran and failed
      When the score is calculated
      Then the coverage is 0
      And the missing evidence still names "regression_checks"

  Rule: more evidence can arrive with less reliability

    This is the pair the whole feature exists for. A validation that discovers a
    regression has learned something — coverage goes up — and what it learned is
    bad news, so the score goes down. A model that could not express both at
    once would have to hide one of them.

    Scenario: A failed validation lowers the score and raises coverage
      Given a task assessed at 97 with 68% coverage
      When validation runs, satisfies its expected evidence, and finds a regression
      Then the score is lower than it was
      And the coverage is higher than it was

  Rule: no score moves without a reason attached

    Scenario: A new driver is named as the cause
      Given a task assessed at 97 with 68% coverage
      When validation runs, satisfies its expected evidence, and finds a regression
      Then a cause names the regression that was found

    Scenario: Resolving a driver is named as the cause, and gives back its impact
      Given a task assessed at 97 with 68% coverage
      And validation found a regression
      When that regression is resolved
      Then a cause says the regression was resolved
      And that cause is positive

    Scenario: The first assessment has nothing to have moved from
      Given every dimension scores 90
      When the score is calculated
      Then no causes are given

  Rule: one hundred is rare

    Do not normalise a successful task toward 100. A completed task usually
    lands in the nineties, and the gap between 97 and 100 is where the evidence
    nobody collected lives.

    Scenario: Good work with an ordinary gap does not reach one hundred
      Given every dimension scores 97
      And every expected piece of evidence has been observed
      When the score is calculated
      Then the effective score is below 100

    Scenario: One hundred needs everything
      Given every dimension scores 100
      And every expected piece of evidence has been observed
      When the score is calculated
      Then the effective score is 100
      And no cap was applied
