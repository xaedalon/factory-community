Feature: Sharing a workflow as one file
  A bundle carries a workflow and everything it needs, so the recipient imports
  a single document and it works. A workflow that arrives without its phases is
  not shareable — it is a puzzle.

  The inner definitions are written by the same writers that produce definition
  files, so what a bundle contains is exactly what would sit on disk. Anything
  else would only fail on the recipient's machine.

  Background:
    Given a project scope and a user scope
    And the project defines "development" with phases "analysis, implement"

  Scenario: Export analysiss the workflow and its phases
    When I export "development"
    Then the export succeeds
    And the bundle entry is "development"
    And the bundle contains the workflows "development"
    And the bundle contains the phases "analysis, implement"

  Scenario: Export follows the on_fail chain
    Given "development" fails over to "development-failure" with phase "diagnose"
    When I export "development"
    Then the export succeeds
    And the bundle contains the workflows "development, development-failure"
    And the bundle contains the phases "analysis, implement, diagnose"

  Scenario: Export follows what the workflow needs
    Given "development" needs "analysis-first"
    When I export "development"
    # A pipeline of five workflows was five exports and a merge by hand, and
    # the merge is where a mistake lands unnoticed. `needs` is the other half
    # of "everything it needs": phases were followed from the start, and the
    # workflows that must run before it were not.
    Then the export succeeds
    And the bundle contains the workflows "development, analysis-first"

  Scenario: A cycle in what workflows need terminates
    Given "development" needs "analysis-first"
    And "analysis-first" needs "development"
    When I export "development"
    Then the export succeeds
    And the bundle contains 2 workflows

  Scenario: A cycle in the on_fail chain terminates
    Given "development" fails over to "development-failure" with phase "diagnose"
    And "development-failure" fails back to "development"
    When I export "development"
    Then the export succeeds
    And the bundle contains 2 workflows

  Scenario: Export refuses to produce an incomplete bundle
    Given the phase "implement" is deleted
    When I export "development"
    Then the export fails
    And a problem names the missing phase "implement"

  Scenario: Export can be told to accept the gap
    Given the phase "implement" is deleted
    When I export "development" allowing missing definitions
    Then the export succeeds
    And the bundle records "implement" as unresolved

  Scenario: A bundle round-trips through export and import
    When I export "development"
    And I import the bundle into the user scope
    Then the import succeeds
    And the user scope has the workflow "development"
    And the user scope has the phase "analysis"
    And the imported workflow still lists the phase "analysis"

  Scenario: Import is previewed without writing anything
    When I export "development"
    And I preview importing the bundle into the user scope
    Then the import succeeds
    And every item would be created
    And the user scope has no workflow "development"

  Scenario: Import fails atomically when a name is taken
    Given the user scope already defines "development"
    When I export "development"
    And I import the bundle into the user scope
    Then the import fails
    And the plan marks "development" as a conflict
    And nothing was written

  Scenario: Skipping leaves what is already there
    Given the user scope already defines "development"
    When I export "development"
    And I import the bundle into the user scope skipping conflicts
    Then the import succeeds
    And "development" was skipped
    And "analysis" was created

  Scenario: Overwriting keeps the previous version
    Given the user scope already defines "development"
    When I export "development"
    And I import the bundle into the user scope overwriting conflicts
    Then the import succeeds
    And the previous version was moved out of the way

  Scenario: A prefix renames everything and rewrites internal references
    Given "development" fails over to "development-failure" with phase "diagnose"
    When I export "development"
    And I import the bundle into the user scope with the prefix "acme-"
    Then the import succeeds
    And the user scope has the workflow "acme-development"
    And "acme-development" lists the phases "acme-analysis, acme-implement"
    And "acme-development" fails over to "acme-development-failure"

  Scenario: Importing where it would hide a lower scope says so
    Given the user scope already defines "development"
    And the project's own copy is removed
    When I export the bundle from the user scope
    And I preview importing the bundle into the project scope
    Then the import succeeds
    And the plan says "development" would hide the user copy

  Scenario: A document that is not a bundle is rejected clearly
    When I read a document whose kind is "factory.workflow/v1"
    Then reading fails
    And a problem says it is not a bundle

  Scenario: A bundle carrying an invalid definition is rejected
    When I read a bundle whose workflow has an invalid mode
    Then reading fails
    And a problem names the field

  Scenario: The example bundle Factory ships imports cleanly
    Given the development example that ships with Factory
    When I import it into the user scope
    Then the import succeeds
    And the user scope has the workflow "development"
    And the user scope has the phase "review"
    And nothing it wrote fails to validate

  Rule: a bundle can carry a profile, and need not carry a workflow

    Nothing references a profile the way a step references an agent — a project
    chooses one — so a profile never arrives by being pulled in. It travels
    because somebody put it in the bundle, which is how the shipped example
    ships. That also means a bundle with no workflow at all is a real thing, and
    requiring an entry workflow would have meant naming one that is not in the
    file.

    Scenario: A bundle of only a profile reads
      Given the bundle Factory ships for build tools
      When it is read
      Then reading succeeds
      And it carries the profile "build-tools"
      And it names no entry workflow

    Scenario: Importing it writes the profile into the scope
      Given the bundle Factory ships for build tools
      When I import it into the user scope
      Then the profile "build-tools" is in the user scope

    Scenario: A prefix renames the profile on the way in
      Given the bundle Factory ships for build tools
      When I import it into the user scope with the prefix "acme-"
      Then the profile "acme-build-tools" is in the user scope
