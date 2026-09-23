Feature: Speaking MCP
  An MCP client starts `factory mcp` and talks to it down a pipe: one JSON-RPC
  message per line, stdin in, stdout out. Nothing about that is negotiable, and
  the two things it is easy to get wrong are both fatal rather than untidy.

  The first is stdout. A banner, a warning, a stray `console.log` — anything
  that is not a frame lands in the middle of the stream and the session is over
  with an error the person reads as "Factory is broken". So the only thing this
  server writes to its output is a frame, and everything else goes to stderr,
  which every client either shows or ignores.

  The second is dying. A server that throws on a bad line takes the pipe with
  it, and the client waits on something that will never speak again. Every
  malformed frame is therefore *answered* — with an id when the frame carried
  one, and with `null` when it did not, which is what JSON-RPC says to do with a
  request nobody can match.

  The protocol version is negotiated rather than asserted. The specification
  says a server asked for a version it does not have answers with one it does,
  and the client decides whether that will do. The list is written down here so
  that a new revision is a deliberate edit with a scenario behind it.

  Background:
    Given a Factory with one project "factory"
    And an MCP server over it

  Scenario: The handshake says what this server is and what it can do
    When the client initializes
    Then the server calls itself "factory"
    And it offers tools
    And it says what Factory is for

  Scenario: A version the server speaks is the one agreed
    When the client initializes asking for "2025-06-18"
    Then the agreed version is "2025-06-18"

  Scenario: A version the server does not speak is answered with one it does
    # Answering "no" would be the other reading, and it is the wrong one: the
    # client is the party that decides whether an older revision will do.
    When the client initializes asking for "1999-01-01"
    Then the agreed version is the newest this server speaks

  Scenario: Every tool is listed with a schema a client can check against
    When the client lists the tools
    Then every tool has a name, a description and an object schema
    And the first tool is "factory_project_current"

  Scenario: A tool's answer arrives as text and as structure
    When the client calls "factory_project_list"
    Then the answer is not an error
    And the text of it parses as JSON
    And the structured copy says the same thing

  Scenario: A ping is answered
    When the client pings
    Then the reply is empty and carries the same id

  Rule: a bad frame is answered, never thrown

    Every one of these used to be a crash in some server somebody shipped. The
    client cannot tell a crashed server from a slow one, so it waits.

    Scenario: A line that is not JSON is a parse error
      When the client sends "not json at all"
      Then the reply is an error with code -32700
      And the reply has no id

    Scenario: A frame with the wrong protocol version keeps its id
      When the client sends a frame claiming JSON-RPC "1.0"
      Then the reply is an error with code -32600
      And the reply carries the id that was sent

    Scenario: A method this server does not have says so
      When the client calls the method "resources/list"
      Then the reply is an error with code -32601
      And the message says this server serves tools

    Scenario: A notification is answered with nothing at all
      # A reply a client cannot match to a request is a fault, so silence is
      # the protocol rather than an optimisation.
      When the client notifies "notifications/initialized"
      Then there is no reply

    Scenario: An unknown tool says where the list is
      When the client calls "factory_teleport"
      Then the reply is an error with code -32602
      And the message says to call tools/list

    Scenario: Arguments that do not fit the schema name the field
      When the client calls "factory_run_logs" with a tail of "lots"
      Then the reply is an error with code -32602
      And the message names "tail"

    Scenario: A tool Factory refused is a result, not a protocol error
      # The request was well formed and the answer is "Factory said no". A
      # protocol error here reaches the model as a transport fault, which is
      # the one reading that suggests retrying.
      Given the daemon is not running
      When the client calls "factory_project_list"
      Then the answer is an error result
      And it says the daemon is not running
      And it tells the agent to ask a person to start it

  Rule: stdout carries the protocol and nothing else

    Scenario: Frames go to the output stream, one per line
      When the client sends a ping and a tools/list down the pipe
      Then two frames came back, one per line
      And nothing was written to the error stream

    Scenario: Two frames in one chunk are both answered
      When both frames arrive in a single chunk
      Then two frames came back, one per line

    Scenario: A frame split across two chunks is answered once it is whole
      When one frame arrives in two pieces
      # Counting frames is not enough: a server that threw the first piece away
      # answers the second one with a parse error, which is also one frame.
      Then the ping is answered, once

    Scenario: A blank line is ignored
      When the client sends an empty line
      Then nothing came back

    Scenario: A tool that breaks unexpectedly is reported on stderr and answered on stdout
      Given a tool that breaks before it can run
      When the client calls that tool
      Then one frame came back
      And the error stream says what failed
