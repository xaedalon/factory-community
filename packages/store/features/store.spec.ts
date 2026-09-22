import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MIGRATIONS,
  currentVersion,
  openDatabase,
  openStore,
  type Migration,
  type Store,
} from '../src/index.js'

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

  const open = (list: readonly Migration[] = migrations) => {
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

  Rule('a migration can say what it did', ({ RuleScenario }) => {
    RuleScenario('A migration that reports something carries it out to the caller', ({
      Given,
      When,
      Then,
    }) => {
      Given('a migration that deletes rows and says how many', () => {
        migrations = [
          first,
          {
            version: 2,
            describe: 'tidy up',
            up: (db) => {
              db.run('INSERT INTO widgets (id, name) VALUES (1, ?)', 'doomed')
              const gone = db.run('DELETE FROM widgets').changes
              return `deleted ${gone} widget(s)`
            },
          },
        ]
      })
      When('the store is opened', () => open())
      Then('the outcome carries that note', () =>
        expect(store?.migration.applied.at(-1)?.note).toBe('deleted 1 widget(s)'),
      )
    })

    RuleScenario('A migration with nothing to say carries no note', ({ Given, When, Then }) => {
      Given('two migrations', () => {
        migrations = [first, second]
      })
      When('the store is opened', () => open())
      Then('no note is carried', () =>
        expect(store?.migration.applied.every((entry) => entry.note === undefined)).toBe(true),
      )
    })
  })
  /**
   * The real migrations, unlike everything above.
   *
   * This Rule is about migration 17 itself rather than about the harness, so it
   * has to be the shipped list: a synthetic pair would prove the mechanism
   * works and nothing about whether that migration does.
   */
  Rule('upgrading an installation that has tasks in no project', ({ RuleScenario }) => {
    const upTo = (version: number) => MIGRATIONS.filter((entry) => entry.version <= version)
    /** Seeded before a task needed a project, so the columns are that era's. */
    const seedAtSixteen = (): void => {
      const before = openStore({ file, migrations: upTo(16) })
      const db = before.db
      db.run(
        `INSERT INTO projects (id, name, path, default_branch, worktrees_root, created_at)
         VALUES ('pr-1', 'work', '/repos/work', 'main', '/worktrees/work', '2026-01-01T00:00:00Z')`,
      )
      // One in a project, one in none, each with a row in every table that
      // points at `tasks` — which is what the rebuild has to leave alone.
      for (const [id, project] of [
        ['owned', "'pr-1'"],
        ['orphan', 'NULL'],
      ] as const) {
        db.run(
          `INSERT INTO tasks (id, name, state, created_at, updated_at, project_id)
           VALUES ('${id}', '${id}', 'draft', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ${project})`,
        )
        db.run(
          `INSERT INTO runs (id, task_id, workflow, state, started_at)
           VALUES ('run-${id}', '${id}', 'hello', 'done', '2026-01-01T00:00:00Z')`,
        )
        db.run(
          `INSERT INTO run_steps (id, run_id, phase, step_index, describe, uses, state, started_at)
           VALUES (${id === 'owned' ? 1 : 2}, 'run-${id}', 'greet', 0, 'echo', 'run', 'done', '2026-01-01T00:00:00Z')`,
        )
        db.run(
          `INSERT INTO run_logs (run_id, step_id, at, stream, text, bytes)
           VALUES ('run-${id}', ${id === 'owned' ? 1 : 2}, '2026-01-01T00:00:00Z', 'stdout', 'hi', 2)`,
        )
        db.run(
          `INSERT INTO run_evidence (run_id, phase, name, path, bytes, collected_at)
           VALUES ('run-${id}', 'greet', 'notes', '/tmp/notes.md', 0, '2026-01-01T00:00:00Z')`,
        )
        db.run(`INSERT INTO task_workflows (task_id, position, workflow) VALUES ('${id}', 0, 'hello')`)
        // The one that was missed when this migration was first written: its
        // absence from the cleanup only shows up on a task that has a flag.
        db.run(
          `INSERT INTO task_flags (task_id, flag, set_at) VALUES ('${id}', 'hasWorktree', '2026-01-01T00:00:00Z')`,
        )
        db.run(
          `INSERT INTO task_history (task_id, at, action, from_state, to_state)
           VALUES ('${id}', '2026-01-01T00:00:00Z', 'queue', 'draft', 'queued')`,
        )
      }
      // An edge each way, so both columns of the dependency table are exercised.
      db.run(`INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ('orphan', 'owned')`)
      before.close()
    }
    const count = (sql: string, ...params: string[]): number =>
      store?.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, ...params)?.n ?? -1

    RuleScenario('A task that belonged to no project is deleted, and said so', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('an installation from before a task needed a project', seedAtSixteen)
      When('it is upgraded', () => open(MIGRATIONS))
      Then('the task that had no project is gone', () =>
        expect(count('tasks WHERE id = ?', 'orphan')).toBe(0),
      )
      And('nothing recorded about it is left behind', () => {
        expect(count('runs WHERE task_id = ?', 'orphan')).toBe(0)
        expect(count('run_steps WHERE run_id = ?', 'run-orphan')).toBe(0)
        expect(count('run_logs WHERE run_id = ?', 'run-orphan')).toBe(0)
        expect(count('run_evidence WHERE run_id = ?', 'run-orphan')).toBe(0)
        expect(count('task_workflows WHERE task_id = ?', 'orphan')).toBe(0)
        expect(count('task_flags WHERE task_id = ?', 'orphan')).toBe(0)
        expect(count('task_history WHERE task_id = ?', 'orphan')).toBe(0)
        expect(count('task_dependencies WHERE task_id = ?', 'orphan')).toBe(0)
      })
      And('the upgrade says it deleted 1 task', () =>
        expect(store?.migration.applied.at(-1)?.note).toContain('deleted 1 task'),
      )
    })

    RuleScenario('A task that had a project keeps everything it recorded', ({
      Given,
      When,
      Then,
      And,
    }) => {
      Given('an installation from before a task needed a project', seedAtSixteen)
      When('it is upgraded', () => open(MIGRATIONS))
      Then('the task in a project is still there', () =>
        expect(count('tasks WHERE id = ?', 'owned')).toBe(1),
      )
      // The whole reason the migration switches foreign keys off: dropping
      // `tasks` with them on deletes every one of these first.
      And('its run, step, log, artifact, flag, history and dependency are still there', () => {
        expect(count('runs WHERE task_id = ?', 'owned')).toBe(1)
        expect(count('run_steps WHERE run_id = ?', 'run-owned')).toBe(1)
        expect(count('run_logs WHERE run_id = ?', 'run-owned')).toBe(1)
        expect(count('run_evidence WHERE run_id = ?', 'run-owned')).toBe(1)
        expect(count('task_workflows WHERE task_id = ?', 'owned')).toBe(1)
        expect(count('task_flags WHERE task_id = ?', 'owned')).toBe(1)
        expect(count('task_history WHERE task_id = ?', 'owned')).toBe(1)
      })
      And('no foreign key is violated', () =>
        expect(store?.db.all('PRAGMA foreign_key_check')).toHaveLength(0),
      )
    })
  })
})
