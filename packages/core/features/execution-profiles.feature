Feature: How much authority an agent gets

  Factory ran every agent the same way and called it nothing. `provider-claude`
  passed `--permission-mode bypassPermissions`; `provider-copilot` passed
  `--allow-all-paths`, which switches off that CLI's own path checking. So every
  run was unrestricted, no run said so, and there was no vocabulary to say it
  in.

  This is the vocabulary: two profiles, and one function that decides which one
  applies. Two, because there are two genuinely different answers to "may this
  agent touch things outside the project?" — and refining the first one is a
  later increment's job, not a reason to invent a policy language now.

  Scenario: An installation that has said nothing is confined
    Given a project that states no profile
    And an installation that states no profile
    When I ask which profile applies
    Then the profile is "default"
    And the agent is confined

  Scenario: The installation's choice applies to a project that states none
    Given a project that states no profile
    And the installation chose "full-access"
    When I ask which profile applies
    Then the profile is "full-access"
    And the agent is not confined

  Scenario: A project overrides the installation
    Given the project chose "default"
    And the installation chose "full-access"
    When I ask which profile applies
    # The direction that matters: one throwaway repository can run unrestricted
    # without loosening anything else, and one careful repository can stay
    # confined on a machine that is not.
    Then the profile is "default"

  Scenario: A project can be less confined than its installation
    Given the project chose "full-access"
    And the installation chose "default"
    When I ask which profile applies
    Then the profile is "full-access"

  Rule: absence means "not stated", never a third answer

    The resolver reads two optional values, and the temptation is to treat a
    missing project profile as a decision. It is not one. A project that has
    never been asked inherits, so that changing the installation default
    actually changes the projects that never chose — which is the whole point of
    having an installation default.

    Scenario: A project that states nothing follows the installation later
      Given a project that states no profile
      And the installation chose "full-access"
      When I ask which profile applies
      Then the profile is "full-access"

    Scenario: Stating the same thing as the installation is still a decision
      Given the project chose "full-access"
      And the installation chose "full-access"
      When I ask which profile applies
      Then the profile is "full-access"

  Rule: a profile arriving from outside is checked before it is stored

    Profiles arrive over HTTP and out of a settings file. A typo must be a
    refusal at the door, not a value written into somebody's project row that
    then resolves to neither profile and is read as "not stated" — which would
    silently *loosen* a project that had asked to be confined.

    Scenario: The two profiles are recognised
      When I check "default" and "full-access"
      Then both are profiles

    Scenario: Anything else is not a profile
      When I check "Default", "full access", "none", "" and nothing at all
      Then none of them is a profile

  Rule: each profile has one name for a person

    The CLI prints these, the board shows them and the docs name them. A profile
    that reads "Full Access" on one screen and "full-access" on the next is a
    profile somebody will think is two.

    Scenario: Both profiles have a label
      When I ask what to call each profile
      Then "default" is called "Default"
      And "full-access" is called "Full Access"

  Rule: a descriptor written before profiles existed still works

    `permissionArgs` used to be one list. Every descriptor in the wild is that
    shape, including a third party's, and breaking them to introduce a profile
    would make the profile the reason nobody upgrades.

    So a bare list is read as "the same arguments whatever the profile". It is
    not silently accepted: a provider that cannot tell the profiles apart has a
    Default profile only as confined as Factory's own boundary makes it, and
    doctor says so.

    Scenario: A bare list is used under both profiles
      Given a descriptor whose permission arguments are one list
      When I ask for its arguments under "default" and under "full-access"
      Then both answers are that list

    Scenario: A bare list is reported as not telling the profiles apart
      Given a descriptor whose permission arguments are one list
      Then it does not distinguish the profiles

    Scenario: A profile map answers each profile separately
      Given a descriptor with different arguments per profile
      When I ask for its arguments under "default" and under "full-access"
      Then each answer is that profile's own list

    Scenario: A profile map is reported as telling them apart
      Given a descriptor with different arguments per profile
      Then it distinguishes the profiles

    Scenario: A profile map that names one profile is completed with an empty list
      Given a descriptor that names only "full-access"
      # The schema fills the missing profile in, which is what makes a fallback
      # in the lookup unnecessary — and a fallback is worth not having, because
      # the obvious one is "use the other profile's list", and for `default`
      # that would quietly mean Full Access.
      Then its "default" list is empty
      And its "full-access" list is what it named

  Rule: a step cannot argue its way out of the profile it runs under

    `args:` on an agent step — and on a named agent, which is a file in the
    project the agent itself can edit — is appended to the argv *after* the
    permission arguments. Nothing checked it, so
    `args: ['--permission-mode', 'bypassPermissions']` was Full Access under the
    Default profile: no setting changed, nothing said, and the only trace a line
    in a YAML file.

    The rule is derived rather than listed, so it stays true when a descriptor
    is edited and a third-party provider gets it for free: under a confined
    profile, an argument out of that provider's own `full-access` list is
    refused. A descriptor may name more, for the cases derivation cannot see.

    Scenario: An argument from the provider's Full Access list is refused
      Given a descriptor whose Full Access arguments are "--yolo"
      When a step under "default" passes "--yolo"
      Then that argument is refused

    Scenario: The same argument under Full Access is not refused
      # There is no boundary left to widen.
      Given a descriptor whose Full Access arguments are "--yolo"
      When a step under "full-access" passes "--yolo"
      Then nothing is refused

    Scenario: An ordinary argument is left alone
      Given a descriptor whose Full Access arguments are "--yolo"
      When a step under "default" passes "--verbose"
      Then nothing is refused

    Scenario: An argument the confined profile already passes is not refused
      # Otherwise a descriptor that names the same flag in both lists — with
      # different values — would refuse a step for repeating Factory's own.
      Given a descriptor that passes "--mode" under both profiles
      When a step under "default" passes "--mode"
      Then nothing is refused

    Scenario: A flag written with "=" is the same flag
      Given a descriptor whose Full Access arguments are "--yolo"
      When a step under "default" passes "--yolo=true"
      Then that argument is refused

    Scenario: A descriptor may forbid more than derivation can see
      # `--allowedTools` appears in neither list and replaces Factory's own,
      # because the option is variadic. Nothing could derive that.
      Given a descriptor that forbids "--allowedTools"
      When a step under "default" passes "--allowedTools"
      Then that argument is refused

    Scenario: A provider that has measured nothing forbids nothing
      # An empty Full Access list derives an empty rule. That is the honest
      # answer for a descriptor nobody has run — and doctor already says that
      # provider tells the profiles apart in no way at all.
      Given a descriptor with no permission arguments at all
      When a step under "default" passes "--yolo"
      Then nothing is refused

    Scenario: The provider Factory ships refuses the flag that started this
      Given the descriptor Factory ships for Claude
      When a step under "default" passes "--permission-mode bypassPermissions"
      Then that argument is refused

