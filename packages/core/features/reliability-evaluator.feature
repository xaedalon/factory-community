Feature: Where judgement enters, and how far it is allowed

  An agent asked how good its own work is answers 98, every time. A system that
  stores that answer has built a flattery machine with a database behind it.

  So an evaluator classifies evidence and proposes findings, and there is no
  field it could return a score in. Everything that comes back goes through
  `normalize` before anything else sees it, and nothing downstream trusts an
  evaluator twice. The scenarios below are mostly about what `normalize`
  refuses, because that is the boundary and a boundary nobody tests is a
  boundary that is not there.

  Rule: an evaluator cannot set the score by another name

    Scenario: A finding cannot move the score further than the policy allows
      # -80 on one finding is setting the score. The bound is the difference
      # between "this evaluator thinks this is very bad" and "this evaluator
      # decides".
      When an evaluator proposes a finding costing 80
      Then the finding survives
      And its impact is bounded by the policy
      And a note says the impact was bounded

    Scenario: A positive impact is bounded too
      When an evaluator proposes a finding worth 80
      Then its impact is bounded by the policy

    Scenario: A dimension score above one hundred is brought into range
      When an evaluator scores "design" at 150
      Then "design" is 100
      And a note says the score was brought into range

    Scenario: A dimension score below zero is brought into range
      When an evaluator scores "design" at -20
      Then "design" is 0

  Rule: what is not in the vocabulary does not enter it

    Scenario: A dimension Factory does not have is dropped
      When an evaluator scores "vibes" at 99
      Then no dimension called "vibes" survives
      And a note says it is not a dimension

    Scenario: A severity Factory does not have loses the finding
      # Severity decides whether a cap applies and whether a person must accept
      # it. A finding whose severity cannot be read cannot be placed.
      When an evaluator proposes a finding of "catastrophic" severity
      Then no finding survives
      And a note says the severity is not one

    Scenario: An owner Factory does not have loses the finding
      # The owner is the routing. A finding nobody can be sent at is not
      # actionable, which is the only thing a driver is for.
      When an evaluator proposes a finding owned by "the universe"
      Then no finding survives
      And a note says the owner is not one

    Scenario: A finding with no title is dropped
      When an evaluator proposes a finding with no title
      Then no finding survives

    Scenario: A dimension Factory does not have is corrected, not dropped
      # Unlike severity and owner, this one is recoverable: the finding is
      # still worth having and "understanding" is the honest home for it.
      When an evaluator proposes a finding about "vibes"
      Then the finding survives
      And it is filed under "understanding"
      And a note says where it was filed

  Rule: a recommendation has to be one somebody can take

    Scenario: A workflow the project has is kept
      Given the project has a "checkout-regression" workflow
      When an evaluator recommends running "checkout-regression"
      Then the recommendation survives

    Scenario: A workflow the project does not have is dropped
      # The board would draw a Run button with nothing behind it.
      Given the project has no workflows
      When an evaluator recommends running "checkout-regression"
      Then the finding survives
      And it carries no recommendation
      And a note says the workflow is not there

  Rule: an evaluator may only resolve something that exists

    Scenario: Resolving a real driver is allowed
      Given the task has a driver
      When an evaluator resolves that driver
      Then the resolution survives

    Scenario: Resolving an invented driver is refused
      # Silently resolving nothing reads afterwards as "it was dealt with".
      Given the task has a driver
      When an evaluator resolves "driver-that-never-was"
      Then no resolution survives
      And a note says there is no such driver

  Rule: dimensions follow the evidence rather than an opinion

    Scenario: No evidence sits at the baseline
      Given nothing has been observed
      When dimensions are read from the evidence
      Then every dimension is the policy baseline

    Scenario: Evidence raises the dimension it belongs to
      Given everything expected of "design" has been observed
      When dimensions are read from the evidence
      Then "design" is above the baseline
      And "verification" is still the baseline

    Scenario: Collected evidence alone does not reach one hundred
      # Evidence having been collected is not the same as somebody having
      # judged it. The last few points are what an agent evaluator is for.
      Given everything expected has been observed
      When dimensions are read from the evidence
      Then no dimension reaches 100

    Scenario: A failure on its own does not lower the dimension
      # A failure that matters becomes a driver, and the driver's impact is
      # what moves the dimension. Counting it in both places would charge
      # twice for one problem — and resolving the driver would then give back
      # only half of what it took.
      Given everything expected of "design" has been observed
      And a failure was seen in "design"
      When dimensions are read from the evidence
      Then "design" is what the evidence alone supports

  Rule: what Factory saw becomes findings without interpretation

    Scenario: A refused command becomes a finding a person owns
      # The remedy is the provider's allow-list or the project's profile, and
      # neither is the agent's to change.
      Given a run where a command was refused
      When the deterministic evaluator judges it
      Then it proposes a finding
      And the finding is owned by the developer
      And the finding names the command

    Scenario: A failed check becomes a finding an agent owns
      # A red check is something Factory can be sent at.
      Given a run where the project's checks failed
      When the deterministic evaluator judges it
      Then it proposes a finding
      And the finding is owned by the agent

    Scenario: A promised document that never arrived becomes a finding
      Given a run that promised a document and did not write it
      When the deterministic evaluator judges it
      Then it proposes a finding

    Scenario: The same refusal eleven times is one finding
      Given a run where the same command was refused eleven times
      When the deterministic evaluator judges it
      Then it proposes 1 finding

    Scenario: A finding the task already has is not proposed again
      Given a run where a command was refused
      And the task already has that finding
      When the deterministic evaluator judges it
      Then it proposes no findings

    Scenario: A clean run proposes nothing
      Given a run where everything succeeded
      When the deterministic evaluator judges it
      Then it proposes no findings

    Scenario: It never returns a score
      Given a run where everything succeeded
      When the deterministic evaluator judges it
      Then what it returns has no score in it
