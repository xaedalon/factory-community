Feature: Keeping what happened
  Definitions are files because they are authored, reviewed and committed.
  Tasks, runs and logs are none of those things — they are a record, queried by
  state and written while something else is reading it. So they live in a
  database, and this is the part that has to be boring and correct.

  Migrations get the most attention here for a reason. The prototype had
  fourteen ALTER TABLEs in a try/catch with the errors swallowed and no version
  recorded anywhere, so nobody could say what shape a given database was in —
  only run them all again and hope.

  Scenario: A new database arrives at the latest version
    Given two migrations
    When the store is opened
    Then the database is at version 2
    And both migrations were applied

  Scenario: Opening again applies nothing
    Given two migrations
    And the store has been opened once
    When the store is opened again
    Then no migrations were applied
    And the database is still at version 2

  Scenario: A new migration is applied to an existing database
    Given two migrations
    And the store has been opened once
    When a third migration is added
    And the store is opened again
    Then only the third migration was applied
    And the database is at version 3

  Scenario: A failing migration leaves the previous version intact
    Given two migrations
    And a third migration that throws
    When the store is opened
    Then opening fails
    And the database is left at version 2
    And what the second migration created is still there

  Scenario: A database from a newer Factory is refused
    Given two migrations
    And the store has been opened once
    When the store is opened with only the first migration known
    Then opening fails
    And the error says to upgrade

  Scenario: A gap in the migration sequence is refused
    Given migrations numbered 1 and 3
    When the store is opened
    Then opening fails
    And the error says migrations must have no gaps

  Scenario: A transaction rolls back on failure
    Given a store with a table
    When a transaction inserts a row and then throws
    Then the row is not there

  Scenario: A transaction commits when it returns
    Given a store with a table
    When a transaction inserts a row and returns
    Then the row is there

  Scenario: A nested transaction is refused rather than silently joined
    Given a store with a table
    When a transaction starts another transaction
    Then it fails
    And the error explains that SQLite has no nested transactions

  Scenario: Foreign keys are enforced
    Given a store with two related tables
    When a row references a parent that does not exist
    Then the write is refused

  Scenario: The database is in write-ahead mode
    Given a store with a table
    Then the journal mode is "wal"

  Scenario: Opening creates the directory it needs
    Given a store path inside a directory that does not exist
    When the store is opened
    Then the database file exists

  Rule: a migration that rebuilds a table keeps what referenced it

    SQLite cannot add NOT NULL to a column, so tightening one means rebuilding
    the table: copy, drop, rename. Dropping a table other tables point at, with
    foreign keys on, deletes its rows first — which fires every ON DELETE
    CASCADE hanging off it. A migration meant to tighten one column would take
    every child row with it.

    `PRAGMA foreign_keys` is a no-op inside a transaction, and migrations run in
    one, so a migration cannot turn enforcement off for itself. It says so
    instead, and the harness does it either side of the transaction.

    Scenario: A rebuild keeps the rows that pointed at what it kept
      Given a store with a parent table and children that cascade
      And a migration that rebuilds the parent, declaring that it does
      When the store is opened
      Then the children are still there

    Scenario: A rebuild that does not declare itself loses them
      Given a store with a parent table and children that cascade
      And a migration that rebuilds the parent without declaring it
      When the store is opened
      Then the children are gone

    Scenario: Enforcement is back on afterwards
      Given a store with a parent table and children that cascade
      And a migration that rebuilds the parent, declaring that it does
      When the store is opened
      And a row references a parent that does not exist
      Then the write is refused
