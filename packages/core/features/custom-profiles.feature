Feature: A profile somebody wrote themselves

  Factory ships two profiles because two is the number of answers to "may this
  agent touch things outside the project" — no, and yes. That is still true, and
  neither of them changes here.

  What was missing is the third position: *yes to this one command, in this one
  repository, because I know what it costs*. A Rust project's agent cannot run
  `cargo test`; a Makefile project's cannot run `make check`. The only lever was
  Full Access, which answers a question nobody asked.

  So a custom profile is a definition, like a workflow — written down, layered,
  editable, shareable in a bundle. And it is always confined: it widens which
  *commands* may run, never *where* they may write.

  Rule: a name Factory does not ship is still a profile, and still confined

    The type stops being a closed pair. Everything that decides what a run may
    do keeps its answer, because the alternative — a custom profile deciding
    confinement — is Full Access under another name.

    Scenario: The two Factory ships are the built-in ones
      Then "default" is a built-in profile
      And "full-access" is a built-in profile
      And "development" is not a built-in profile

    Scenario: A profile nobody shipped is confined
      # The whole safety story in one line. `isConfined` answers by exception,
      # so every name that is not Full Access is confined, including names that
      # did not exist when it was written.
      Then the profile "development" is confined
      And the profile "anything-at-all" is confined
      And the profile "full-access" is not confined

    Scenario: A custom profile cannot be spelled to escape confinement
      # Near-misses, because "full access" with a space reaching the unconfined
      # branch would be a boundary removed by a typo.
      Then the profile "Full-Access" is confined
      And the profile "full access" is confined
      And the profile "full_access" is confined

  Rule: what may be stored is what is known, not what is shipped

    A profile arriving over the wire or read back from a row is checked before
    anything uses it. That check used to be "is it one of the two". It becomes
    "is it one of the two, or one this installation defines" — and an unknown
    name is still refused, because a name nobody defined silently loosening a
    project that asked to be confined is the failure the original check exists
    to stop.

    Scenario: A built-in is known without anything being defined
      Given no profiles are defined
      Then "default" is a known profile
      And "full-access" is a known profile

    Scenario: A name nobody defined is not known
      Given no profiles are defined
      Then "development" is not a known profile

    Scenario: A defined name is known
      Given the profile "development" is defined
      Then "development" is a known profile

    Scenario: Defining one does not make every name known
      Given the profile "development" is defined
      Then "something-else" is not a known profile

  Rule: each profile has one name for a person

    Scenario: The built-ins keep the names they already had
      Then "default" reads as "Default"
      And "full-access" reads as "Full Access"

    Scenario: A custom profile reads as what it called itself
      Given the profile "development" is defined, described as "Build tools"
      Then "development" reads as "Build tools"

    Scenario: A custom profile that described nothing reads as its own name
      Given the profile "development" is defined
      Then "development" reads as "development"

  Rule: a custom profile starts from the confined list, never from nothing

    No descriptor will ever name a profile somebody wrote themselves. Asked for
    one, a provider answers with its **Default** arguments — the confined ones —
    because a custom profile extends Default by construction. Whatever it adds
    is added on top of those, by the renderer, never instead of them.

    The two ways of getting this wrong are both silent: falling back to Full
    Access would run unconfined under a name nobody marked, and falling back to
    nothing would drop `--restricted` and the tool list together.

    Scenario: A custom profile gets the confined arguments
      Given a provider whose Default passes "--restricted" and whose Full Access passes "--yolo"
      Then the profile "development" is given "--restricted"
      And the profile "development" is not given "--yolo"

    Scenario: The built-ins are unchanged
      Given a provider whose Default passes "--restricted" and whose Full Access passes "--yolo"
      Then the profile "default" is given "--restricted"
      And the profile "full-access" is given "--yolo"

    Scenario: A descriptor that predates profiles answers the same for a custom one
      Given a provider that passes "--same" whatever the profile
      Then the profile "development" is given "--same"
