// Receipt posts — DISPLAY BOOKKEEPING for the messages this server sends.
//
// A posted receipt is a DATED DOCUMENT. When one of its ledger rows is later
// reversed, the message it lives in is EDITED EXACTLY ONCE PER CORRECTION and
// the edit is STRICTLY ADDITIVE: it adds cancellation ink and nothing else. No
// figure the card ever printed is recomputed, moved or removed. The correction
// itself is a NEW message (card B), posted first and threaded under the card it
// corrects.
//
// This module owns the row→message mapping (receipt_posts / receipt_post_rows)
// and nothing else. It is display state, not money: no column here feeds
// SUM(amount) and DROP TABLE on both leaves every balance bit-for-bit
// identical. It imports NOTHING from clients.js — clients.js injects `build`,
// so the dependency runs one way only.
//
// THE STANDING RULE OF THIS SERVER, which every function below obeys: a
// notification concern never affects the ledger write or the API response.
// Every public entry point here is total — it returns or resolves, it never
// throws into its caller.

import { tashkentStamp } from './notify.js'

/** Transient-failure backoff, ms. One retry, then the post is left 'failed'
 *  and the NEXT correction to the same delivery tries again from current state. */
const RETRY_MS = 2000

/** 429s longer than this are not worth holding a chain open for. */
const MAX_RETRY_AFTER_S = 30

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * @param {object}   deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {Function} deps.notify        the notifier; needs notify.edit
 * @param {Function} deps.build         build(post, cancelledIds, correction)
 *                                        → { svg, caption, text, isPhoto }
 */
export function makeReceiptLog({ db, notify, build } = {}) {
  const s = {
    insPost: db.prepare(
      "INSERT INTO receipt_posts (client_id, chat_id, kind, state) VALUES (?, ?, ?, 'pending')"
    ),
    insRow: db.prepare(
      'INSERT INTO receipt_post_rows (ledger_id, post_id, ord) VALUES (?, ?, ?)'
    ),
    lastId:  db.prepare('SELECT last_insert_rowid() AS id'),
    getPost: db.prepare('SELECT * FROM receipt_posts WHERE id = ?'),

    // Row → post. A PRIMARY KEY lookup on receipt_post_rows, then a PK lookup
    // on receipt_posts. Only 'movement' posts are stamp targets: E.isReversal
    // forbids reversing a reversal, so a 'reversal' post is recorded solely for
    // reply_to threading and operator forensics.
    forEntry: db.prepare(`
      SELECT p.* FROM receipt_posts p
      JOIN receipt_post_rows r ON r.post_id = p.id
      WHERE r.ledger_id = ? AND p.kind = 'movement'
    `),

    // The cancelled SET and the cancellation TIMESTAMPS in one indexed query
    // (ix_receipt_post_rows_post_id, then ix_client_ledger_reverses_id) over at
    // most 50 already-committed rows. No LEDGER_SELECT, no product joins, no
    // balance re-derivation: a 50-row stamp costs zero joins and nothing that
    // the card once printed can be re-derived differently.
    rowsOf: db.prepare(`
      SELECT r.ledger_id, r.ord, x.id AS reversed_by, x.created_at AS reversed_at
      FROM receipt_post_rows r
      LEFT JOIN client_ledger x ON x.reverses_id = r.ledger_id
      WHERE r.post_id = ? ORDER BY r.ord
    `),

    // ── The two settle UPDATEs. They are deliberately SEPARATE statements.
    // A send result may only ever settle a 'pending' row (the guard is what
    // makes a double-settle impossible); a STAMP failure lands on a row that is
    // already 'posted' or 'failed', and reusing the pending-guarded statement
    // for it would match zero rows and silently lose the error.
    updSettle: db.prepare(`
      UPDATE receipt_posts
         SET message_id = ?, is_photo = ?, caption = ?, snapshot = ?, state = 'posted'
       WHERE id = ? AND state = 'pending'
    `),
    updSendFailed: db.prepare(
      "UPDATE receipt_posts SET state = 'failed', last_error = ? WHERE id = ? AND state = 'pending'"
    ),
    updStamped: db.prepare(`
      UPDATE receipt_posts
         SET stamped_ids = ?, stamped_at = CURRENT_TIMESTAMP, state = 'posted', last_error = NULL
       WHERE id = ?
    `),
    updStampFailed: db.prepare(
      "UPDATE receipt_posts SET state = 'failed', last_error = ? WHERE id = ? AND state IN ('posted','failed')"
    ),
    updGone: db.prepare(
      "UPDATE receipt_posts SET state = 'gone', last_error = ? WHERE id = ? AND state IN ('posted','failed')"
    ),
  }

  /** postId → a promise that is ALREADY terminal. See track(). */
  const inflight = new Map()
  /** postId → { dirty, running }. One stamp chain per post. */
  const chains = new Map()

  const warn = (what, err) => console.warn(`[receipt] ${what}: ${err?.message ?? err}`)

  /**
   * A post is stampable while its message is known to exist and has not been
   * proven gone. 'pending' is PERMANENTLY unstampable (message_id NULL — we do
   * not know whether that message exists, and there is no way to ask Telegram).
   * 'failed' IS stampable: a transient edit failure must not retire a live
   * card, so the next correction retries from current state. 'gone' never is.
   */
  function stampable(post) {
    return !!post
      && post.message_id != null
      && post.snapshot != null
      && (post.state === 'posted' || post.state === 'failed')
  }

  /**
   * Reserve the row for a message about to be posted. RUNS INSIDE THE
   * MOVEMENT'S TRANSACTION, which is the only place the ledger ids are known
   * and committed together with the reservation.
   *
   * THE TRY/CATCH IS LOAD-BEARING, NOT DEFENSIVE HABIT. Unguarded, a
   * bookkeeping insert failure (half-migrated file, FK fault, SQLITE_BUSY past
   * PRAGMA busy_timeout) would ROLL BACK A COMMITTED DELIVERY and answer the
   * API 500 — display state killing a money write, which is the one thing this
   * design exists to make impossible. Guarded, the worst case is
   * postId === null: nothing is tracked, the card is simply NOT STAMPABLE, and
   * that is the same degraded mode the crash window already designs for.
   *
   * A failed statement inside a SQLite transaction rolls back the STATEMENT,
   * not the transaction, so catching here genuinely leaves the ledger inserts
   * standing.
   *
   * @returns {number|null} the post id, or null if nothing is to be tracked
   */
  function record(client, kind, ledgerIds) {
    if (!client || client.telegram_chat_id == null) return null
    if (!Array.isArray(ledgerIds) || ledgerIds.length === 0) return null
    try {
      s.insPost.run(client.id, client.telegram_chat_id, kind)
      const id = s.lastId.get().id          // read IMMEDIATELY; insRow clobbers it
      ledgerIds.forEach((lid, i) => s.insRow.run(lid, id, i))
      return id
    } catch (err) {
      warn('record', err)
      return null
    }
  }

  /**
   * Remember the in-flight send so a correction arriving seconds later can wait
   * for the message id instead of reading NULL for a message that is about to
   * exist. The promise handed in is already terminal (postReceipt ends its
   * chain in `.catch(() => {})`); this adds its own guards anyway.
   *
   * Bounded by the AbortSignal.timeout already on the send, so it cannot hang.
   */
  function track(postId, promise) {
    const p = Promise.resolve(promise).then(() => {}, () => {})
    if (postId == null) return p
    const done = p.finally(() => { if (inflight.get(postId) === done) inflight.delete(postId) })
    inflight.set(postId, done)
    return done
  }

  /** Resolves when the post's send has settled — immediately if it already has. */
  function settled(postId) {
    return inflight.get(postId) ?? Promise.resolve()
  }

  function get(postId) {
    try { return s.getPost.get(postId) ?? null } catch (err) { warn('get', err); return null }
  }

  function forEntry(ledgerId) {
    try { return s.forEntry.get(ledgerId) ?? null } catch (err) { warn('forEntry', err); return null }
  }

  /**
   * Write what Telegram answered. ONE statement, NO BEGIN.
   *
   * NO ROUTE IN THIS PROCESS MAY OPEN A TRANSACTION AND THEN AWAIT — every
   * BEGIN…COMMIT in this server is synchronous (clients.js tx(), index.js), and
   * Node is single-threaded, so a promise callback cannot interleave into
   * synchronous code. THAT is what makes this fire-and-forget UPDATE safe. If
   * someone later writes an async handler that opens a transaction, this UPDATE
   * could join it and vanish on its ROLLBACK.
   */
  function settle(postId, res, { caption = null, snapshot = null } = {}) {
    if (postId == null) return
    try {
      if (res && res.ok === true && res.messageId != null) {
        // is_photo COMES FROM THE SEND RESULT, NEVER FROM RECEIPT_IMAGES.
        // notify.receipt degrades to plain text on ANY render or upload failure
        // and the text path returns no `photo` field at all. Reading the flag
        // instead would fire editMessageMedia at a text message.
        s.updSettle.run(
          res.messageId,
          res.photo === true ? 1 : 0,
          caption == null ? null : String(caption),
          snapshot == null ? null : String(snapshot),
          postId,
        )
      } else {
        const why = res?.skipped ? 'skipped' : String(res?.error ?? 'send_failed')
        s.updSendFailed.run(why, postId)
      }
    } catch (err) {
      warn('settle', err)
    }
  }

  /**
   * Apply the cancellation ink to one already-posted card.
   *
   * SERIALIZED PER POST with a dirty flag: fifty reversals of a fifty-row batch
   * collapse to two or three edits of the card, not fifty. Each run re-derives
   * the cancelled set from the database WHEN IT RUNS, so the last edit always
   * reflects every commit before it.
   *
   * CANCELLATION IS MONOTONIC, which is why blind last-write-wins is safe:
   * E.isReversal forbids reversing a reversal and E.alreadyRev forbids reversing
   * a row twice, so the struck set of a card only ever GROWS. There is no
   * un-stamp path; a later stamp always legitimately supersedes an earlier one,
   * and an out-of-order edit can only ever UNDER-strike — which the stamped_ids
   * comparison detects and the next stamp repairs.
   */
  function stamp(postId) {
    const st = chains.get(postId)
    if (st) { st.dirty = true; return st.running }

    const state = { dirty: false, running: null }
    chains.set(postId, state)
    const loop = async () => {
      do { state.dirty = false; await runStamp(postId) } while (state.dirty)
    }
    state.running = loop()
      .catch(err => warn('stamp', err))
      .finally(() => { if (chains.get(postId) === state) chains.delete(postId) })
    return state.running
  }

  async function runStamp(postId) {
    try {
      const post = s.getPost.get(postId)
      // 'pending' lands here after a crash between COMMIT and Telegram's reply:
      // message_id and snapshot are both NULL and there is no way to recover
      // them, so the card is silently not stampable. 'gone' never returns.
      if (!stampable(post)) return

      const rows = s.rowsOf.all(postId)
      const cancelled = rows.filter(r => r.reversed_by != null)
      if (!cancelled.length) return

      const ids = cancelled.map(r => r.ledger_id).sort((a, b) => a - b)
      const csv = ids.join(',')
      // On the photo path this is the ONLY idempotence guard: "message is not
      // modified" can never fire for editMessageMedia with attach://, because a
      // re-rendered PNG is a fresh upload every time.
      if (csv === post.stamped_ids) return

      const at = cancelled.reduce(
        (max, r) => (r.reversed_at != null && (max == null || String(r.reversed_at) > String(max))
          ? r.reversed_at : max),
        null,
      )
      const correction = {
        count: ids.length,
        all: ids.length === rows.length,
        at: tashkentStamp(at),
      }

      const built = build(post, ids, correction)   // injected; may throw
      let res = await notify.edit(post.chat_id, post.message_id, built)

      if (res?.ok) { s.updStamped.run(csv, postId); return }
      if (res?.permanent) {
        // The message was deleted, the bot was kicked, the chat is gone. Card B
        // is already in the group, already names what it cancels and already
        // carries the live balance: the only loss is ink on a card that no
        // longer exists. Never attempted again.
        s.updGone.run(String(res.error ?? 'permanent'), postId)
        return
      }

      const after = Number(res?.retryAfter)
      if (Number.isFinite(after) && after > MAX_RETRY_AFTER_S) {
        s.updStampFailed.run(String(res?.error ?? 'rate_limited'), postId)
        return
      }
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : RETRY_MS)

      res = await notify.edit(post.chat_id, post.message_id, built)
      if (res?.ok) s.updStamped.run(csv, postId)
      else if (res?.permanent) s.updGone.run(String(res.error ?? 'permanent'), postId)
      else s.updStampFailed.run(String(res?.error ?? 'edit_failed'), postId)
    } catch (err) {
      // A renderer throw at stamp time, a Telegram client fault, a busy file.
      // Card B is already posted; this costs an annotation and one log line.
      warn('runStamp', err)
      try { s.updStampFailed.run(String(err?.message ?? err), postId) } catch {}
    }
  }

  return { record, track, settled, settle, forEntry, get, stamp, stampable }
}

export default makeReceiptLog
