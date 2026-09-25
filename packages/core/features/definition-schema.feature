Feature: Definition schemas
  Every workflow and phase is validated before it is used, and a mistake
  produces a message naming the field the user typed.

  The prototype had no schema at all: a bad enum value was cast straight to the
  union type and kept, an unknown key was ignored, and an agent block missing
  its prompt was dropped so the phase ran nothing and reported success. Each
  scenario below is one of those failures, made loud.

  # Nested YAML is written in flow style here because the Gherkin runner strips
  # leading whitespace from doc-string lines. Whitespace-sensitive cases live in
  # features/fixtures/ instead.

  Scenario: An invalid enum value is rejected and names its field
    Given the workflow YAML:
      """
      name: development
      mode: banana
      phases: [analysis]
      """
    When the workflow is parsed
    Then parsing fails
    And a problem names the field "mode"
    And a problem mentions "once"

  Scenario: An unknown field is rejected with a suggestion
    Given the workflow YAML:
      """
      name: development
      phasez: [analysis]
      """
    When the workflow is parsed
    Then parsing fails
    And a problem suggests "phases"

  Scenario: An unknown field with no near match lists the valid ones
    Given the workflow YAML:
      """
      name: development
      concurrency: parallel
      """
    When the workflow is parsed
    Then parsing fails
    And a problem lists the valid fields

  Scenario: A name that is not a slug is rejected
    Given the workflow YAML:
      """
      name: Development Workflow
      """
    When the workflow is parsed
    Then parsing fails
    And a problem names the field "name"

  Scenario: Defaults are applied so a minimal workflow is complete
    Given the workflow YAML:
      """
      name: development
      """
    When the workflow is parsed
    Then parsing succeeds
    And the workflow mode is "once"
    And the workflow scheduling is "parallel"
    And the workflow has 0 phases

  Scenario: Every field survives parsing
    Given the workflow YAML:
      """
      name: development
      mode: loop
      interval: 30
      scheduling: sequential
      description: Full development pipeline.
      variables: {region: eu-west-1}
      conditions: {requires: [hasWorktree], provides: [hasBuild], clears: [hasStaleBuild]}
      on_fail: development-failure
      phases: [analysis, implement]
      """
    When the workflow is parsed
    Then parsing succeeds
    And the workflow mode is "loop"
    And the workflow interval is 30
    And the workflow scheduling is "sequential"
    And the workflow on-fail is "development-failure"
    And the workflow requires "hasWorktree"
    And the workflow provides "hasBuild"
    And the workflow clears "hasStaleBuild"
    And the workflow variable "region" is "eu-west-1"
    And the workflow has 2 phases

  Scenario: interval without a loop is an error rather than a silent no-op
    Given the workflow YAML:
      """
      name: development
      interval: 30
      """
    When the workflow is parsed
    Then parsing fails
    And a problem names the field "interval"

  Scenario: Extension fields are preserved untouched
    Given the workflow YAML:
      """
      name: development
      x-jira: {project: WW2}
      """
    When the workflow is parsed
    Then parsing succeeds
    And the workflow extension "x-jira" is preserved

  Scenario: A phase listed twice is a warning, not an error
    Given the workflow YAML:
      """
      name: development
      phases: [analysis, analysis]
      """
    When the workflow is parsed
    Then parsing succeeds
    And there is a warning about a duplicate phase

  Scenario: An agent step with no prompt is an error, never a silent drop
    Given the phase YAML:
      """
      name: analysis
      steps: [{uses: agent, model: strong}]
      """
    When the phase is parsed
    Then parsing fails
    And a problem names the field "steps.0.prompt"

  Scenario: A phase carries approval and a working directory
    Given the phase YAML:
      """
      name: analysis
      approval: after
      working_dir: web
      steps: [{run: npm test}]
      """
    When the phase is parsed
    Then parsing succeeds
    And the phase approval is "after"
    And the phase working directory is "web"

  Scenario: A phase with no steps is a warning
    Given the phase YAML:
      """
      name: analysis
      """
    When the phase is parsed
    Then parsing succeeds
    And there is a warning about a phase with no steps

  # `approval: required` only ever meant "ask once the steps have run" — it was
  # written before there was another option. It is still read, so a file nobody
  # has touched keeps working; writing it back spells it `after`.
  Scenario: The old spelling of approval is still understood
    Given the phase YAML:
      """
      name: analysis
      approval: required
      steps: [{run: npm test}]
      """
    When the phase is parsed
    Then parsing succeeds
    And the phase approval is "after"

  Scenario: A phase can ask before it runs anything
    Given the phase YAML:
      """
      name: deploy
      approval: before
      steps: [{run: ./deploy.sh}]
      """
    When the phase is parsed
    Then parsing succeeds
    And the phase approval is "before"

  Rule: a loop can say how many times

    A loop with no bound runs until somebody notices, which is a poor default
    for something that spawns agents. `repeat` is capped at 100: a workflow that
    wants a thousand iterations wants a different design, and an unbounded box
    is an invitation to typo one.

    Scenario: A loop with a repeat count
      Given the workflow YAML:
        """
        name: development
        mode: loop
        repeat: 5
        """
      When the workflow is parsed
      Then parsing succeeds
      And the workflow repeat is 5

    Scenario: A repeat of nought is refused
      Given the workflow YAML:
        """
        name: development
        mode: loop
        repeat: 0
        """
      When the workflow is parsed
      Then parsing fails
      And a problem names the field "repeat"

    Scenario: A repeat past a hundred is refused
      Given the workflow YAML:
        """
        name: development
        mode: loop
        repeat: 101
        """
      When the workflow is parsed
      Then parsing fails
      And a problem names the field "repeat"

    Scenario: repeat without a loop is an error rather than a silent no-op
      Given the workflow YAML:
        """
        name: development
        repeat: 5
        """
      When the workflow is parsed
      Then parsing fails
      And a problem names the field "repeat"

    Scenario: A loop with no repeat is still valid, and unbounded
      Given the workflow YAML:
        """
        name: development
        mode: loop
        """
      When the workflow is parsed
      Then parsing succeeds
      And the workflow has no repeat

  Rule: a workflow names what must come before it

    Scenario: A workflow declares its predecessor
      Given the workflow YAML:
        """
        name: verify
        needs: [validate]
        """
      When the workflow is parsed
      Then parsing succeeds
      And the workflow needs "validate"

    Scenario: A workflow that needs nothing has an empty list, not a missing one
      Given the workflow YAML:
        """
        name: analysis
        """
      When the workflow is parsed
      Then parsing succeeds
      And the workflow needs nothing

    Scenario: A workflow cannot need itself
      Given the workflow YAML:
        """
        name: verify
        needs: [verify]
        """
      When the workflow is parsed
      Then parsing fails
      And a problem names the field "needs"

    Scenario: A path is not a workflow name
      Given the workflow YAML:
        """
        name: verify
        needs: [../elsewhere]
        """
      When the workflow is parsed
      Then parsing fails
      And a problem names the field "needs.0"

  Rule: a workflow with no phases says so while somebody can still see it

    A warning rather than an error, and the distinction is the builder: it
    writes a workflow before its phases are chosen, so refusing the file would
    make it impossible to create one in the browser at all. What must not
    happen is *running* it, and planning refuses that separately.

    Scenario: A workflow with no phases parses, with a warning
      Given the workflow YAML:
        """
        name: design
        description: Task design
        """
      When the workflow is parsed
      Then parsing succeeds
      And a warning says the workflow will do nothing

    Scenario: A workflow with a phase says nothing
      Given the workflow YAML:
        """
        name: design
        phases: [design]
        """
      When the workflow is parsed
      Then parsing succeeds
      And there are no warnings
