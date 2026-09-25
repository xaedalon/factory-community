Feature: Reading Claude Code's structured transcript

  A supervised run drove ten tasks through Factory and found the same thing
  every time a person looked away: the agent was refused a command, said so in
  its report, and the run finished `completed`. The CLI exits **0** and its own
  last event says `"subtype":"success","is_error":false`, so nothing outside the
  process could tell that the install had not happened.

  `--output-format stream-json` is the way out, because it states the refusal as
  a fact instead of a sentence. Every shape in this file was read off a real run
  against 2.1.281 on 2026-09-24, in a workspace with the Default profile's flags
  and one command deliberately left off the allow-list.

  Matching the *wording* was the obvious alternative and it was measured
  failing: the CLI says "no approval surface" and the agent's own summary of the
  same event said "no approval interface". A pattern on either would have missed
  the run that found this bug.

  Rule: the agent's prose still reaches the log

    Scenario: A text block is logged as it was written
      When the stream says the agent wrote "Installed 412 packages."
      Then the log has "Installed 412 packages." on stdout

    Scenario: The log is what the denial patterns already read
      # The descriptor's wording patterns were written against text-mode
      # output. They keep working because prose is still offered to them.
      When the stream says the agent wrote "Installed 412 packages."
      Then "Installed 412 packages." was offered to the denial scanner

  Rule: a refused command is reported as a refusal, with the command

    Scenario: A denied Bash call names what it was denied
      Given the stream ran "git --version" as "Bash"
      When that call is denied
      Then one refusal was reported
      And the command it names is "git --version"
      And the tool it names is "Bash"
      And it carries the CLI's own words

    Scenario: The denial is visible in the log as well as reported
      # The whole failure mode was invisibility. A line in the log costs
      # nothing and means nobody has to open a run to find out.
      #
      # Asserted on the refusal's own line rather than on the command, because
      # the trace already logs the command when the call is made — an assertion
      # that could not tell the two apart would pass with the refusal deleted.
      Given the stream ran "pnpm install" as "Bash"
      When that call is denied
      Then the log says "pnpm install" was refused

    Scenario: A denied tool that ran no command still reports
      Given the stream used the "WebFetch" tool with no command
      When that call is denied
      Then one refusal was reported
      And it names no command
      And the tool it names is "WebFetch"

    Scenario: A denial for a call the reader never saw still reports
      # The remembered calls are bounded, and a chunk can be lost. Reporting a
      # refusal without its command is worth more than reporting nothing.
      When a call the reader never saw is denied
      Then one refusal was reported
      And it names no command

  Rule: an ordinary failure is not a refusal

    Scenario: The events a run is mostly made of are not refusals
      # `init`, `thinking_tokens` and `rate_limit_event` all arrive as `system`
      # events on an ordinary run. Reading the *type* and not the subtype would
      # turn every one of them into a refusal, and park every run there is.
      When the stream reports the system events an ordinary run emits
      Then no refusal was reported

    Scenario: A command that exits non-zero is not a refusal
      # `is_error` is set by a test suite that fails, and a failing test suite
      # is not a permissions problem. Treating the two alike would park every
      # red build, which is the fastest way to have this feature turned off.
      Given the stream ran "pnpm test" as "Bash"
      When that call fails with "1 test failed"
      Then no refusal was reported

    Scenario: A tool result is read for refusals even though it is not logged
      # This is where the CLI's own wording lives. Before the structured
      # format, the descriptor's patterns only ever saw the agent's summary of
      # it — so this is strictly more than they had.
      Given the stream ran "cat outside.txt" as "Bash"
      When that call fails with "/tmp/probe.txt is outside the configured working directories"
      Then "/tmp/probe.txt is outside the configured working directories" was offered to the denial scanner
      And the log has nothing on stdout

  Rule: output that is not the format is not lost

    Scenario: A line that is not JSON passes through
      # A descriptor edited to drop the flags, a wrapper script, a node
      # warning. Swallowing it would hide exactly what somebody debugging a
      # failed run came to read.
      When the output is the line "npm warn Unknown project config"
      Then the log has "npm warn Unknown project config" on stdout

    Scenario: An event split across two chunks is still read
      Given the stream ran "pnpm install" as "Bash"
      When that call is denied, delivered one character at a time
      Then one refusal was reported
      And the command it names is "pnpm install"

    Scenario: A last line with no newline is read when the process closes
      When the output ends mid-line with the agent writing "Done."
      Then the log has "Done." on stdout
