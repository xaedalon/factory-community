import type { Database } from './sqlite.js'

/**
 * Versioned migrations.
 *
 * The prototype had fourteen `ALTER TABLE`s in a try/catch with the errors
 * swallowed and no version recorded anywhere, so there was no way to answer
 * "what shape is this database in?" — only to run them all again and hope. A
 * migration that cannot be reasoned about is worse than a schema change nobody
 * made.
 *
 * So: an ordered list, a version stamped in the file itself, and each migration
 * applied inside a transaction. A database is either fully at a version or
 * unchanged; there is no halfway.
 */

export interface Migration {
  /** Sequential from 1, with no gaps. Checked, because a gap means a lost file. */
  readonly version: number
  /** What it does, shown by `factory doctor` and in the migration log. */
  readonly describe: string
  /**
   * Set when `up` rebuilds a table that other tables reference.
   *
   * SQLite cannot add `NOT NULL` to an existing column, so tightening one means
   * the twelve-step rebuild: create, copy, drop, rename. `DROP TABLE` with
   * foreign keys on deletes the old table's rows first, and that fires every
   * `ON DELETE CASCADE` pointing at it — so rebuilding `tasks` to tighten one
   * column would take every run, step, log and history row with it. Measured,
   * not feared: the scenario that leaves this flag off watches the children
   * disappear.
   *
   * It cannot be done inside `up`. `PRAGMA foreign_keys` is a no-op once a
   * transaction is open, and every migration runs in one, so a migration can
   * only *declare* that it needs enforcement off and let the harness bracket the
   * transaction with it.
   */
  readonly rebuildsForeignKeys?: boolean
  /**
   * Returns a note when there is something the operator has to know.
   *
   * A schema change is silent by design — it applied or it did not, and the
   * version says which. One that deletes somebody's rows is a one-way door
   * running unattended when a daemon starts, and "it is in the schema" is not
   * telling them.
   */
  up(db: Database): void | string
}

export interface MigrationOutcome {
  readonly from: number
  readonly to: number
  readonly applied: readonly { version: number; describe: string; note?: string }[]
}

export function currentVersion(db: Database): number {
  const row = db.get<{ user_version: number }>('PRAGMA user_version')
  return row?.user_version ?? 0
}

/**
 * Bring a database up to the latest migration.
 *
 * Refuses to touch a database newer than the code, because an older Factory
 * cannot know what a newer one added — and guessing would corrupt it. Telling
 * someone to upgrade is the only honest answer.
 */
export function migrate(db: Database, migrations: readonly Migration[]): MigrationOutcome {
  assertWellFormed(migrations)

  const from = currentVersion(db)
  const latest = migrations.at(-1)?.version ?? 0

  if (from > latest) {
    throw new Error(
      `This database is at version ${from}, but this build only knows up to ${latest}. ` +
        `It was written by a newer Factory — upgrade rather than running this one against it.`,
    )
  }

  const applied: { version: number; describe: string; note?: string }[] = []
  for (const migration of migrations) {
    if (migration.version <= from) continue
    // Outside the transaction, because that is the only place it does anything —
    // see `rebuildsForeignKeys`. Restored in a `finally` so a migration that
    // throws does not leave the connection with its foreign keys switched off,
    // which would turn every later write into one nothing checks.
    if (migration.rebuildsForeignKeys === true) db.exec('PRAGMA foreign_keys = OFF')
    let note: string | undefined
    try {
      // Each migration is its own transaction: a failure leaves the database at
      // the last version that fully applied, which is a state someone can act on.
      db.transaction(() => {
        const said = migration.up(db)
        if (typeof said === 'string') note = said
        // PRAGMA will not take a bound parameter, and the value is a validated
        // integer from our own list rather than anything a caller supplied.
        db.exec(`PRAGMA user_version = ${migration.version}`)
      })
    } finally {
      if (migration.rebuildsForeignKeys === true) db.exec('PRAGMA foreign_keys = ON')
    }
    applied.push({
      version: migration.version,
      describe: migration.describe,
      ...(note === undefined ? {} : { note }),
    })
  }

  return { from, to: currentVersion(db), applied }
}

function assertWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    const expected = index + 1
    if (migration.version !== expected) {
      // A gap or a duplicate almost always means a file was lost in a merge, and
      // silently skipping it would leave two databases claiming the same version
      // with different schemas.
      throw new Error(
        `Migration ${migration.version} ("${migration.describe}") is out of sequence — ` +
          `expected ${expected}. Migrations must be numbered from 1 with no gaps.`,
      )
    }
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(`Migration version must be a positive integer, got ${migration.version}.`)
    }
  })
}
