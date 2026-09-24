Feature: Sharing a workflow with someone else
  A bundle is how a workflow leaves the machine — attached to a pull request,
  pasted into a chat, committed to a repository. Export gathers everything the
  workflow needs into one file; import previews what that file would do before
  writing any of it.

  The preview matters more than it sounds. An import touches several files at
  once, and its interesting outcomes are invisible from the file itself: a name
  already taken, or a name free here but present in a lower scope, where writing
  quietly changes which definition wins.

  Background:
    Given a project scope and a user scope

  Scenario: A workflow can be exported from the list
    Given the project defines the workflow "development"
    When I open the workflows page
    And I export "development"
    Then a bundle file is downloaded
    And the bundle contains the phase "analysis"

  Scenario: An incomplete workflow refuses to export, and says why
    Given the project defines the workflow "development"
    And the phase it needs is deleted
    When I open the workflows page
    And I export "development"
    Then the export is refused
    And the reason names the missing phase

  Scenario: An import is previewed before anything is written
    Given a bundle for the workflow "development"
    When I open the import page
    And I paste the bundle
    And I choose the user scope
    Then the plan says "development" would be created
    And the plan says "analysis" would be created
    And nothing has been written yet

  Scenario: Importing writes the files
    Given a bundle for the workflow "development"
    When I open the import page
    And I paste the bundle
    And I choose the user scope
    And I import
    Then it says the files were written
    And the user scope has the workflow "development"

  Scenario: A name already taken blocks the import
    Given a bundle for the workflow "development"
    And the user already defines the workflow "development"
    When I open the import page
    And I paste the bundle
    And I choose the user scope
    Then the plan marks "development" as a conflict
    And the import cannot proceed
    And I am told how to resolve it

  Scenario: Skipping brings in only what is new
    Given a bundle for the workflow "development"
    And the user already defines the workflow "development"
    When I open the import page
    And I paste the bundle
    And I choose the user scope
    And I set the conflict policy to "skip"
    Then the plan says "development" would be skipped
    And the plan says "analysis" would be created

  Scenario: A prefix renames everything on the way in
    Given a bundle for the workflow "development"
    And the user already defines the workflow "development"
    When I open the import page
    And I paste the bundle
    And I choose the user scope
    And I set the prefix to "acme-"
    Then the plan says "acme-development" would be created
    And the plan says it was renamed from "development"
    And the import can proceed

  Scenario: Importing where it would hide a lower copy says so
    Given a bundle for the workflow "development"
    And the user already defines the workflow "development"
    And the project's own copy is removed
    When I open the import page
    And I paste the bundle
    And I choose the project scope
    Then the plan says "development" would be created
    And the plan says "development" will hide the user copy

  Scenario: A document that is not a bundle is rejected clearly
    When I open the import page
    And I paste a document that is not a bundle
    Then the import is refused
    And I am told it is not a bundle

  Rule: the bundles Factory ships are one click, not a path in node_modules

    The reliability pipeline was shipped beside the board and reachable only by
    somebody who knew it was inside a package directory and typed the path at a
    terminal. A bundle nobody can find is a bundle nobody uses.

    It goes in through the ordinary import path, so what lands in the repository
    is what the preview screen would have shown — one door, one set of rules.

    Scenario: The project page offers the reliability workflows
      Given a project
      When I open that project's settings
      Then it offers to add the reliability workflows

    Scenario: Adding them writes them into the project
      Given a project
      When I open that project's settings
      And I add the reliability workflows
      Then it says what was written
      And the workflow "analysis" is in the project

    Scenario: A failure adding them is shown beside the button that caused it
      # Under the control you just pressed, which needs no hunting for. The
      # form's own banner is for what belongs to no single box, and putting this
      # there would make it look like the save had failed.
      Given a project
      And the daemon refuses to hand over the bundle
      When I open that project's settings
      And I add the reliability workflows
      Then the reliability field says what went wrong
      And the form's banner says nothing

    Scenario: An answer that is not JSON says so, rather than failing on nothing
      # A daemon older than the board answers an API path it does not know with
      # the board's own HTML and a 200. Reading that as a result produced
      # "Cannot read properties of undefined (reading 'text')" — a message about
      # the line that gave up, naming neither the request nor the cause.
      Given a project
      And the daemon answers that request with a page instead of JSON
      When I open that project's settings
      And I add the reliability workflows
      Then the reliability field says the daemon was not understood
      And it names the request that failed

  Rule: an error is shown where it was caused

    A message under the box it is about needs no hunting for. One that cannot
    belong to a box goes at the top, where the form begins — never at the foot,
    below every field, where a long form puts it off the screen.

    Scenario: A failure that belongs to no field is shown at the top
      Given a project
      And the daemon refuses the next save
      When I open that project's settings
      And I try to save the project
      Then the form says what went wrong
      And it says so above the first field

  Rule: a project says which model reads its work

    Scenario: A new project names none
      Given a project
      When I open that project's settings
      Then no judging model is named

    Scenario: A model can be named and it stays named
      Given a project
      When I open that project's settings
      And I name "claude-opus-5-5" as the judging model
      And I save the project
      And I open that project's settings
      Then the judging model is "claude-opus-5-5"
