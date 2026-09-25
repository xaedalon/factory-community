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

  Rule: a profile is a definition, and says what it is

    Scenario: A profile carries what it widens
      Given the profile file:
        """
        kind: factory.profile/v1
        name: development
        commands: [cargo, make]
        """
      Then it parses
      And it allows "cargo"
      And it extends "default"

    Scenario: A profile cannot take a name Factory ships
      # The name is what a project stores and what resolution returns, so a
      # custom "default" would be a definition shadowing a concept — and which
      # one won would depend on a lookup order nobody wrote down.
      Given the profile file:
        """
        kind: factory.profile/v1
        name: default
        commands: [cargo]
        """
      Then it is refused
      And the refusal names the field "name"

    Scenario: A profile cannot extend Full Access
      # That is Full Access with a friendlier name and no warning banner.
      Given the profile file:
        """
        kind: factory.profile/v1
        name: development
        extends: full-access
        commands: [cargo]
        """
      Then it is refused

    Scenario: A profile that widens nothing says so
      Given the profile file:
        """
        kind: factory.profile/v1
        name: development
        """
      Then it parses
      And it warns that it allows nothing

    Scenario: A key Factory does not know is refused, with a suggestion
      # `network:` is in the proposal and Factory mediates none of it. A key
      # that reads correctly and does nothing is the mistake already made once.
      Given the profile file:
        """
        kind: factory.profile/v1
        name: development
        command: [cargo]
        """
      Then it is refused
      And the refusal suggests "commands"

  Rule: what a profile allows reaches the command line, once

    `--allowedTools` is variadic, and a repeated variadic option **replaces**
    rather than appends. Four flags would leave only the last in force, which
    looks like it works. So a profile's commands become one flag with one
    separated value, added to what the confined profile already passes.

    Scenario: A profile's commands are added to the confined list
      Given a provider that allows commands with "--allowedTools" as "Bash({command} *)"
      And a profile allowing "cargo" and "make"
      When the command is rendered
      Then the argv still carries "--restricted"
      And "--allowedTools" appears once
      And its value carries "Bash(cargo *)"
      And its value carries "Bash(make *)"

    Scenario: The profile's own entries join the ones Default already passes
      # Adding rather than replacing is the whole point: a profile that wanted
      # cargo must not cost the project its package managers.
      Given a provider that allows commands with "--allowedTools" as "Bash({command} *)"
      And whose Default already allows "Bash(pnpm *)"
      And a profile allowing "cargo"
      When the command is rendered
      Then its value carries "Bash(pnpm *)"
      And its value carries "Bash(cargo *)"

    Scenario: The list it folded in does not linger as a loose argument
      # Taking the old flag out has to take its value with it. A value left
      # behind is a positional argument, and for a CLI that takes its prompt
      # positionally that is the prompt — so the agent would be asked to do
      # "Bash(pnpm *)" instead of the work.
      Given a provider that allows commands with "--allowedTools" as "Bash({command} *)"
      And whose Default already allows "Bash(pnpm *)"
      And a profile allowing "cargo"
      When the command is rendered
      Then no argument is a bare "Bash(pnpm *)"

    Scenario: Denied commands are rendered where a provider has a deny-list
      Given a provider that allows commands with "--allowedTools" as "Bash({command} *)"
      And that denies commands with "--disallowedTools"
      And a profile allowing "git" and denying "git push"
      When the command is rendered
      Then "--disallowedTools" appears once
      And the denied value carries "Bash(git push *)"

    Scenario: A provider's own arguments are appended verbatim
      Given a provider that allows commands with "--allowedTools" as "Bash({command} *)"
      And a profile passing "--disallow-temp-dir" to that provider
      When the command is rendered
      Then the argv carries "--disallow-temp-dir"

    Scenario: A built-in profile renders exactly as it always did
      Given a provider that allows commands with "--allowedTools" as "Bash({command} *)"
      And whose Default already allows "Bash(pnpm *)"
      When the default profile is rendered
      Then "--allowedTools" appears once
      And its value carries "Bash(pnpm *)"
      And its value does not carry "Bash(cargo *)"

  Rule: a provider that cannot honour a profile says so

    Copilot has four coarse switches and Codex expresses nothing at all. A
    profile's commands mean nothing to either, and the dangerous outcome is not
    the absence — it is the absence being silent, which is a flag that reads
    correctly and does nothing.

    Scenario: A provider with no allow-list reports the commands it cannot honour
      Given a provider with no way to allow commands
      And a profile allowing "cargo" and "make"
      Then it reports that it cannot honour the commands
      And what it reports names the provider

    Scenario: A provider with no deny-list reports that too
      Given a provider that allows commands with "--allowedTools" as "Bash({command} *)"
      And a profile allowing "git" and denying "git push"
      Then it reports that it cannot honour the denied commands

    Scenario: A provider that can honour everything reports nothing
      Given a provider that allows commands with "--allowedTools" as "Bash({command} *)"
      And that denies commands with "--disallowedTools"
      And a profile allowing "git" and denying "git push"
      Then it reports nothing it cannot honour

    Scenario: A profile with only provider arguments is honoured by anyone
      # Raw arguments are appended whatever the CLI is; there is nothing to
      # translate and so nothing to be unable to translate.
      Given a provider with no way to allow commands
      And a profile passing "--disallow-temp-dir" to that provider
      Then it reports nothing it cannot honour

  Rule: a profile cannot reach Full Access, whatever it writes

    Full Access is marked on screen the whole time it is on, and that mark is
    the only thing standing between a person and an agent with no boundary. A
    profile that passed the same flags would reach it with no mark at all — so
    the flags that separate the two are refused here, derived from the provider
    rather than listed, so it stays true as descriptors change.

    Derived against **Default**, never against the profile being checked: the
    subtraction that computes the set filters out what the profile itself
    passes, so checking a profile against its own arguments would let it remove
    the very token that would have caught it.

    Scenario: A profile passing the Full Access flag is refused
      Given a provider whose Full Access passes "--yolo"
      And a profile passing "--yolo" to that provider
      Then the profile is refused
      And the refusal names "--yolo"
      And the refusal names the provider

    Scenario: The same flag written with an equals sign is refused too
      Given a provider whose Full Access passes "--mode=bypass"
      And a profile passing "--mode=bypass" to that provider
      Then the profile is refused

    Scenario: A value Full Access passes is refused even without its flag
      # Claude's Full Access is `--permission-mode bypassPermissions`, and
      # Default passes `--permission-mode` too — so the subtraction leaves the
      # bare value. Checking tokens rather than flags is what catches it.
      Given a provider whose Default passes "--mode" and whose Full Access passes "--mode" and "bypass"
      And a profile passing "--mode" and "bypass" to that provider
      Then the profile is refused
      And the refusal names "bypass"

    Scenario: A flag and value joined by an equals sign is refused by its value
      # The shape that gets past a flag-only check. Claude's Full Access is
      # `--permission-mode bypassPermissions` and Default passes
      # `--permission-mode` too, so the separating token is the bare *value* —
      # and `--permission-mode=bypassPermissions` contains neither the token nor
      # a flag in the set. Only splitting on the equals sign and checking both
      # halves catches it.
      Given a provider whose Default passes "--mode" and whose Full Access passes "--mode" and "bypass"
      And a profile passing "--mode=bypass" to that provider
      Then the profile is refused
      And the refusal names "--mode=bypass"

    Scenario: An ordinary argument is not refused
      Given a provider whose Full Access passes "--yolo"
      And a profile passing "--add-dir" to that provider
      Then the profile is allowed

    Scenario: A profile is checked against every installed provider
      Given a provider whose Full Access passes "--yolo"
      And another provider whose Full Access passes "--anything-goes"
      And a profile passing "--anything-goes" to the second provider
      Then the profile is refused

    Scenario: A provider that cannot tell the profiles apart forbids nothing
      # An unmeasured descriptor with one list for both profiles has no
      # separating flags, so there is nothing to derive and nothing to refuse.
      # Saying "this is fine" would be a claim; saying nothing is the truth.
      Given a provider that passes "--same" whatever the profile
      And a profile passing "--same" to that provider
      Then the profile is allowed

  Rule: a command that hands over the filesystem is worth saying out loud

    An interpreter runs whatever it is given, with its own syscalls, which
    `--restricted` cannot confine — `Bash(node *)` was measured writing outside
    the workspace on the first attempt. A profile may still allow one: the whole
    point is that the risk is the author's to take. What it may not do is let
    them take it without noticing.

    Scenario: Allowing an interpreter warns, and still saves
      Given a profile allowing "node"
      Then the profile is allowed
      And it warns that "node" runs whatever it is given

    Scenario: The warning names the measurement
      Given a profile allowing "python3"
      Then it warns that "python3" runs whatever it is given

    Scenario: An ordinary build tool does not warn
      Given a profile allowing "cargo"
      Then the profile is allowed
      And it warns about nothing
