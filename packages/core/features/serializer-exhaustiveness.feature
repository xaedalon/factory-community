Feature: The writer covers every field the schema accepts
  This is the guard against the defect that motivated the whole definition
  layer. In the prototype the writer was a hand-typed object literal, so every
  field added to the reader afterwards was permanently missing from the writer:
  saving a workflow silently discarded its conditions and its on_fail.

  Nothing connected the two halves, so nothing could notice they had drifted.
  Here the writer is generated from a field table, and this feature asserts the
  table matches the schema. Adding a field to a schema fails the build until
  someone says how to write it — including saying, on purpose, that it is not
  written.

  Scenario: Every workflow schema field has a writer rule
    When the workflow field table is compared to the workflow schema
    Then no schema field is missing from the table
    And no table entry names a field the schema does not accept

  Scenario: Every phase schema field has a writer rule
    When the phase field table is compared to the phase schema
    Then no schema field is missing from the table
    And no table entry names a field the schema does not accept

  Scenario: Every agent schema field has a writer rule
    When the agent field table is compared to the agent schema
    Then no schema field is missing from the table
    And no table entry names a field the schema does not accept

  Scenario: Every profile schema field has a writer rule
    When the profile field table is compared to the profile schema
    Then no schema field is missing from the table
    And no table entry names a field the schema does not accept

  Scenario: Every kind's table was actually compared
    Then every field table this package exports has been checked

  Scenario: Every table entry maps to a real property of the domain type
    Then every workflow table entry names a property the parser produces
    And every phase table entry names a property the parser produces
    And every agent table entry names a property the parser produces
    And every profile table entry names a property the parser produces

  Scenario: A field deliberately left unwritten must say why
    Then every omitted field records a reason
