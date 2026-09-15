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

  // /ulash handshake codes. The bot (Python) creates this table lazily on first
  // use; declaring it here too means a redeem from the server side works even if
  // nobody has run /ulash yet. DDL is kept identical to handlers/groups.py.
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_link_codes (
      code       TEXT PRIMARY KEY,
      chat_id    INTEGER NOT NULL,
      title      TEXT,
      expires_at DATETIME NOT NULL,
      used_at    DATETIME NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS ix_group_link_codes_chat_id ON group_link_codes (chat_id)')

  // ─── Receipt posts (DISPLAY BOOKKEEPING — outside the ledger) ───────────────
  //
  // A correction must EDIT the receipt it corrects, and editMessageMedia needs
  // chat_id + message_id. These two tables are the only place that mapping
  // lives. They are display state, not money: no column here feeds SUM(amount),
  // no route computes a balance from them, and DROP TABLE on both leaves every
  // balance in the system bit-for-bit identical. That is how "the ledger stays
  // append-only" is satisfied by construction rather than by discipline.
  //
  // Node-only, with no mirror in database/models.py. That is the one deliberate
  // exception to this file's Python-parity contract: only the Node server posts
  // receipts, and SQLAlchemy's create_all ignores tables it has no model for, so
  // whichever process wins the create race the other still agrees on everything
  // it knows about. (group_link_codes is the same exception in reverse — declared
  // here, owned by handlers/groups.py.)
  //
  // ONE MOVEMENT WRITES MANY ROWS AND POSTS ONE MESSAGE, so the row→message
  // mapping is a join table. A message_id column on client_ledger would have to
  // be repeated across 50 rows AND would put display state inside the
  // append-only table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS receipt_posts (
      id          INTEGER NOT NULL,
      client_id   INTEGER NOT NULL,
      chat_id     BIGINT  NOT NULL,
      kind        VARCHAR NOT NULL,
      message_id  BIGINT,
      is_photo    INTEGER NOT NULL DEFAULT 0,
      state       VARCHAR NOT NULL DEFAULT 'pending',
      snapshot    VARCHAR,
      caption     VARCHAR,
      stamped_ids VARCHAR,
      stamped_at  DATETIME,
      last_error  VARCHAR,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
      PRIMARY KEY (id),
      FOREIGN KEY(client_id) REFERENCES clients (id)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS receipt_post_rows (
      ledger_id INTEGER NOT NULL,
      post_id   INTEGER NOT NULL,
      ord       INTEGER NOT NULL,
      PRIMARY KEY (ledger_id),
      FOREIGN KEY(ledger_id) REFERENCES client_ledger (id),
      FOREIGN KEY(post_id)   REFERENCES receipt_posts (id)
    )
  `)

  db.exec('CREATE INDEX IF NOT EXISTS ix_receipt_post_rows_post_id ON receipt_post_rows (post_id)')
  db.exec('CREATE INDEX IF NOT EXISTS ix_receipt_posts_client_id ON receipt_posts (client_id, id)')
}
