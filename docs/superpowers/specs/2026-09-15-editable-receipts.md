# Editable receipts — stamp, never restate

## Decision

FINAL MODEL — STAMP, NEVER RESTATE (winner: stamp-only, 8.3), with the grafts the judges named from the other two and every named weakness fixed.

THE RULE: a posted receipt is a DATED DOCUMENT. A correction edits it exactly once per correction, and the edit is STRICTLY ADDITIVE — it adds red-free black cancellation ink and nothing else. No figure the card ever printed is recomputed, moved in value, or removed. The correction itself posts as a NEW message: the reversal receipt `POST /api/ledger/:entryId/reverse` already posts today (kind 'reversal', AMAL back-reference), now threaded under the card it corrects. One edit, one new post, never a restated delivery card.

WHAT THE GROUP SEES (3 products, 2 625 000, balance 5 725 000; middle product 650 000 reversed 15.09 14:22):

Card A — same message_id, edited in place. JAMI still reads 2 625 000. The stub still reads JAMI QARZ 5 725 000. Row 2 still reads 5 × 130 000 = 650 000. What the edit ADDED: row 2 in C.faint with the existing 0.9px strike across name→sum; a full-width black correction bar below the table reading `BEKOR QILINDI` / `1 ta qator · 15.09.2026 14:22`; a caption whose first line is the cancellation and whose second line is the ORIGINAL caption, struck, verbatim.

Card B — a new message, posted FIRST, with reply_to_message_id = card A's id and allow_sending_without_reply:true. Band BEKOR QILINDI, `AMAL: Berildi · 14.09.2026 15:04`, the one struck product, JAMI 650 000, stub JAMI QARZ 5 075 000 — the only live balance figure in the exchange.

All three reversed: card A carries three struck rows and the bar reversed out (black fill, paper text) reading `BEKOR QILINDI` / `3 ta qator · …` — a wholly void card reads void in a thumbnail. Its JAMI still says 2 625 000 and its stub still says 5 725 000. Three B cards carry the running truth; the last one says 3 100 000.

A client scrolling back weeks later reads, in order: what was delivered on the 14th (card A, intact, one line visibly voided and dated), what was taken back and when (card B, naming card A by kind and stamp, visibly threaded to it), and what is owed now (card B's stub). Each of those three facts has exactly one home and no home is ever overwritten.

WHY THIS AND NOT A RESTATING EDIT — the argument that settles it structurally, before ethics: a Telegram edit can fail, and constraint 3 says a failure must never propagate. Under STAMP a failed edit UNDER-informs — the group is left in exactly today's shipped state, an intact original plus a correctly-posted reversal card, which nobody calls a bug. Under a restating edit a failed edit MISINFORMS — a card still asserting three products and a balance the ledger denies, unmarked, with the client unable to know the document is superseded. A restating design's correctness depends on an unreliable network call succeeding. This one's does not.

Card A's stub going stale is the one thing that is named honestly and not resolved cosmetically: it says what the client owed when that document was issued, which is what a receipt stub is for, and the document dates itself in its own SANA field. Three defences: the bar says the row was cancelled and when; card B is threaded one tap away; card B's stub carries the live balance on the newest message, where the reader's eye already is.

GRAFTS TAKEN FROM THE OTHER TWO MODELS (each was a judge's "strongest" or "weakest" note):
- allow_sending_without_reply on card B (edit-plus-notice). Without it a deleted card A makes Telegram REJECT the one post that must never fail. It must also reach notify.receipt's internal text fallback.
- Reserve inside the transaction, wrapped in try/catch (edit-plus-notice's strongest idea; both other models put it inside tx unguarded and thereby broke constraint 3 — a bookkeeping insert failure rolling back a committed delivery). The reserve is guarded so its failure degrades to "not stampable", never to a 500.
- `is_photo` from `res.photo === true`, never from RECEIPT_IMAGES (all three). Verified: notify.receipt returns `{ok, messageId, photo:true}` only on the sendPhoto path and falls through to `notify(chatId, text)` — which returns no `photo` — on any render or upload failure. Getting this wrong fires editMessageMedia at a text message.
- Stored chat_id for the edit, LIVE `client.telegram_chat_id` for card B (edit-in-place). `POST /api/clients/:id/link` (clients.js:492) nulls telegram_chat_id off whatever client held it and binds it elsewhere; re-reading it at stamp time would edit a stranger's group.
- The `fixed` → `slotCap` pinning rule (stamp-only). `fixed` (receipt-image.js:231) is the ONLY input to slotCap; a plain batch gets slotCap 14, and adding a 22px bar to `fixed` drops it to 13 — silently pushing a named product row into the aggregate. The edit meant to protect the card would delete a line from it.
- Snapshot the RENDER INPUTS, not the ledger joins. `receiptData` takes `category_name`/`parent_name` from a live JOIN on product_categories and `client.name` from a mutable clients row, so a rename would quietly change what an already-issued card prints. This was the latent gap a judge named against the winner; a JSON snapshot closes it and also makes a 50-row stamp cost zero joins.

TWO CORRECTIONS TO THE RECORD, both stated in the losing proposals and both wrong against HEAD:
- RECEIPT_IMAGES is `process.env.RECEIPT_IMAGES !== '0'` (clients.js:49) — DEFAULT ON. Nothing in .env.example, docker-compose.yml, Dockerfile, DEPLOY.md or start.sh sets it, and HEAD is 3333eef "Default receipts back to images". Production is image-first. The `medium`/`is_photo`-from-result mechanism matters MORE with images on, because the photo path degrades to text on any render failure.
- "message is not modified" NEVER fires for editMessageMedia with `attach://` — a re-rendered PNG is a fresh upload every time. On the photo path, which is the default, `stamped_ids` is the ONLY idempotence guard. Do not rely on Telegram to detect a no-op edit.

NOT IN SCOPE, named once and stopped: reversing three rows of one delivery produces three B cards, because the route's contract is one row. A `POST /api/ledger/reverse-batch` taking a list of ids in one transaction would collapse them to one edit and one B card. That is the right fix for noise and it touches nothing decided here. [UNCERTAIN: whether the owner wants one combined correction card per session of corrections — a product call not derivable from the code; the schema below supports either.]

## Schema

ALL DDL GOES IN server/schema.js, inside migrate(), after the group_link_codes block. schema.js is the single owner of DDL; clients.js already calls migrate(db) and index.js calls it again — both are no-ops on a migrated file. Nothing is added to or altered on client_ledger: not one column.

```js
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
```

COLUMN BY COLUMN — why each earns its place:

- `chat_id` is STORED and is the ONLY chat the edit is ever sent to. It is never re-read from clients.telegram_chat_id, because POST /api/clients/:id/link nulls that off the previous holder and binds it elsewhere; an edit must go to the chat the message physically lives in.
- `kind` is 'movement' or 'reversal'. Only 'movement' posts are ever stamp targets: E.isReversal (clients.js:819) forbids reversing a reversal, so a 'reversal' post is recorded solely for reply_to threading and for operator forensics.
- `message_id` is NULL until Telegram answers. **NULL IS THE STATE** for "we do not know whether this message exists" — see CAPTURE in the plan. `state` ('pending' | 'posted' | 'failed' | 'gone') carries the reason.
- `is_photo` is written from the send RESULT (`res.photo === true`), never from RECEIPT_IMAGES, and decides editMessageMedia vs editMessageText.
- `snapshot` is a JSON object holding the RENDER INPUTS of the card as it was posted: `{ client: {name}, entries: [<LEDGER_SELECT rows>], note, balance, orig }`. Inputs, not receiptData's output, because the text stamp path calls formatBatchReceipt, which takes entry-shaped rows and calls productLabel itself. This column is what makes the additive invariant real: `receiptData` derives product names from a live JOIN on product_categories and the client name from a mutable clients row, so without it a category rename would silently change what an already-issued card prints.
- `caption` is what this card's caption said, kept so the stamped caption can carry it verbatim under a strike.
- `stamped_ids` is a sorted CSV of the ledger ids struck by the last edit Telegram accepted. It is the idempotence key, and on the photo path it is the ONLY one — "message is not modified" never fires for editMessageMedia with attach://.
- No `balance` column: it lives in `snapshot`, written in the same single post-commit UPDATE. Having both is drift waiting to happen.
- No `ord` uniqueness games: `PRIMARY KEY (ledger_id)` gives the lookup the reverse route actually makes (row → post) with no extra index, and structurally forbids one ledger row belonging to two posts.

FK NOTE: index.js sets `PRAGMA foreign_keys=ON` (index.js:31). Both FKs are satisfiable because receipt_posts is inserted before receipt_post_rows, and both after the ledger rows, inside the same transaction.

NO BACKFILL, BY DESIGN. Every ledger row written before this migration has no receipt_post_rows row. The reverse route finds no post, stamps nothing, and posts card B exactly as production does today. A message_id that was never captured cannot be recovered — Telegram gives a bot no way to find a message it sent.

## Implementation plan

FOUR FILES, FOUR AGENTS. The cross-file contracts are pinned as literal signatures first, because the interfaces are the only real risk in parallel work. Agents B, C and D can start from the signatures alone; only agent A's DDL is a hard prerequisite for runtime.

════════════════════════════════════════════════════════════════════
PINNED CONTRACTS — copy verbatim, do not renegotiate
════════════════════════════════════════════════════════════════════
receipt-image.js:
  receiptSvg(r)                       // r gains: r.items[i].cancelled?: boolean
                                      //          r.items[i].id?: number  (ignored by renderer)
                                      //          r.correction?: { count, all, at } | null
  HARD RULE: receiptSvg is a STRICT NO-OP when r.correction is null — byte-identical
  output to today for every existing caller. Every stamp re-renders through this
  function, so a change that leaks into the uncorrected path rewrites old cards.

notify.js:
  notify(chatId, text, { replyTo = null } = {})
  notify.receipt(chatId, { svg, caption, text, followUp = null, replyTo = null })
     // replyTo MUST be threaded into the internal `return notify(chatId, text)` fallback
  notify.edit(chatId, messageId, { isPhoto, svg, caption, text })
     // → { ok: true }
     // → { ok: false, permanent: true, error }
     // → { ok: false, error, retryAfter? }
     // never throws
  formatReceipt(entry, balance, orig = null, opts = {})
     // opts: { cancelled?: Set<number>, correction?: { count, at } }
  formatBatchReceipt(entries, balance, opts = {})
     // opts: { note, at, cancelled?: Set<number>, correction?: { count, at } }

receipt-log.js (NEW — pure bookkeeping, imports nothing from clients.js):
  makeReceiptLog({ db, notify, build })  →
    { record, track, settled, settle, forEntry, get, stamp }

clients.js supplies `build`:
  build(post, cancelledIds, correction) → { svg, caption, text, isPhoto }

════════════════════════════════════════════════════════════════════
AGENT A — server/schema.js
════════════════════════════════════════════════════════════════════
Add the two CREATE TABLE blocks and two CREATE INDEX statements from the schema
section, verbatim, inside migrate() after the group_link_codes block. Keep the
comment block: it is the record of why these tables are Node-only against this
file's own Python-parity contract. Touch nothing else. No ALTER on client_ledger.

════════════════════════════════════════════════════════════════════
AGENT B — server/notify.js
════════════════════════════════════════════════════════════════════
B1. `notify(chatId, text, { replyTo = null } = {})`
    When replyTo != null add to the JSON body:
      reply_parameters: { message_id: replyTo, allow_sending_without_reply: true }
    allow_sending_without_reply is NOT optional. Card B is the one message that
    must exist even if every edit in the system fails; without this flag Telegram
    rejects it outright when card A has been deleted — precisely the scenario the
    model declares safe. Every existing caller passes two arguments and is unaffected.

B2. `notify.receipt(chatId, { svg, caption, text, followUp, replyTo })`
    Add `reply_parameters` to the FormData as a JSON string, and thread replyTo
    into the fallback: `return notify(chatId, text, { replyTo })`. If only the
    photo path carried it, a render failure would silently unthread card B.
    Return shape is unchanged: `{ ok, messageId, photo: true }` on the photo path,
    and the fallback's `{ ok, messageId }` with NO photo field on the text path.
    That asymmetry is load-bearing — do not "fix" it by adding photo:false.

B3. NEW `notify.edit(chatId, messageId, { isPhoto, svg, caption, text })`
    Sits directly beside notify.receipt and follows this file's house rules: never
    throws, one console.warn per failure, returns a plain result object.

    isPhoto === true:
      png = await renderPng(svg)      // reuse the existing helper
      POST /editMessageMedia as FormData:
        chat_id, message_id,
        media = JSON.stringify({ type: 'photo', media: 'attach://receipt',
                                 caption: String(caption ?? '').slice(0, 1024),
                                 parse_mode: 'HTML' })
        form.append('receipt', new Blob([png], { type: 'image/png' }), 'receipt.png')
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS * 3)
      One call replaces picture AND caption, so they can never disagree.

    isPhoto === false:
      POST /editMessageText with chat_id, message_id, text, parse_mode 'HTML',
      disable_web_page_preview: true, signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)

    CLASSIFICATION of json.description (lowercased substring match):
      PERMANENT → { ok:false, permanent:true, error }
        'message to edit not found', 'message_id_invalid', "message can't be edited",
        'message to be edited not found', 'chat not found', 'bot was kicked',
        'bot was blocked', 'not enough rights', 'chat_write_forbidden',
        'bot is not a member'
      RATE → { ok:false, error, retryAfter: json.parameters?.retry_after }
      SUCCESS-EQUIVALENT → { ok:true } for 'message is not modified'
        (text path only; it can never fire for editMessageMedia with attach://,
         because a re-rendered PNG is a fresh upload every time)
      EVERYTHING ELSE (timeout, http_5xx, network) → { ok:false, error }  // transient
    A render throw inside notify.edit is caught and returned as
    { ok:false, error } — transient, never permanent: the renderer may succeed
    next time and a render fault must not permanently mark a live card 'gone'.

B4. `formatReceipt(entry, balance, orig, { cancelled, correction } = {})` and
    `formatBatchReceipt(entries, balance, { note, at, cancelled, correction })`.
    ADDITIVE RULE, identical to the picture: every line the message printed stays,
    in place, with its figures unchanged. A row whose entry.id is in `cancelled`
    has its product line and its qty/total line wrapped in <s>. When `correction`
    is present, ONE header line is prepended above the existing header:
      `❌ <b>Bekor qilindi</b> · ${correction.count} qator · ${correction.at}`
    The `Jami:` line, the stamp line and balanceLine() are NOT recomputed and NOT
    struck — they are what the document said when it was issued. `cancelled` is a
    Set of ledger ids; absent or empty, both functions return exactly what they
    return today.

════════════════════════════════════════════════════════════════════
AGENT C — server/receipt-image.js   (see the `rendering` field for the visual spec)
════════════════════════════════════════════════════════════════════
Five surgical changes. Every one is inert when `r.correction` is null.

C1. Geometry: add `CORR: 22` to G. No other G value changes. No palette entry is
    added — cancellation ink is C.ink (black), NOT C.up: C.up means "the debt
    ROSE" in this palette's grammar and reusing it as cancellation ink collides
    on an already-red handover card.

C2. slotCap stays STAMPLESS. Leave line 231 exactly as it is:
      const fixed = EDGE+BAND+META+refH+HEAD+TOTAL+noteH+PERF+STUB+EDGE
    and add a comment: `fixed` is deliberately the STAMPLESS height — the
    correction bar is added to the y-stack BELOW, never to `fixed`, because
    slotCap is derived from `fixed` and a bar counted here would drop slotCap
    from 14 to 13 and silently push a named product row into the aggregate. A
    stamped card may be taller than the original and may exceed ASPECT_MAX. It
    may NEVER show fewer named rows than the original showed.

C3. y-stack — two new terms, both zero without a correction:
      const corrH = r.correction ? G.CORR : 0
      const restCancelled = rest.filter(i => i.cancelled)          // overflow remainder
      const aggCancelH = (r.correction && overflow && restCancelled.length) ? G.ROW : 0
      const yTotal  = yRows + slots * G.ROW + aggCancelH
      const tableH  = hasTable ? G.HEAD + slots * G.ROW + aggCancelH + G.TOTAL : G.PAY
      const yCorr   = yTable + tableH
      const yNote   = yCorr + corrH
    `shown`, `rest`, `slots` and the whole column `plan` are computed EXACTLY as
    today — no pinning, no reordering, no new measurement terms in `sums`/`qtys`.
    That is what makes a stamped card a pixel-superset of the original.

C4. Strikes:
      row loop:  if (it.cancelled || r.kind === 'reversal') push(hline(G.X_NAME-3, base-3.5, xSum+2, C.ink, 0.9))
                 and when it.cancelled, print name/qty/sum fills as C.faint
      no-table:  if (r.kind === 'reversal' || r.correction?.all) push(<the existing figure strike>)
    Keying the row strike on `it.cancelled ||` rather than replacing the kind test
    keeps the standalone reversal card (card B) byte-identical to today.

C5. The two new marks — the aggregate sub-row and the correction bar — are
    described in the `rendering` field. Neither touches the column planner: both
    size their figures with the existing `fitSize`, exactly as the live aggregate
    row already does.

════════════════════════════════════════════════════════════════════
AGENT D — server/receipt-log.js (NEW) + server/clients.js
════════════════════════════════════════════════════════════════════

--- THE RULE THE WHOLE PROTOCOL RESTS ON ---
NO ROUTE IN THIS PROCESS MAY OPEN A TRANSACTION AND THEN AWAIT. Verified across
the server: every BEGIN…COMMIT is synchronous (clients.js tx() at :344,
index.js:86, :372, :409) and no async handler contains a BEGIN (buildWorkbook,
/api/export.xlsx, /api/export, statement.js). Node is single-threaded, so a
promise callback cannot interleave into synchronous code — which is what makes
the fire-and-forget settle UPDATE safe. Put this sentence as a comment above
tx() and above settle(). If someone later writes an async handler that opens a
transaction, the settle UPDATE could join it and vanish on its ROLLBACK.

────────────────────────────────────────────────────────────────────
D1. server/receipt-log.js — makeReceiptLog({ db, notify, build })
────────────────────────────────────────────────────────────────────
Prepared statements: insPost, insRow, lastId (`SELECT last_insert_rowid() AS id`),
getPost, forEntry, rowsOf, updSettle, updFailed, updStamped, updGone.

  rowsOf:
    SELECT r.ledger_id, r.ord, x.id AS reversed_by, x.created_at AS reversed_at
    FROM receipt_post_rows r
    LEFT JOIN client_ledger x ON x.reverses_id = r.ledger_id
    WHERE r.post_id = ? ORDER BY r.ord
  One indexed query (ix_receipt_post_rows_post_id, then ix_client_ledger_reverses_id)
  returning at most 50 already-committed rows. It yields the cancelled SET and the
  cancellation TIMESTAMPS at once. No LEDGER_SELECT, no product joins, no balance
  re-derivation: constraint 5 discharged by construction.

  forEntry:
    SELECT p.* FROM receipt_posts p
    JOIN receipt_post_rows r ON r.post_id = p.id
    WHERE r.ledger_id = ? AND p.kind = 'movement'
  (a PRIMARY KEY lookup on receipt_post_rows, then a PK lookup on receipt_posts)

  record(client, kind, ledgerIds) → postId | null
    if (!client || client.telegram_chat_id == null) return null
    try {
      insPost.run(client.id, client.telegram_chat_id, kind)   // state 'pending'
      const id = lastId.get().id                              // read IMMEDIATELY
      ledgerIds.forEach((lid, i) => insRow.run(lid, id, i))
      return id
    } catch (err) { console.warn('[receipt] record:', err?.message ?? err); return null }
    ── THE TRY/CATCH IS THE CONSTRAINT-3 FIX. This runs INSIDE the movement's
       transaction; both losing models put it there unguarded, so a bookkeeping
       insert failure (half-migrated file, FK fault, SQLITE_BUSY past the 5s
       timeout) would ROLLBACK a committed delivery and return 500. Guarded, the
       worst case is postId === null → nothing is posted-and-tracked → the card is
       simply not stampable, which is exactly the crash-window behaviour already
       designed for.
    ── A failed statement inside a SQLite transaction rolls back the STATEMENT,
       not the transaction, so catching here genuinely leaves the ledger inserts
       standing.

  track(postId, promise) / settled(postId) → Promise
    An in-memory Map<postId, Promise>. `track` stores a promise that is ALREADY
    terminal (see D3) and deletes it on settle. `settled` returns
    `inflight.get(postId) ?? Promise.resolve()`. It closes the hole where a
    correction arrives seconds after the post: without it, stamp() and card B's
    reply_to would both read message_id NULL for a message that is about to exist.
    Bounded by the AbortSignal.timeout already on the send, so it cannot hang.

  settle(postId, res, { caption, snapshot })
    ok && res.messageId != null:
      UPDATE receipt_posts SET message_id=?, is_photo=?, caption=?, snapshot=?,
             state='posted' WHERE id=? AND state='pending'
      is_photo = res.photo === true ? 1 : 0    ← FROM THE RESULT, never from RECEIPT_IMAGES
    else: UPDATE … SET state='failed', last_error=? WHERE id=? AND state='pending'
    The whole body is inside try/catch. It is ONE statement, no BEGIN.

  stamp(postId) → Promise, SERIALIZED PER POST with a dirty flag:
    const st = chains.get(postId)
    if (st) { st.dirty = true; return st.running }
    ...run(): do { state.dirty = false; await runStamp(postId) } while (state.dirty)
    ...then .catch(log).finally(() => chains.delete(postId))
    Fifty reversals of a fifty-row batch therefore collapse to two or three edits
    of card A, not fifty. Each run re-derives the cancelled set from the database
    WHEN IT RUNS, so the last edit always reflects every commit before it.

  runStamp(postId):
    const post = getPost.get(postId)
    if (!post || post.state !== 'posted' || post.message_id == null) return
    if (!post.snapshot) return                       // crashed before settle
    const rows = rowsOf.all(postId)
    const cancelled = rows.filter(r => r.reversed_by != null)
    if (!cancelled.length) return
    const ids = cancelled.map(r => r.ledger_id).sort((a,b) => a-b)
    const csv = ids.join(',')
    if (csv === post.stamped_ids) return             // the only photo-path idempotence guard
    const correction = { count: ids.length, all: ids.length === rows.length,
                         at: <tashkentStamp of MAX(reversed_at)> }
    const built = build(post, ids, correction)       // injected; may throw
    const res = await notify.edit(post.chat_id, post.message_id, built)
      ok        → updStamped.run(csv, postId)
      permanent → updGone.run(res.error, postId)     // state='gone', never retried
      retryAfter <= 30 → one retry after that delay
      transient → ONE retry after 2s, then updFailed.run(res.error, postId)
    Every path is inside try/catch; a throw becomes state='failed' and one log line.
    A 'failed' post stays stampable — the next correction retries. A 'gone' one
    never is.

  CANCELLATION IS MONOTONIC, which is why blind last-write-wins is safe here:
  E.isReversal (clients.js:819) forbids reversing a reversal and E.alreadyRev
  (:820) forbids reversing a row twice, so the struck set of a card only ever
  grows. There is no un-stamp path, a later stamp always legitimately supersedes
  an earlier one, and an out-of-order edit can only ever UNDER-strike — which the
  stamped_ids comparison detects and the next stamp repairs.

────────────────────────────────────────────────────────────────────
D2. clients.js — receiptData(), build(), and the snapshot
────────────────────────────────────────────────────────────────────
receiptData(client, entries, balance, note, orig = null)
  ONE new field per item: `id: e.id`. The renderer ignores it; build() needs it,
  because receiptData filters `entries.filter(e => e.category_id != null)` so the
  items index is NOT the entries index once a payment row is in play. Carrying the
  id is the only way to map a cancelled ledger row to the right item.

snapshotOf(client, entries, balance, note, orig) → JSON string
  JSON.stringify({ client: { name: client.name }, entries, note, balance,
                   orig: orig ? { kind: orig.kind, created_at: orig.created_at } : null })
  `entries` are the LEDGER_SELECT rows already in hand. Built synchronously inside
  postReceipt's existing try, handed to settle(). It is the INPUTS, not the
  rendered output: the text stamp path needs entry-shaped rows because
  formatBatchReceipt calls productLabel(category_name, parent_name) itself.

build(post, cancelledIds, correction) → { svg, caption, text, isPhoto }
  const snap = JSON.parse(post.snapshot)
  const set = new Set(cancelledIds)
  const data = receiptData(snap.client, snap.entries, snap.balance, snap.note, snap.orig)
  data.items.forEach(it => { if (set.has(it.id)) it.cancelled = true })
  data.correction = correction
  const text = snap.entries.length === 1
    ? formatReceipt(snap.entries[0], snap.balance, snap.orig, { cancelled: set, correction })
    : formatBatchReceipt(snap.entries, snap.balance, { note: snap.note, cancelled: set, correction })
  const head = `❌ <b>BEKOR QILINDI</b> · ${correction.count} qator · ${correction.at}`
             + ` — yangi kvitansiyaga qarang`
  const full = `${head}\n<s>${snap.caption ?? ''}</s>`
  const caption = full.length <= 1024 ? full : head
    // Never slice snap.caption: it already contains HTML entities and a cut
    // entity is a message Telegram refuses. compactCaption is ~80 chars, so the
    // fallback is unreachable in practice — it exists so it can never be hit.
  return { svg: receiptSvg(data).svg, caption, text, isPhoto: post.is_photo === 1 }

────────────────────────────────────────────────────────────────────
D3. clients.js — postReceipt() now RETURNS its send promise and settles the post
────────────────────────────────────────────────────────────────────
postReceipt(client, entries, balance, note, orig = null, { postId = null, replyTo = null } = {})

  Unchanged: the guards, the text build, RECEIPT_IMAGES, the outer catch that
  degrades to postText. Two additions.

  (a) replyTo is passed into notify.receipt({ …, replyTo }) and into
      notify(client.telegram_chat_id, text, { replyTo }).
  (b) after `send` is built:

      const snapshot = postId ? snapshotOf(client, entries, balance, note, orig) : null
      const p = Promise.resolve(send)
        .then(res => { if (postId) log.settle(postId, res, { caption, snapshot }) })
        .catch(() => {})                       // ← TERMINAL. NON-NEGOTIABLE.
      if (postId) log.track(postId, p)
      return p

  THE TERMINAL .catch IS A CORRECTNESS REQUIREMENT, NOT STYLE. `send` never
  rejects — notify and notify.receipt catch everything — so the only way into a
  rejection is a throw out of settle(), which is a synchronous DatabaseSync write
  that throws if the Python bot holds the file past PRAGMA busy_timeout=5000
  (index.js:29-30; the two processes genuinely share the file). Without the
  terminal catch that rejection reaches an unhandled-rejection handler and takes
  the process down — a NOTIFICATION-BOOKKEEPING failure killing the server, in a
  design whose whole thesis is that notification failures never propagate. settle()
  is ALSO internally try/catch'd; both, belt and braces. Every existing
  fire-and-forget in this file already ends in `.catch(() => {})`.

  Also fix the outer catch: its postText fallback currently swallows its own
  promise, so a render-throw message is never settled. Have postText return its
  promise and settle from it too, or accept that a render-throw post is left
  'pending' — but say which. DECISION: settle it. postText gains the same
  `{ postId, replyTo }` treatment and the same terminal-catch chain.

────────────────────────────────────────────────────────────────────
D4. clients.js — three transactions reserve their post row
────────────────────────────────────────────────────────────────────
insertAndReply(reply, user, client, row):
    const { entryId, postId } = tx(() => {
      const entryId = insertRow(user, client.id, row)      // reads lastId itself
      const postId  = log.record(client, 'movement', [entryId])
      return { entryId, postId }
    })
    …unchanged…
    postReceipt(client, [entry], balance, null, null, { postId })

handleBatch(): identical shape —
    const { ids, postId } = tx(() => {
      const ids    = prepared.rows.map(row => insertRow(user, client.id, row))
      const postId = log.record(client, 'movement', ids)
      return { ids, postId }
    })
    …unchanged…
    postMovement(client, entries, balance, note, postId)
  50 rows costs 51 extra statements inside a transaction already doing 50 inserts.

THE ORDERING BUG THIS AVOIDS: `q.lastId` is `SELECT last_insert_rowid()`
(clients.js:145). insertRow reads it immediately (clients.js:656), so these two
are safe. The reverse route is NOT — it reads `q.lastId.get().id` at line 833,
AFTER the insert but at the end of the transaction body. record() runs its own
inserts and would clobber it, returning a receipt_posts id where the reversal's
ledger id belongs — which would then flow into q.entry.get() and into
receipt_post_rows. So:

app.post('/api/ledger/:entryId/reverse'):
    inside tx(), after q.insLedger.run(...):
      const revId  = q.lastId.get().id                        // ← FIRST. Always.
      const postId = log.record(client, 'reversal', [revId])  // ← clobbers lastId; harmless now
      return { code: 200, id: revId, postId, client, orig }

    after the transaction:
      const entry   = withPath(q.entry.get(out.id))
      const balance = balanceOf(out.client.id)
      reply.send({ entry, balance })          // the API answers FIRST, as it does today
      void correctionTail(out, entry, balance)
      return reply

    async function correctionTail(out, entry, balance) {
      try {
        let post = log.forEntry(out.orig.id)
        if (post && post.state === 'pending') {
          await log.settled(post.id)          // close the in-flight window
          post = log.get(post.id)
        }
        const replyTo = post && post.state === 'posted' ? post.message_id : null
        // CARD B FIRST, ALWAYS, AND AWAITED — the correction record must exist in
        // the group even if every edit in the system fails. Card B posts to the
        // LIVE client.telegram_chat_id (postReceipt's own guard drops it if the
        // client has since been unlinked); the stamp goes to post.chat_id.
        await postReceipt(out.client, [entry], balance, null, out.orig,
                          { postId: out.postId, replyTo })
        if (post && post.state === 'posted') await log.stamp(post.id)
      } catch (err) { console.warn('[receipt] correction:', err?.message ?? err) }
    }

    correctionTail is a DETACHED async function with a terminal catch, started
    after reply.send(). tx() stays fully synchronous — the tail runs entirely
    outside it, so the no-await-around-a-transaction rule is preserved by the very
    change that introduces the first async work in this file.

    THE ORDERING PRINCIPLE, stated once: a stamp failure must never affect the
    correction post, and neither may touch the API response. That is the existing
    "a notification failure must never affect the ledger write or the API
    response" rule, pushed one level out.

────────────────────────────────────────────────────────────────────
D5. THE CRASH WINDOW — committed, Telegram not yet answered
────────────────────────────────────────────────────────────────────
The receipt_posts row survives on disk with message_id NULL, state 'pending',
snapshot NULL. Three indistinguishable cases: the request never left; sendPhoto
succeeded and we died reading the reply; we died before sending.

THE RULE, and it is one rule for all three:
  • A 'pending' post is PERMANENTLY UNSTAMPABLE. runStamp finds message_id NULL
    (or snapshot NULL) and returns silently.
  • A 'pending' post is NEVER RE-POSTED on startup. Telegram gives a bot no way
    to find a message it sent, getUpdates does not return the bot's own posts,
    and there is no idempotency key. A boot-time resend risks DUPLICATING a money
    receipt in a client's group, and two contradictory records of one delivery is
    a strictly worse harm than one missing annotation.
  • There is NO reconciler and NO backfill.

The consequence is bounded and small: the correction still posts as card B, which
is self-contained, names what it cancels by kind and stamp, and carries the live
balance. The only loss is the ink on the older card. The row stays 'pending',
which is exactly the operator signal you want:
  SELECT count(*) FROM receipt_posts
  WHERE state='pending' AND created_at < datetime('now','-1 hour')
('pending' is also the normal state for the first seconds after every movement,
which is why that query carries an age threshold. No `posted` field is added to
GET /ledger and no repost route is built — out of scope.)

────────────────────────────────────────────────────────────────────
D6. WHEN THE EDIT FAILS
────────────────────────────────────────────────────────────────────
MESSAGE DELETED BY A USER / BOT KICKED / CHAT LEFT → permanent → state='gone',
never attempted again. Card B is already in the group, already names
"AMAL: Berildi · 14.09.2026 15:04", already carries the corrected balance. The
client is fully informed; they lack ink on a card that no longer exists. Note the
asymmetry that justifies the whole model: under STAMP a deleted original costs an
annotation. Under a restating model it would cost the only statement of what was
actually delivered.

TRANSIENT (timeout, 5xx, network) → one retry after 2s → state='failed'. The next
correction to that delivery tries again from current state.

429 → honour retry_after when <= 30s, one attempt; longer, treat as failed. One
correction produces one edit, and Telegram's limits on editing a bot's own message
are generous.

RENDERER THROWS AT STAMP TIME → caught in runStamp, state='failed', card B
already posted. Preserves postReceipt's existing pattern exactly: render inside
the try, degrade rather than propagate.

48 HOURS IS NOT A LIMIT for a bot editing its own message — that is what makes
this design possible. Assumed, never relied upon: an edit that fails at any age
for any reason lands in the classes above.

RECEIPT_IMAGES FLIPPED BETWEEN POST AND CORRECTION → handled, because is_photo is
a per-message flag read from the send result. A text card is edited with
editMessageText even while new cards post as photos, and vice versa.

CLIENT UNLINKED OR THE GROUP RE-LINKED between post and correction → the stamp
edits post.chat_id (where the message physically lives); card B posts to the live
client.telegram_chat_id and is dropped by postReceipt's guard if that is now null.
The old card gets stamped, no new card appears in a group the client no longer
has. The alternative would post a client's receipt into someone else's group.

TWO CORRECTIONS RACING → both reverse calls serialize at the database (synchronous
tx, single-threaded process: start.sh ends `exec node --experimental-sqlite
index.js`, no cluster, no fork), both B cards post, and the per-post chain
serializes the two stamps. Each run re-derives the cancelled set from
`reversed_by`, so whichever runs last shows both rows struck. If an edit lands out
of order, stamped_ids no longer matches the derived set and the next stamp repairs
it from current state. No accumulated state, no lost strike.

────────────────────────────────────────────────────────────────────
D7. COST OF A STAMP ON A 50-ITEM BATCH
────────────────────────────────────────────────────────────────────
One PK lookup (receipt_post_rows), one PK lookup (receipt_posts), one indexed
query returning ≤50 committed rows, one JSON.parse of the stored snapshot, one
receiptSvg call producing the same card the original post produced plus one row,
one resvg rasterise, one HTTP edit. ZERO joins against product_categories or
clients, zero balance queries, nothing re-derived that is not in the database.

────────────────────────────────────────────────────────────────────
D8. WIRING
────────────────────────────────────────────────────────────────────
clientRoutes() constructs the log after its prepared statements:
  const log = makeReceiptLog({ db, notify, build })
`build` closes over receiptData, compactCaption, formatReceipt, formatBatchReceipt
and receiptSvg — all of which live in the clientRoutes closure. receipt-log.js
therefore imports NOTHING from clients.js; the dependency runs one way only.

════════════════════════════════════════════════════════════════════
VERIFICATION, before any of this is called done
════════════════════════════════════════════════════════════════════
1. receiptSvg with r.correction === null produces output byte-identical to HEAD
   for: a 1-item handover, a 3-item batch, a 50-item batch, a payment, and a
   reversal card. Diff the SVG strings. This is the additive invariant's floor.
2. A 3-item batch: post, reverse the middle row, assert card A's stamped SVG
   still contains "2 625 000" (JAMI), "5 725 000" (stub) and the row-2 figures,
   and now also contains the strike path and the bar.
3. A 50-item batch with the cancelled row at index 30: assert the stamped card
   shows the SAME 13 named rows the original showed, the unchanged
   "+37 mahsulot" aggregate with its original figures, plus the struck
   "shundan bekor" sub-row.
4. Kill the process between COMMIT and the Telegram response: the post row is
   'pending', the next correction posts card B and stamps nothing, and no
   duplicate receipt appears on restart.
5. Force settle() to throw: the process must still be running afterwards.
6. Reverse two different rows of one batch concurrently: exactly two B cards, at
   most two edits of card A, and the final card shows both strikes.
7. Delete card A from the group, then reverse a row: card B still arrives
   (allow_sending_without_reply), and the post is marked 'gone'.
8. RECEIPT_IMAGES=0: a text card posts, is_photo=0, and the correction edits it
   with editMessageText carrying struck rows and the prepended header.

## Rendering

WHAT receipt-image.js MUST SHOW FOR A CANCELLED / PARTIALLY-CANCELLED CARD

THE GOVERNING PROPERTY — a stamped card is a PIXEL-SUPERSET of the card it
replaces, except that it is taller. Not "the same values in a reflowed layout":
every mark the original card carried is in the same place at the same size, and
the edit only ADDS ink. That is why `shown`, `rest`, `slots` and the entire
column `plan` (form A/B, drop, cell, jami, qtyS, colS, colQ, nameBudget) are
computed EXACTLY as they are today, with no pinning, no reordering, and no new
terms in the `sums`/`qtys` measurement arrays. A cancelled row is struck where it
already sits. Nothing is promoted, demoted or renumbered.

Inputs: `r.items[i].cancelled` (boolean) and `r.correction = { count, all, at }`.
When `r.correction` is null the renderer is a strict no-op.

1. A CANCELLED ROW THAT IS VISIBLE
   Its №, name, MIQDOR and SUMMA all print in C.faint instead of C.ink, and the
   existing 0.9px strike (receipt-image.js:363 geometry — `hline(G.X_NAME - 3,
   base - 3.5, xSum + 2, C.ink, 0.9)`) is drawn across it. The figures are the
   figures the card printed. The zebra banding, the row rules and the row number
   are untouched.

2. A CANCELLED ROW INSIDE THE OVERFLOW AGGREGATE  (the 50-item case)
   The live aggregate row is NOT recomputed. It keeps saying exactly what it said
   — "+37 mahsulot · 37 dona · 5 000 000" — because those figures were printed and
   printed figures do not move. ONE extra row (G.ROW tall, `aggCancelH`) is added
   BENEATH it, between the last slot and the JAMI row, pushing JAMI and everything
   below it down by 20pt:

     MAHSULOT column, C.faint, size `cell`:   `shundan bekor: ${M}`
     MIQDOR   column, C.faint, right:          `${cancelledRestQty} dona`
     SUMMA    column, C.faint, bold, right:    money(cancelledRestSum)
     and the same 0.9px C.ink strike across name→sum.

   ("shundan bekor" — "of which cancelled".) Both figures are sized with the
   existing `fitSize` against the same budgets the live aggregate row already
   uses, so the column planner needs no new measurement terms and cannot
   under-measure. No cancelled money is hidden inside a live aggregate, and no
   named row that the client once saw is evicted to make space for it. Card B
   names the product in words, which is the guarantee that does not depend on the
   picture at all.

3. THE CORRECTION BAR — full width, G.CORR = 22pt, at yCorr = yTable + tableH
   Directly under the finished table (and under the no-table JAMI box, identically),
   above the note. It reads as a clerk's stamp applied to a completed docket, and
   putting it BELOW the table is what keeps every table row at the y it already had.

     partial cancellation (r.correction.all === false):
       a 16pt-tall box from G.L to G.R at yCorr+3, fill C.panel, stroke C.ink 1.1
       left,  G.L+6,  bold 9.5, ls 1.2, C.ink:   `BEKOR QILINDI`
       right, tracked to G.R-6, 8.5, C.faint:    `${count} ta qator · ${at}`

     every row cancelled (r.correction.all === true):
       the same box, FILLED C.ink, both texts in C.paper (reversed out).
       A card whose every line is void reads as void in a thumbnail — and it does
       so with a plain filled rectangle, not a rotated diagonal band whose width
       would have to be measured against the advance table and could overrun.

   CANCELLATION INK IS BLACK (C.ink), never C.up. In this palette C.up (#9E2F1D)
   means "the debt ROSE" — it is already the band colour of the handover card
   being stamped, and reusing it as cancellation ink would collide semantically
   on the exact card where it matters most. Black is the clerk's stamp.

4. WHAT THE BAR DOES NOT SAY
   No money. No restated total, no "AMALDAGI", no standing quantity, no new
   balance. There is no expression anywhere in the corrected render that computes
   a total, a delta or a balance differently from the original render — the bar
   carries a count, a date and a word. The pointer sentence ("look at the newer
   receipt") lives in the CAPTION, which is the layer a reader taps, can search,
   and can have read aloud — not on the card, where it would cost a second line
   of layout risk for a sentence the picture cannot hyperlink anyway.

5. THE BAND, THE JAMI AND THE STUB ARE NEVER TOUCHED
   The band still reads BERILDI in C.up with its hung "+" — the movement WAS a
   handover, and rewriting the verb to BEKOR QILINDI would destroy the record of
   what was originally delivered. JAMI still sums every item at its original
   value. The stub still carries the original delta triangle, the original
   movement figure and the original JAMI QARZ. `delta`, `grand`, `totalQty` and
   `dir` are computed from the same inputs as the original render and are NOT
   made correction-aware. A client who screenshotted this card on the 14th can
   hold it against the same card on the 30th and find every digit identical, plus
   a cancellation mark.

6. THE PAYMENT / ADJUSTMENT CARD (the no-table branch, G.PAY)
   The single reversible row is the whole card, so `r.correction.all` is always
   true there. The existing figure strike fires on `r.kind === 'reversal' ||
   r.correction?.all`, and the bar is drawn reversed-out at yCorr exactly as
   above. This is the most common single-row reversal and the case both losing
   models under-specified; it needs no special branch beyond the `|| all`.

7. THE HEIGHT RULE, restated because it is the one subtle thing
   `fixed` (line 231) stays STAMPLESS and remains the sole input to `slotCap`.
   `corrH` and `aggCancelH` enter only the y-stack below it. A stamped card may
   therefore be taller than the original and may exceed G.ASPECT_MAX. It may
   never show fewer named rows than the original showed. Counting the bar into
   `fixed` would drop slotCap from 14 to 13 on a plain batch and silently delete
   a product line from the very card the edit exists to protect.