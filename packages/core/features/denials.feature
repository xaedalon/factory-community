Feature: Noticing that an agent was refused something

  The Default profile confines an agent by handing its CLI the flags that
  confine it. That works — it was measured — and it moves the refusal *inside*
  the agent, where Factory cannot see it.

  The plan for this increment assumed a refusal would fail the step. Running the
  real CLI showed otherwise: `claude -p` **exits 0** and reports the refusal in
  prose. The step succeeds, the run completes, and the work did not happen. So
  the only signal is the words, and the patterns are data on the provider
  descriptor — because what a refusal looks like is that CLI's business, and a
  third party must be able to say so without a core change.

  The strings in these scenarios are not invented. They were observed by running
  Claude Code 2.1.273 against a confined workspace on 2026-09-15.

  Scenario: Nothing is found when nothing was refused
    Given the patterns Factory ships for Claude
    When the agent's output is "Wrote inside.txt. All done."
    Then no refusal was found

  Scenario: A refusal naming the path it refused is found, with the path
    Given the patterns Factory ships for Claude
    When the agent's output is "/tmp/probe.txt is outside the configured working directories"
    Then one refusal was found
    And it is a "path-outside-workspace"
    And the path it names is "/tmp/probe.txt"
    And it carries the line it was found in

  Scenario: The other observed wording is recognised without a path
    Given the patterns Factory ships for Claude
    When the agent's output is "outside /repos/app; --restricted confines the file tools to the working directory."
    Then one refusal was found
    And it is a "file-tools-confined"
    # It names the *working directory*, not the path that was refused, so
    # capturing it would offer to grant a directory the agent already had.
    And it names no path

  Scenario: The same refusal twice is one refusal
    Given the patterns Factory ships for Claude
    When the agent's output refuses the same path twice
    # An agent refused eleven times has one problem, not eleven.
    Then one refusal was found

  Rule: a pattern split across two chunks of output is still found

    Output arrives from a pipe in whatever pieces the operating system feels
    like. Scanning each piece alone would miss anything that straddles a
    boundary, and keeping everything would hold a whole agent transcript in
    memory for the length of a run.

    Scenario: A refusal broken in half is found
      Given the patterns Factory ships for Claude
      When the output arrives as "/tmp/probe.txt is outsi" then "de the working directory"
      Then one refusal was found
      And the path it names is "/tmp/probe.txt"

    Scenario: Output far larger than the scan window still finds a late refusal
      Given the patterns Factory ships for Claude
      When 200 kilobytes of chatter arrive, then a refusal
      Then one refusal was found
      # A bound, not decoration. The first implementation kept a 64 KiB rolling
      # tail and ran an unbounded capture group over all of it on every chunk,
      # and this scenario did not fail — it stopped responding, for longer than
      # the whole suite is allowed to take. Scanning has to be linear in the
      # output, and a wall-clock ceiling is the only assertion that says so.
      And the scan took well under a second

    Scenario: A refusal older than the scan window is still remembered
      Given the patterns Factory ships for Claude
      When a refusal arrives, then 200 kilobytes of chatter
      # Found when it arrived, and a found refusal is kept — the window bounds
      # memory, not history.
      Then one refusal was found

  Rule: a provider that says nothing detects nothing

    Scenario: No patterns means no work and no findings
      Given a provider with no patterns
      When the agent's output is "/tmp/probe.txt is outside the configured working directories"
      Then no refusal was found
      And the scanner reports itself as idle

  Rule: a broken pattern does not break the run

    A descriptor is data, and data can be wrong. An unparseable regular
    expression is a descriptor problem; losing the run over it would make it
    everybody's problem.

    Scenario: A pattern that will not compile is skipped
      Given a provider whose pattern is not a valid expression
      When the agent's output is "/tmp/probe.txt is outside the configured working directories"
      Then no refusal was found

    Scenario: A broken pattern does not stop a good one beside it
      Given a provider with one broken pattern and one that works
      When the agent's output is "/tmp/probe.txt is outside the configured working directories"
      Then one refusal was found

  Rule: the message says what to do about it

    A refusal a person cannot act on is just bad news. The remedy names the
    directory when the refusal named one, because a directory is exactly what
    Factory can grant.

    Scenario: A refusal with a path offers to allow that path
      Given the patterns Factory ships for Claude
      When the agent's output is "/tmp/probe.txt is outside the configured working directories"
      And I ask what to tell the reader
      Then the message names "/tmp/probe.txt"
      And the message offers to allow it for this project
      And the message mentions "Full Access"

    Scenario: A refusal without a path still offers a way forward
      Given the patterns Factory ships for Claude
      When the agent's output is "outside /repos/app; --restricted confines the file tools to the working directory."
      And I ask what to tell the reader
      Then the message offers to allow it for this project

  Rule: a refusal a provider stated outright names the command

    The wording patterns can only read prose, and prose does not carry the
    command. A provider that emits a structured transcript says it as a fact —
    and that changes what happens next, because a refused *command* means an
    install or a test did not run, while a refused *path* may leave the work
    done.

    Scenario: A refused command is carried through to the refusal
      When the provider reports that "pnpm install" was refused
      Then the refusal names the command "pnpm install"
      And it carries the provider's own words

    Scenario: Two refusals of the same executable are one problem
      # The remedy is one allow-list entry, and telling somebody twice is
      # telling them wrong.
      When the provider reports that "pnpm install" was refused
      And the provider reports that "pnpm test" was refused
      Then both refusals have the same id

    Scenario: Two different executables are two problems
      When the provider reports that "pnpm install" was refused
      And the provider reports that "docker compose up" was refused
      Then the refusals have different ids

    Scenario: A refused tool that ran no command still says what it was
      When the provider reports that the "WebFetch" tool was refused
      Then the refusal names no command
      And its description names "WebFetch"

    Scenario: The message for a command says the work did not happen
      # The consequence is the part a person most needs told: everything the
      # agent reported after this point was reported without it.
      When the provider reports that "pnpm install" was refused
      And I ask what to tell the reader
      Then the message names "pnpm install"
      And the message says that command did not run
      And the message mentions "Full Access"
