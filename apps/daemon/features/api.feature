Feature: The definitions API
  The local service the builder talks to. Routes are thin adapters over the
  packages — nothing is implemented here, because this API is the contract a
  commercial edition builds on, and anything living in a route is something the
  open core cannot offer.

  Phases get the same treatment as workflows, including DELETE. In the
  prototype a phase had no routes of its own, so one shared by two workflows
  was rewritten wholesale by whichever workflow was saved last.

  Background:
    Given a running daemon with a project scope and a user scope

  Scenario: Listing shows what is available and what it shadows
    Given the project defines the workflow "development"
    And the user also defines the workflow "development"
    When I GET "/api/workflows"
    Then the response is 200
    And "development" is listed once
    And "development" resolves from the project scope

  Scenario: Fetching one returns the definition, its bytes and an etag
    Given the project defines the workflow "development"
    When I GET "/api/workflows/development"
    Then the response is 200
    And the body has a definition named "development"
    And the body has the file's raw text
    And the body has an etag

  Scenario: Fetching one that does not exist is a 404
    When I GET "/api/workflows/nowhere"
    Then the response is 404

  Scenario: Asking why lists every path that was tried
    Given the project defines the workflow "development"
    When I GET "/api/workflows/development/why"
    Then the response is 200
    And 3 candidates are listed

  Scenario: Creating writes a new file
    When I POST a workflow named "release"
    Then the response is 201
    And the workflow "release" now exists
    And the response carries an etag

  Scenario: Creating something that already exists is a conflict
    Given the project defines the workflow "development"
    When I POST a workflow named "development"
    Then the response is 409

  Scenario: Updating with the etag I read succeeds
    Given the project defines the workflow "development"
    And I have fetched it
    When I PUT it back with a new description
    Then the response is 200
    And the stored workflow has the new description

  Scenario: Updating preserves comments the author wrote
    Given the project defines a commented workflow "development"
    And I have fetched it
    When I PUT it back with a new description
    Then the response is 200
    And the stored file still has its comment

  Scenario: Updating with a stale etag is refused with the current content
    Given the project defines the workflow "development"
    And I have fetched it
    And someone else edits the file
    When I PUT it back with a new description
    Then the response is 409
    And the response carries the current content

  Scenario: The body and the URL must agree on the name
    Given the project defines the workflow "development"
    When I PUT a workflow named "something-else" to "/api/workflows/development"
    Then the response is 400

  Scenario: Deleting says what the name resolves to now
    Given the project defines the workflow "development"
    And the user also defines the workflow "development"
    When I DELETE "/api/workflows/development"
    Then the response is 200
    And the response says it now resolves from the user scope

  Scenario: Deleting the last copy says nothing is left
    Given the project defines the workflow "development"
    When I DELETE "/api/workflows/development"
    Then the response is 200
    And the response says nothing resolves it now

  Scenario: Phases have the same routes as workflows
    When I POST a phase named "analysis"
    Then the response is 201
    And the phase "analysis" now exists
    When I DELETE "/api/phases/analysis"
    Then the response is 200

  Scenario: Saving into a scope that is not in the chain says so
    Given the project scope has been taken away
    When I POST a workflow named "release"
    # It answered 500 with "No project scope in this chain", which is a fault
    # the caller cannot act on. The condition is ordinary — a repository
    # registered before Factory started creating a scope for one — and the
    # message already knows enough to say it.
    Then the response is 400
    And the response names the scope that is missing

  Scenario: A definition that does not validate is refused
    When I POST a workflow with an invalid mode
    Then the response is 400
    And the response names the problem field

  Scenario: Previewing renders the canonical form the writer would produce
    Given the project defines the workflow "development"
    When I preview the workflow that is stored
    Then the response is 200
    And the preview reads back as the same definition
    And previewing it again gives the same text

  Scenario: Exporting produces a bundle
    Given the project defines the workflow "development"
    When I POST "/api/workflows/development/export"
    Then the response is 200
    And the bundle contains the phase "analysis"

  Scenario: The bundles Factory ships can be listed
    # Findable at all, which they were not: the only way to import one was to
    # know a path inside node_modules and type it at a terminal.
    When I GET "/api/bundles/examples"
    Then the response is 200
    And the bundle "reliability" is offered
    And it says how many workflows it carries

  Scenario: A shipped bundle can be read
    When I GET "/api/bundles/examples/reliability"
    Then the response is 200
    And the text is a bundle carrying the workflow "analysis"

  Scenario: A bundle Factory does not ship is a 404
    When I GET "/api/bundles/examples/nonesuch"
    Then the response is 404

  Scenario: A name that is a path is refused rather than resolved
    # `../../etc/passwd` is a filename Factory does not ship, and the refusal
    # has to come before the filesystem is asked anything at all.
    When I GET a shipped bundle named "../../../etc/passwd"
    Then the response is 400

  Scenario: The shipped bundle goes in through the same door a person's file does
    When I import the shipped bundle "reliability" into the user scope
    Then the response is 200
    And the workflow "analysis" is in the user scope

  Scenario: Importing is previewed without writing
    Given the project defines the workflow "development"
    And I have exported it
    When I import it into the user scope as a dry run
    Then the response is 200
    And nothing was written

  Scenario: Importing a clashing name is a conflict
    Given the project defines the workflow "development"
    And the user also defines the workflow "development"
    And I have exported it
    When I import it into the user scope
    Then the response is 409

  Scenario: The scopes endpoint reports the chain
    When I GET "/api/scopes"
    Then the response is 200
    And the chain is "project, user, builtin"

  Scenario: The step-kind registry tells the builder which editors to offer
    When I GET "/api/registries/step-kinds"
    Then the response is 200
    And "shell" is listed as runnable

  Scenario: The provider registry fills the agent dropdown
    When I GET "/api/registries/providers"
    Then the response is 200
    And "claude" is listed

  Scenario: Doctor reports findings in the body, not the status
    Given the project defines a workflow naming a missing phase
    When I GET "/api/doctor"
    Then the response is 200
    And the findings mention the missing phase

  Scenario: The board is served from the same process
    Given a built board
    When I GET "/"
    Then the response is 200
    And the board's page is returned

  Scenario: A page the app routes itself is not a 404
    Given a built board
    When I GET "/tasks/abc123"
    Then the board's page is returned

  Scenario: A path climbing out of the build directory cannot escape it
    Given a built board
    And a file next to the build directory that must not be served
    When I GET "/%2e%2e%2fsecret.txt"
    Then the file's contents are not in the response

  Scenario: Without a built board the API still serves
    When I GET "/api/health"
    Then the response is 200

  Scenario: Without a built board the root page says how to build it
    When I GET "/"
    # What a newcomer used to get here was Fastify's own
    # {"message":"Route GET:/ not found"} — from a daemon that had already
    # printed the answer to a log nobody was looking at.
    Then the response is 200
    And the page says the board is not built
    And the page names the command that builds it

  Scenario: Without a built board an asset request is still a plain 404
    When I GET "/assets/index-abc123.js"
    # A machine asking for a file gets an honest answer; only a page request
    # gets the explanation.
    Then the response is 404

  Scenario: An API path the daemon does not serve is a JSON 404, not the board
    # The board's catch-all exists so `/tasks/abc` resolves in the app router
    # rather than 404ing. It was catching `/api/…` too, so a client calling a
    # route this daemon does not have got `index.html` with a 200 — and every
    # caller then failed on `undefined`, somewhere else entirely, saying
    # nothing about the request. An older daemon and a newer board is the
    # ordinary way to be in exactly that position.
    Given a built board
    When I GET "/api/bundles/examples/nothing-like-this"
    Then the response is 404
    And the response is JSON
    And the board's page is not returned

  Scenario: A page whose name merely begins with those letters is still a page
    # The guard is on the path segment, not on the three characters. `/apiary`
    # is a route the app may hold, and refusing it because it starts with "api"
    # would break a page for a reason nobody could guess from the name.
    Given a built board
    When I GET "/apiary"
    Then the board's page is returned

  Scenario: An unknown API path is a 404 even where there is no board to serve
    When I GET "/api/nothing-like-this"
    Then the response is 404
    And the response is JSON


  Rule: a profile goes in and out through the same routes as everything else

    A profile is a definition, so it gets the six routes every kind gets from one
    row in the layout table. Worth asserting rather than assuming: the row is the
    only thing that makes it true, and a kind that half-arrived would fail
    somewhere nobody was looking.

    Scenario: A profile can be written and read back
      When I POST a profile named "development"
      Then the response is 201
      And reading it back returns what was written
      And the file was written as a profile

    Scenario: Previewing a profile shows the YAML it would write
      When I preview a profile named "development"
      Then the response is 200
      And the preview reads as a profile

    Scenario: A profile that would reach Full Access is refused
      # The upper bound, enforced where every write passes through rather than
      # in one client. `--permission-mode bypassPermissions` is what Claude's
      # Full Access passes, so a profile passing it is Full Access with a
      # friendlier name and no warning banner.
      When I POST a profile that passes "bypassPermissions" to claude
      Then the response is 400
      And the refusal names Full Access

    Scenario: A profile that allows an ordinary build tool is written
      When I POST a profile allowing "cargo"
      Then the response is 201

  Rule: plugins can be listed and switched

    `GET /api/capabilities` grouped what was installed by *kind*, which was the
    right shape when the builder was its only reader — and those registries are
    served better by `/api/registries/*`. It could not show a plugin that was
    switched off or one that failed to load, because it read the host, and the
    host only knows what loaded. This reads the catalogue, which is a superset.

    Scenario: The list names every plugin and what it contributes
      When I ask for the plugins
      Then the built-in step kinds are listed
      And the list says which capabilities each one provided
      And the two core built-ins are marked essential

    Scenario: Switching one off writes it to the settings, and nothing else
      When I switch off "@factory/task-diffity"
      Then the response is 200
      And "@factory/task-diffity" is listed as switched off
      And the settings file holds it
      # The file beside it is hand-written and full of the author's comments.
      And the scope config is untouched

    Scenario: One still loaded says a restart will unload it
      When I switch off "@factory/task-diffity"
      # The host has no unload, so honesty is the only option available.
      Then it says a restart is required

    Scenario: Switching it back on removes it again
      Given "@factory/task-diffity" is switched off
      When I switch on "@factory/task-diffity"
      Then the response is 200
      And nothing is switched off

    Scenario: An essential plugin cannot be switched off
      When I switch off "@factory/core/builtin-steps"
      Then the response is 409
      And the error says it is essential

    Scenario: Switching off something nothing claims is refused
      When I switch off "@acme/imaginary"
      # A typo must not become a line silently written into somebody's file.
      Then the response is 404

    Scenario: Switching *on* something nothing claims is allowed
      Given "@acme/long-gone" is switched off
      When I switch on "@acme/long-gone"
      # This is how a stale id gets forgotten. Refusing it would trap the one
      # person who needs it.
      Then the response is 200
      And nothing is switched off

    Scenario: A body that is not a yes or a no is a bad request
      When I ask to switch "@factory/task-diffity" to "maybe"
      Then the response is 400

  Rule: the interface size is a setting, not a guess

    Scenario: It starts at 1
      When I ask for the settings
      Then the interface scale is 1
      And the settings name the file they came from

    Scenario: A new scale is saved and read back
      When I set the interface scale to 2
      Then the response is 200
      And asking again reports 2

    Scenario: A scale past what the board supports is refused
      When I set the interface scale to 40
      Then the response is 400
      And the error says what the range is

    Scenario: A scale that is not a number is refused
      When I set the interface scale to "big"
      Then the response is 400

    Scenario: A patch naming nothing is refused
      When I patch the settings with nothing
      Then the response is 400

  Rule: the appearance theme is a setting too

    Scenario: It starts at "system"
      When I ask for the settings
      Then the theme is "system"

    Scenario: A new theme is saved and read back
      When I set the theme to "light"
      Then the response is 200
      And asking again reports the theme "light"

    Scenario: A theme that is not light, dark or system is refused
      When I set the theme to "sepia"
      Then the response is 400
      And the error names the themes

    Scenario: Changing the theme leaves the scale alone
      Given the interface scale is 2
      When I set the theme to "light"
      Then asking again reports the theme "light"
      And the interface scale is still 2

    Scenario: Changing the scale leaves the theme alone
      Given the theme is "light"
      When I set the interface scale to 2
      Then the interface scale is 2
      And asking again reports the theme "light"

  Rule: the disclaimer is recorded once, and the profile is a setting

    Factory coordinates other people's coding agents against real repositories,
    and until now it did that with no boundary of its own and said nothing about
    it. One screen, once. The version is a number rather than a flag so that a
    material change in what an agent may reach can ask again — and the number
    stored is Factory's, never the client's, or a client could accept a notice
    it had not been shown.

    Scenario: A fresh installation has accepted nothing
      When I ask for the settings
      Then it says nothing has been accepted
      And it carries the disclaimer to show
      And the disclaimer says which profile removes the boundaries

    Scenario: Accepting it is recorded
      When I accept the disclaimer
      Then the response says it is accepted
      And the settings say it is accepted
      And the file records the current version

    Scenario: Accepting it twice is not an error
      Given the disclaimer has been accepted
      When I accept the disclaimer
      Then the response says it is accepted

    Scenario: An older acceptance is not enough
      Given the settings file records an acceptance of version 0
      When I ask for the settings
      # Rejected by the schema — the version is at least 1 — so it reads as
      # never accepted, which is the safe direction.
      Then it says nothing has been accepted

    Scenario: The default profile for new projects can be changed
      When I set the installation profile to "full-access"
      Then the settings say the installation profile is "full-access"

    Scenario: A profile that is not one is refused
      When I set the installation profile to "sort-of-safe"
      Then the response is 400
      And the response names the profiles

    Scenario: Changing the profile leaves the other settings alone
      Given the interface scale is 2
      And a plugin is switched off
      When I set the installation profile to "full-access"
      # The settings file is merged one level down, per named group, and a group
      # that is not merged is dropped *silently*. This is the guard.
      Then the settings say the installation profile is "full-access"
      And the interface scale is still 2
      And the plugin is still switched off

    Scenario: Changing the scale leaves the profile alone
      Given the installation profile is "full-access"
      When I set the interface scale to 2
      Then the interface scale is 2
      And the settings say the installation profile is "full-access"

    Scenario: A patch with nothing in it says what it takes
      When I send an empty settings patch
      Then the response is 400
      And the response mentions the profile

  Rule: a plugin can refuse a definition, or adjust it on its way to disk

    Two hooks have been on the plugin SDK since the host was built —
    `validateDefinition` and `beforeDefinitionWrite` — and neither was ever
    called. A plugin could register one, see it counted in its own conformance
    report, read it in the documentation, and have it never run: exactly the
    shape this codebase keeps paying for, a seam that validates and lies.

    They run where every write goes through, so the API, the CLI, a bundle
    import and scaffolding a project all get the same answer. The file is still
    read back afterwards, which is what stops a hook that adjusted a definition
    into something Factory cannot load.

    Scenario: A plugin can refuse a definition
      Given a plugin that refuses any workflow called "forbidden"
      When I POST a workflow named "forbidden"
      Then the response is 400
      And the response carries the plugin's reason
      And the workflow "forbidden" was not written

    Scenario: A plugin that refuses one name leaves the others alone
      Given a plugin that refuses any workflow called "forbidden"
      When I POST a workflow named "allowed"
      Then the response is 201

    Scenario: A plugin can adjust what is written
      Given a plugin that describes every workflow it is shown
      When I POST a workflow named "allowed"
      Then the response is 201
      And the stored workflow carries the description the plugin gave it

    Scenario: A plugin can refuse the write itself
      Given a plugin that refuses to write anything
      When I POST a workflow named "allowed"
      Then the response is 400
      And the workflow "allowed" was not written

    Scenario: A hook that throws refuses rather than writing half of it
      Given a plugin whose write hook throws
      When I POST a workflow named "allowed"
      # A transform that threw was in the middle of deciding. Carrying on would
      # write the value it may have been about to refuse.
      Then the response is 400
      And the workflow "allowed" was not written

  Rule: the installation-wide profile stays one of the two Factory ships

    A custom profile is resolved through the chain of the project that names it,
    and a profile written in one repository does not exist for any other. An
    installation-wide setting naming one would refuse to plan everywhere except
    where it was written — a footgun shaped exactly like a setting that works.

    Scenario: A custom profile is refused as the installation's default
      Given the user scope defines the profile "buildtools"
      When I set the installation profile to "buildtools"
      Then the response is 400

    Scenario: The built-ins are still accepted
      When I set the installation profile to "full-access"
      Then the response is 200
