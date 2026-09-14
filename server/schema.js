// Client ledger (Mijozlar) schema.
//
// Two processes share one SQLite file: the Python bot (SQLAlchemy
// `Base.metadata.create_all`) and this Node server. Either may start first, so
// both must be able to create the schema and both must be no-ops when the other
// already did. Every statement here is therefore idempotent — CREATE TABLE /
// CREATE INDEX IF NOT EXISTS, and try/catch around ALTER TABLE, matching the
// migration idiom already in index.js.
//
// The DDL below is exactly what SQLAlchemy compiles for the models in
// database/models.py against the sqlite dialect (VARCHAR for String, BIGINT for
// BigInteger, DEFAULT CURRENT_TIMESTAMP for server_default=func.now()), so
// whichever process wins the race, the other agrees with what it finds.
// Index names are spelled identically on both sides: create_all skips a table
// that already exists — including its indexes — so a mismatched name would
// leave the ledger with duplicate or missing indexes.
//
// All money columns are INTEGER so'm. No floats anywhere in the money path.

/**
 * Create the client ledger tables and indexes if they are not already present.
 * Safe to call on every startup.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER NOT NULL,
      name VARCHAR NOT NULL,
      phone VARCHAR,
      telegram_chat_id BIGINT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME,
      PRIMARY KEY (id),
      UNIQUE (telegram_chat_id)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS client_prices (
      id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      PRIMARY KEY (id),
      CONSTRAINT uq_client_prices_client_category UNIQUE (client_id, category_id),
      FOREIGN KEY(client_id) REFERENCES clients (id),
      FOREIGN KEY(category_id) REFERENCES product_categories (id)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS client_ledger (
      id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      kind VARCHAR NOT NULL,
      category_id INTEGER,
      qty INTEGER,
      unit_price INTEGER,
      amount INTEGER NOT NULL,
      note VARCHAR,
      performed_by BIGINT,
      performed_by_name VARCHAR,
      reverses_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
      PRIMARY KEY (id),
      FOREIGN KEY(client_id) REFERENCES clients (id),
      FOREIGN KEY(category_id) REFERENCES product_categories (id),
      FOREIGN KEY(reverses_id) REFERENCES client_ledger (id)
    )
  `)

  db.exec('CREATE INDEX IF NOT EXISTS ix_client_prices_client_id ON client_prices (client_id)')
  db.exec('CREATE INDEX IF NOT EXISTS ix_client_ledger_client_id_created_at ON client_ledger (client_id, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS ix_client_ledger_reverses_id ON client_ledger (reverses_id)')

  // SQLite has no ADD COLUMN IF NOT EXISTS; a second run throws "duplicate
  // column name" and that is the success case on an already-migrated file.
  try { db.exec('ALTER TABLE product_categories ADD COLUMN default_price INTEGER') } catch {}
}
