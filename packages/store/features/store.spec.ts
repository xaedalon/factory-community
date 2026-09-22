import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentVersion, openDatabase, openStore, type Migration, type Store } from '../src/index.js'

const feature = await loadFeature(fileURLToPath(new URL('./store.feature', import.meta.url)))

/** Migrations belonging to this suite, so the real ones can change freely. */
const first: Migration = {
  version: 1,
  describe: 'create widgets',
  up: (db) => db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'),
}
const second: Migration = {
  version: 2,
  describe: 'add widgets.colour',
  up: (db) => db.exec('ALTER TABLE widgets ADD COLUMN colour TEXT'),
}
const third: Migration = {
  version: 3,
  describe: 'create gadgets',
  up: (db) => db.exec('CREATE TABLE gadgets (id INTEGER PRIMARY KEY)'),
}
const throws: Migration = {
  version: 3,
  describe: 'deliberately broken',
  up: () => {
    throw new Error('this migration is broken')
  },
}

describeFeature(feature, ({ Scenario, Rule, BeforeEachScenario, AfterEachScenario }) => {
  let root = ''
  let file = ''
  let migrations: Migration[] = []
  let store: Store | undefined
  let failure: unknown
  let thrownInTransaction: unknown

  BeforeEachScenario(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-store-'))
    file = join(root, 'state', 'factory.db')
    migrations = []
    store = undefined
    failure = undefined
    thrownInTransaction = undefined
  })
  AfterEachScenario(() => {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  })

  const open = (list = migrations) => {
    try {
      store = openStore({ file, migrations: list })
    } catch (error) {
      failure = error
      store = undefined
    }
  }
  const reopen = (list = migrations) => {
    store?.close()
    store = undefined
    open(list)
  }
  const message = () => (failure instanceof Error ? failure.message : String(failure))

  /**
   * Inspect the file without migrating it.
   *
   * Deliberately `openDatabase` rather than `openStore`: opening the store with
   * an empty migration list would trip the "newer than this build" guard, which
   * is the guard working — a probe has no business migrating anything.
   */
  const inspect = <T>(read: (db: ReturnType<typeof openDatabase>) => T): T => {
    const db = openDatabase(file)
    try {
      return read(db)
    } finally {
      db.close()
    }
  }

  const withTable = () => {
    migrations = [first]
    open()
  }

  Scenario('A new database arrives at the latest version', ({ Given, When, Then, And }) => {
    Given('two migrations', () => {
      migrations = [first, second]
    })
    When('the store is opened', () => open())
    Then('the database is at version 2', () => expect(currentVersion(store!.db)).toBe(2))
    And('both migrations were applied', () => expect(store!.migration.applied).toHaveLength(2))
  })

  Scenario('Opening again applies nothing', ({ Given, And, When, Then }) => {
    Given('two migrations', () => {
      migrations = [first, second]
    })
    And('the store has been opened once', () => open())
    When('the store is opened again', () => reopen())
    Then('no migrations were applied', () => expect(store!.migration.applied).toHaveLength(0))
    And('the database is still at version 2', () => expect(currentVersion(store!.db)).toBe(2))
  })

  Scenario('A new migration is applied to an existing database', ({ Given, And, When, Then }) => {
    Given('two migrations', () => {
      migrations = [first, second]
    })
    And('the store has been opened once', () => open())
    When('a third migration is added', () => {
      migrations = [first, second, third]
    })
    And('the store is opened again', () => reopen())
    Then('only the third migration was applied', () => {
      expect(store!.migration.applied.map((entry) => entry.version)).toEqual([3])
    })
    And('the database is at version 3', () => expect(currentVersion(store!.db)).toBe(3))
  })

  Scenario('A failing migration leaves the previous version intact', ({ Given, And, When, Then }) => {
    Given('two migrations', () => {
      migrations = [first, second]
    })
    And('a third migration that throws', () => {
      migrations = [first, second, throws]
    })
    When('the store is opened', () => open())
    Then('opening fails', () => expect(failure).toBeDefined())
    // Each migration is its own transaction, so a failure leaves the database
    // at the last version that fully applied — a state someone can act on.
    And('the database is left at version 2', () =>
      expect(inspect((db) => currentVersion(db))).toBe(2),
    )
    And('what the second migration created is still there', () =>
      expect(() =>
        inspect((db) => db.run("INSERT INTO widgets (name, colour) VALUES ('a', 'red')")),
      ).not.toThrow(),
    )
  })

  Scenario('A database from a newer Factory is refused', ({ Given, And, When, Then }) => {
    Given('two migrations', () => {
      migrations = [first, second]
    })
    And('the store has been opened once', () => open())
    When('the store is opened with only the first migration known', () => reopen([first]))
    Then('opening fails', () => expect(failure).toBeDefined())
    And('the error says to upgrade', () => expect(message()).toContain('upgrade'))
  })

  Scenario('A gap in the migration sequence is refused', ({ Given, When, Then, And }) => {
    Given('migrations numbered 1 and 3', () => {
      migrations = [first, third]
    })
    When('the store is opened', () => open())
    Then('opening fails', () => expect(failure).toBeDefined())
    And('the error says migrations must have no gaps', () => expect(message()).toContain('no gaps'))
  })

  Scenario('A transaction rolls back on failure', ({ Given, When, Then }) => {
    Given('a store with a table', withTable)
    When('a transaction inserts a row and then throws', () => {
      try {
        store!.db.transaction(() => {
          store!.db.run("INSERT INTO widgets (name) VALUES ('rolled-back')")
          throw new Error('nope')
        })
      } catch (error) {
        thrownInTransaction = error
      }
    })
    Then('the row is not there', () => {
      expect(thrownInTransaction).toBeDefined()
      expect(store!.db.all('SELECT * FROM widgets')).toHaveLength(0)
    })
  })

  Scenario('A transaction commits when it returns', ({ Given, When, Then }) => {
    Given('a store with a table', withTable)
    When('a transaction inserts a row and returns', () => {
      store!.db.transaction(() => store!.db.run("INSERT INTO widgets (name) VALUES ('kept')"))
    })
    Then('the row is there', () => expect(store!.db.all('SELECT * FROM widgets')).toHaveLength(1))
  })

  Scenario('A nested transaction is refused rather than silently joined', ({ Given, When, Then, And }) => {
    Given('a store with a table', withTable)
    When('a transaction starts another transaction', () => {
      try {
        store!.db.transaction(() => store!.db.transaction(() => undefined))
      } catch (error) {
        thrownInTransaction = error
      }
    })
    Then('it fails', () => expect(thrownInTransaction).toBeDefined())
    And('the error explains that SQLite has no nested transactions', () =>
      expect(String((thrownInTransaction as Error).message)).toContain('no nested transactions'),
    )
  })

  Rule('a migration that rebuilds a table keeps what referenced it', ({ RuleScenario }) => {
    /**
     * A parent with a cascading child, and one row in each.
     *
     * The child is what the rebuild is allowed to lose or keep, so it is the
     * only thing these scenarios read back.
     */
    const seeded: Migration = {
      version: 1,
      describe: 'a parent and a cascading child',
      up: (db) => {
        db.exec('CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
        db.exec(
          'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL ' +
            'REFERENCES parents(id) ON DELETE CASCADE)',
        )
        db.run('INSERT INTO parents (id, name) VALUES (1, ?)', 'kept')
        db.run('INSERT INTO children (id, parent_id) VALUES (1, 1)')
      },
    }

    /** The rebuild every table-tightening migration has to perform. */
    const rebuild = (declared: boolean): Migration => ({
      version: 2,
      describe: 'rebuild parents with a tighter column',
      ...(declared ? { rebuildsForeignKeys: true } : {}),
      up: (db) => {
        db.exec('CREATE TABLE parents_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
        db.exec('INSERT INTO parents_new SELECT id, name FROM parents')
        db.exec('DROP TABLE parents')
        db.exec('ALTER TABLE parents_new RENAME TO parents')
      },
    })

    const children = () =>
      store?.db.get<{ n: number }>('SELECT count(*) AS n FROM children')?.n ?? -1

    RuleScenario('A rebuild keeps the rows that pointed at what it kept', ({ Given, And, When, Then }) => {
      Given('a store with a parent table and children that cascade', () => {
        migrations = [seeded]
      })
      And('a migration that rebuilds the parent, declaring that it does', () => {
        migrations = [seeded, rebuild(true)]
      })
      When('the store is opened', () => open())
      Then('the children are still there', () => expect(children()).toBe(1))
    })

    RuleScenario('A rebuild that does not declare itself loses them', ({ Given, And, When, Then }) => {
      Given('a store with a parent table and children that cascade', () => {
        migrations = [seeded]
      })
      // The mutation this rule exists for, run as a scenario: the same rebuild
      // without the declaration, so the loss is specified rather than feared.
      And('a migration that rebuilds the parent without declaring it', () => {
        migrations = [seeded, rebuild(false)]
      })
      When('the store is opened', () => open())
      Then('the children are gone', () => expect(children()).toBe(0))
    })

    RuleScenario('Enforcement is back on afterwards', ({ Given, And, When, Then }) => {
      Given('a store with a parent table and children that cascade', () => {
        migrations = [seeded]
      })
      And('a migration that rebuilds the parent, declaring that it does', () => {
        migrations = [seeded, rebuild(true)]
      })
      When('the store is opened', () => open())
      And('a row references a parent that does not exist', () => {
        try {
          store?.db.run('INSERT INTO children (id, parent_id) VALUES (2, 404)')
          thrownInTransaction = undefined
        } catch (error) {
          thrownInTransaction = error
        }
      })
      Then('the write is refused', () => expect(thrownInTransaction).toBeInstanceOf(Error))
    })
  })

  Scenario('Foreign keys are enforced', ({ Given, When, Then }) => {
    Given('a store with two related tables', () => {
      migrations = [
        {
          version: 1,
          describe: 'related tables',
          up: (db) => {
            db.exec('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
            db.exec('CREATE TABLE children (parent_id INTEGER REFERENCES parents(id))')
          },
        },
      ]
      open()
    })
    // Off by default in SQLite, which makes every foreign key decorative.
    When('a row references a parent that does not exist', () => {
      try {
        store!.db.run('INSERT INTO children (parent_id) VALUES (99)')
      } catch (error) {
        thrownInTransaction = error
      }
    })
    Then('the write is refused', () => expect(thrownInTransaction).toBeDefined())
  })

  Scenario('The database is in write-ahead mode', ({ Given, Then }) => {
    Given('a store with a table', withTable)
    Then('the journal mode is "wal"', () => {
      const row = store!.db.get<{ journal_mode: string }>('PRAGMA journal_mode')
      expect(row?.journal_mode).toBe('wal')
    })
  })

  Scenario('Opening creates the directory it needs', ({ Given, When, Then }) => {
    Given('a store path inside a directory that does not exist', () => {
      file = join(root, 'deeply', 'nested', 'factory.db')
      migrations = [first]
    })
    When('the store is opened', () => open())
    Then('the database file exists', () => expect(existsSync(file)).toBe(true))
  })
})
