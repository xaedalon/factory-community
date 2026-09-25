Feature: The agent that judges what the deterministic evaluator cannot see

  Factory can see that a command was refused, that a gate went red and that a
  document it was promised never arrived. It cannot see that the requirements
  were ambiguous, that the approach fights the architecture it landed in, or
  that the tests assert the bug. That is what this evaluator is for.

  It is the same capability kind as the deterministic one, deliberately, so it
  is an addition rather than a replacement — and it goes through the same
  `normalize` boundary, so being an agent buys it no extra authority. It cannot
  return a score. There is no field for one, and this feature asserts there is
  no way to smuggle one in either.

  It costs money on every run it agrees to, which is why most of what follows is
  about when it declines.

  Rule: it declines rather than costing anything it cannot spend well

    Scenario: With nothing to ask, it does not run
      Given a run that failed a gate
      But no agent to ask
      Then the evaluator does not want to run

    Scenario: With nothing new, it does not run
      Given an agent to ask
      But a run that produced nothing
      Then the evaluator does not want to run

    Scenario: A run that only noted things does not earn a judgement
      # A step that recorded an approval and nothing else has not changed the
      # project. Paying an agent to look at it would be paying for a re-read.
      Given an agent to ask
      And a run whose only observation is an approval
      Then the evaluator does not want to run

    Scenario: New work is worth looking at
      Given an agent to ask
      And a run that wrote an artifact
      Then the evaluator wants to run

    Scenario: A run that went badly is worth looking at
      Given an agent to ask
      And a run that failed a gate
      Then the evaluator wants to run

    Scenario: A refused command is worth looking at
      Given an agent to ask
      And a run whose command was refused
      Then the evaluator wants to run

  Rule: what it is asked is the evidence, and the shape of an answer

    The prompt is built from observations Factory recorded, never from the
    agent's own account of its work. Asking an agent to summarise itself and
    then judging the summary is a machine for laundering a claim into a fact.

    Scenario: The prompt carries what Factory saw
      Given an agent to ask
      And a run that failed a gate
      When it is evaluated
      Then the prompt names the failed gate
      And the prompt names the task

    Scenario: The prompt says which dimensions exist
      Given an agent to ask
      And a run that wrote an artifact
      When it is evaluated
      Then the prompt lists every dimension

    Scenario: The prompt offers the findings that already exist
      Given an agent to ask
      And a run that failed a gate
      And a finding already on the task
      When it is evaluated
      Then the prompt names that finding

    Scenario: The prompt never asks for a score
      # The one line of this whole feature that would be worth writing if only
      # one could be.
      Given an agent to ask
      And a run that wrote an artifact
      When it is evaluated
      Then the prompt does not ask for a score

    Scenario: The model the project chose is the model that is asked
      Given an agent to ask using "claude-opus-5-5"
      And a run that wrote an artifact
      When it is evaluated
      Then it was asked through "claude-opus-5-5"

  Rule: an answer is read forgivingly and trusted narrowly

    Every CLI wraps JSON differently and some of them apologise first. Reading
    only a bare object would make this fail on the common case; reading anything
    at all would make it fail silently on the dangerous one.

    Scenario: A bare object is read
      Given an agent that answers with a bare object
      When it is evaluated
      Then the design dimension is 72

    Scenario: A fenced block is read
      Given an agent that answers inside a code fence
      When it is evaluated
      Then the design dimension is 72

    Scenario: An object with prose around it is read
      Given an agent that answers with prose around the object
      When it is evaluated
      Then the design dimension is 72

    Scenario: An answer that is not JSON at all is refused
      Given an agent that answers with an apology
      When it is evaluated
      Then evaluating fails saying it could not be read

    Scenario: An answer that is JSON but not an object is refused
      Given an agent that answers with a list
      When it is evaluated
      Then evaluating fails saying it could not be read

    Scenario: An agent that cannot be reached fails loudly
      # Loud here, silent downstream: `assessReliability` turns a failed
      # evaluator into a warning on the run. What must not happen is this
      # returning an empty judgement that reads as "nothing was wrong".
      Given an agent that cannot be reached
      When it is evaluated
      Then evaluating fails saying it could not be reached

  Rule: a score cannot be smuggled through it

    Scenario: A score in the answer is dropped
      Given an agent that answers with a score of 98
      When it is evaluated
      Then what comes back carries no score

    Scenario: Findings come through, with their own dimensions
      Given an agent that answers with a finding
      When it is evaluated
      Then the finding comes through
      And it is filed under the dimension the agent named

    Scenario: Resolutions come through
      Given an agent that answers resolving a finding
      When it is evaluated
      Then it says that finding is resolved

    Scenario: A dimension the agent invented is dropped before it is returned
      # `normalize` would drop it as well, and that is the point: this is the
      # first of two, not the only one.
      Given an agent that answers with a dimension Factory does not have
      When it is evaluated
      Then only dimensions Factory has come back
