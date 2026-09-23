Feature: Settings Factory owns

  Three stores were possible and two were wrong. `config.yaml` is hand-written
  and carries the author's comments, and a slider that saves on every drag has
  no business rewriting it. The database sits in the default *write* scope, so
  a "global" preference kept there would differ depending on which directory
  the daemon started in. What is left is a small file Factory owns, beside
  `config.yaml`, which is the pattern Pro already follows with its licence.

  Because Factory owns it, it gets a schema — so unlike `config.yaml`, a key
  nobody recognises is a diagnostic rather than silence.

  Scenario: An installation with no settings file has defaults
    Given a user scope with no settings file
    When the settings are read
    Then the interface scale is 1
    And the theme is "system"
    And no plugins are switched off
    And nothing is reported
    And no file was created

  Scenario: What was saved is what is read back
    Given a user scope with no settings file
    When the interface scale is set to 2
    And the settings are read
    Then the interface scale is 2

  Scenario: Saving one half does not drop the other
    Given a user scope with no settings file
    And the plugin "@factory/diffity" is switched off
    When the interface scale is set to 2
    And the settings are read
    # Two pages write this file. Replacing instead of merging is how one of
    # them silently undoes the other.
    Then the interface scale is 2
    And "@factory/diffity" is still switched off

  Scenario: The file says which kind it is
    Given a user scope with no settings file
    When the interface scale is set to 2
    Then the file on disk names the settings kind

  Scenario: A theme is saved and read back
    Given a user scope with no settings file
    When the theme is set to "light"
    And the settings are read
    Then the theme is "light"

  Scenario: Saving the theme does not drop the scale
    Given a user scope with no settings file
    When the interface scale is set to 2
    And the theme is set to "light"
    And the settings are read
    Then the interface scale is 2
    And the theme is "light"

  Rule: a file that will not load leaves the tool working

    The only way to diagnose a broken settings file is a Factory that still
    starts — the same reason a plugin that will not load is a Problem rather
    than a crash.

    Scenario: Unparseable JSON is reported, and the defaults apply
      Given a settings file that is not JSON
      When the settings are read
      Then the interface scale is 1
      And a problem says the file is not valid JSON

    Scenario: A key nobody recognises is reported with a suggestion
      Given a settings file with "scaal" instead of "scale"
      When the settings are read
      Then a problem suggests "scale"

    Scenario: A scale beyond what the board supports is refused
      Given a settings file asking for a scale of 40
      When the settings are read
      # The file is editable by hand, and a stored 40 renders a window nobody
      # can click out of.
      Then a problem names the field "ui.scale"
      And the interface scale is 1

    Scenario: A theme nobody recognises is refused
      Given a settings file asking for the theme "sepia"
      When the settings are read
      Then a problem names the field "ui.theme"
      And the theme is "system"

    Scenario: A write that would not load back is refused before it lands
      Given a user scope with no settings file
      When a scale of 40 is saved
      Then it is refused
      And no file was created

    Scenario: A write with an unrecognised theme is refused before it lands
      Given a user scope with no settings file
      When the theme is set to "sepia"
      Then it is refused
      And no file was created

  Rule: the path comes off the resolved chain

    Scenario: The settings sit beside config.yaml in the user scope
      Given a user scope with no settings file
      Then the settings path is "settings.json" in the user scope

    Scenario: A user scope at the old path is still the user scope
      Given a user scope at the legacy ".factory" path
      Then the settings path is inside that directory

    Scenario: With no user scope there is nowhere to save
      Given a chain with no user scope
      When the interface scale is set to 2
      Then it is refused
      And a problem says there is no user scope

  Rule: a group the writer was never told about is still written

    Settings are merged one level down, so that saving the interface scale does
    not discard the execution profile. That merge used to name each group by
    hand — `ui`, `security`, `plugins` — and the cost was hidden: a group not in
    that list was written nowhere, and silently. The call succeeded, the file
    was rewritten, and the value was gone. That is the shape the next top-level
    group would have arrived in, and it is the shape an `x-` extension group
    arrives in today: a plugin keeping its own settings beside Factory's had
    them discarded by the next save of anything else.

    It is written over the patch's own keys now, so there is no list to forget.

    Scenario: A group the merge does not name lands anyway
      Given an installation with the default settings
      When a patch carries an extension group beside a known one
      Then the file holds that group
      And the known setting was saved too

    Scenario: A group says only what it means to change
      Given the execution profile is "full-access"
      When the interface scale is set to 2
      Then the profile is still "full-access"
      And the scale is 2
