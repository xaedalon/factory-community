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

  Rule: what reads the work is an installation preference a project may override

    The agent evaluator costs tokens, and the model worth spending them on is a
    project's decision — but setting the same strong judge on every new project
    is work nobody should have to repeat. So the installation carries a default
    and a project overrides it.

    Nothing is defaulted here. A model named in the source would spend somebody's
    tokens on a decision nobody made, and the free deterministic evaluator always
    runs regardless.

    Scenario: A fresh installation names no judge
      Given an installation with the default settings
      Then no judging provider is named
      And no judging model is named

    Scenario: A judge can be named
      Given an installation with the default settings
      When the judge is set to "codex" using "strong" at "high"
      Then the judging provider is "codex"
      And the judging model is "strong"
      And the judging effort is "high"

    Scenario: Naming the judge leaves the interface alone
      Given the interface scale is 2
      When the judge is set to "codex" using "strong" at "high"
      Then the scale is 2

  Rule: a setting can be cleared, not only changed

    `undefined` inside a group has always meant "not mentioned", so that a caller
    spreading an optional field in could not erase what was already there. That
    left no way to take a value back *out*, which did not matter while every
    setting had a default — and matters now, because an installation default
    nobody can un-set is a default they cannot stop paying for.

    Scenario: Null takes a value back out of the file
      Given an installation with the default settings
      And the judge is set to "codex" using "strong" at "high"
      When the judging model is cleared
      Then no judging model is named
      And the judging provider is "codex"

    Scenario: Undefined still leaves a value alone
      Given an installation with the default settings
      And the judge is set to "codex" using "strong" at "high"
      When a patch mentions the judge but names no model
      Then the judging model is "strong"

  Rule: how far work may start work is a setting

    Factory can now be driven by an agent, and an agent Factory launched can
    reach the daemon. The limits on how deep that may go belong here rather
    than in the code, because the right number depends on what somebody is
    doing — and belong here rather than in the client that is asking, because a
    rule only one client enforces is advice.

    Scenario: A fresh installation allows three levels and ten tasks a run
      Given an installation with the default settings
      Then work may start work three levels deep
      And one run may ask for ten tasks

    Scenario: The depth can be turned down to nothing
      # A legitimate thing to want: only a person starts work here.
      Given an installation with the default settings
      When the orchestration depth is set to 0
      Then work may start work zero levels deep

    Scenario: A depth nobody could have meant is refused
      Given an installation with the default settings
      When the orchestration depth is set to 500
      Then the settings are refused
      And what is saved still allows three levels
