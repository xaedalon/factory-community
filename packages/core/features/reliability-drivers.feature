Feature: What is still uncertain, and who should deal with it

  The score is the summary. The product is the drivers: the things that are
  still true, still costing trust, and still waiting for somebody. A driver has
  a name, a size and an owner, and the owner is what makes this feature answer
  the question worth asking —

    What can Factory keep working on without me?

  and its twin, which is the one that saves time:

    Where is my judgement actually required?

  Rule: a driver moves through one table and nowhere else

    A transition allowed in two places is a transition that disagrees with
    itself. `task/state.ts` learned this; so does this.

    Scenario: An open driver offers the moves that make sense
      Given an open driver
      Then it offers "investigate"
      And it offers "resolve"
      And it offers "accept"
      And it does not offer "reopen"

    Scenario: A resolved driver cannot be resolved again
      Given a resolved driver
      When "resolve" is attempted
      Then it is refused
      And the refusal lists what it would accept instead

    Scenario: A resolution that did not hold can be reopened
      Given a resolved driver
      When "reopen" is attempted
      Then it becomes "open"

    Scenario: An accepted risk is not reopened, it is superseded
      # Reopening somebody's accepted risk means overriding their decision.
      # That is a new finding, not a state change on the old one.
      Given an accepted driver
      Then it does not offer "reopen"
      And it offers "supersede"

  Rule: an agent cannot accept its own serious risk

    An acceptance an agent can grant itself is not a gate. This is the same hole
    as an agent approving its own work, and it is closed the same way — by the
    daemon, on the facts Factory stamped into the agent's environment, not by
    asking the client to behave.

    Scenario: An agent may not accept a critical risk
      Given an open driver of "critical" severity
      When an agent attempts to accept it
      Then it is refused because a person is required
      And the refusal does not offer "accept"

    Scenario: An agent may not accept a high risk either
      Given an open driver of "high" severity
      When an agent attempts to accept it
      Then it is refused because a person is required

    Scenario: An agent may accept a low risk
      # Accepting a low finding is housekeeping. Requiring a person for every
      # one of them is how a gate becomes noise and stops being read.
      Given an open driver of "low" severity
      When an agent attempts to accept it
      Then it becomes "accepted"

    Scenario: A person may accept a critical risk
      Given an open driver of "critical" severity
      When a person accepts it
      Then it becomes "accepted"

    Scenario: An agent may still resolve a critical risk
      # Resolving means the thing is no longer true, which is a claim evidence
      # can check. Accepting means it is still true and somebody chose to live
      # with it, which only a person can decide.
      Given an open driver of "critical" severity
      When an agent attempts to resolve it
      Then it becomes "resolved"

  Rule: the worst thing is read first

    Scenario: Severity orders before impact
      Given a "critical" driver costing 1 and a "low" driver costing 9
      When the drivers are ordered
      Then the "critical" one is first

    Scenario: Within a severity, the expensive one is first
      Given two "medium" drivers costing 2 and 7
      When the drivers are ordered
      Then the one costing 7 is first

    Scenario: Chronology is the tie-breaker, not the rule
      # A list in arrival order buries the critical finding under four notes
      # about naming.
      Given two "medium" drivers costing 3, the older added second
      When the drivers are ordered
      Then the older one is first

  Rule: attention is counted by who can act, not by how many there are

    Scenario: Drivers are counted by owner
      Given four agent drivers, two developer drivers and one external driver
      When attention is summarised
      Then it says 4 for the agent
      And it says 2 for the developer
      And it says 1 for external

    Scenario: Resolved drivers want nobody's attention
      Given four agent drivers, two developer drivers and one external driver
      And the external driver has been resolved
      When attention is summarised
      Then it says 0 for external

    Scenario: The summary says what each owner could unlock
      Given four agent drivers, two developer drivers and one external driver
      When attention is summarised
      Then resolving the agent's drivers would raise the score
      And resolving the developer's drivers would raise the score

    Scenario: Lifting a cap is worth more than the driver's own impact
      # A critical driver costs its impact and holds a ceiling. Resolving it
      # gives back both, and the estimate has to say so or the ranking sends
      # somebody at the wrong thing.
      Given a "critical" driver costing 2 and a "medium" driver costing 6
      When the next actions are worked out
      Then the critical one is offered first

  Rule: a recommendation names something that exists

    A recommendation to run a workflow the project does not have is worse than
    no recommendation.

    Scenario: A recommended workflow the project has is offered as a workflow
      Given a driver recommending the "checkout-regression" workflow
      And the project has a "checkout-regression" workflow
      When the next actions are worked out
      Then the action is a "workflow"
      And it names "checkout-regression"

    Scenario: A recommended workflow the project does not have becomes an investigation
      Given a driver recommending the "checkout-regression" workflow
      And the project has no workflows
      When the next actions are worked out
      Then the action is an "agent_investigation"
      And it names no workflow

    Scenario: A driver with no recommendation still appears
      # Knowing that the highest-impact uncertainty has no obvious next step is
      # itself worth knowing.
      Given an open driver of "high" severity with no recommended action
      And the project has no workflows
      When the next actions are worked out
      Then one action is offered

    Scenario: A developer-owned driver is offered as a decision
      Given a developer-owned driver with no recommended action
      And the project has no workflows
      When the next actions are worked out
      Then the action is a "developer_decision"
