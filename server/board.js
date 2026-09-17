// Living board — ONE growing message per client group, edited in place.
//
// A client's group holds exactly one board: a message whose inline keyboard is
// the whole ledger as a grid. Every movement REBUILDS that grid from the ledger
// rows it is handed and EDITS the message. Nothing here accumulates; there is no
// counter, no running total, no "add one row to what is already there". That is
// why the board's JAMI can never drift from SUM(amount): the only arithmetic in
// the system lives in the rows the caller SELECTed, and this module is a
// transport for them.
//
// This module owns client_boards (client_id → chat_id, message_id, state) and
// nothing else. It is display state, not money: no column here feeds
// SUM(amount), no route computes a balance from it, and DROP TABLE client_boards
// leaves every balance bit-for-bit identical — the same contract receipt_posts
// keeps. It imports NOTHING from clients.js; `buildBoard` is injected, so the
// dependency runs one way only.
//
// THE STANDING RULE OF THIS SERVER, which every line below obeys: a notification
// concern never affects the ledger write or the API response. refresh() is
// total — it returns a promise that always resolves, and it never throws into
// its caller.
//
// ── The notify contract this file assumes ──────────────────────────────────────
// buildBoard's output is Telegram's own vocabulary and is passed through
// VERBATIM, with no translation step that could drift:
//
//   built = buildBoard(rows, { clientName, balance })   → { text, reply_markup }
//   notify(chatId, built.text, { reply_markup })        → { ok, messageId }
//   notify.edit(chatId, messageId, built)               → { ok }
//                                                       | { ok: false, permanent, error }
//                                                       | { ok: false, error, retryAfter? }
//
// notify.edit takes `built` whole: `text` selects its editMessageText path and
// `reply_markup` rides along, so the text and the grid are replaced in ONE call
// and can never disagree.

/**
 * @param {object}   deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {Function} deps.notify      the notifier; needs notify.edit
 * @param {Function} deps.buildBoard  buildBoard(rows, { clientName, balance })
 *                                      → { text, reply_markup }
 */
export function makeBoard({ db, notify, buildBoard } = {}) {
  const s = {
    get: db.prepare('SELECT * FROM client_boards WHERE client_id = ?'),

    // The ONLY row-creating statement, and it runs ONLY after Telegram has
    // answered with a message id. There is no 'pending' reservation here:
    // refresh() runs AFTER the movement's COMMIT, outside any transaction, so a
    // reserved row would buy nothing that a missing row does not already give —
    // "no live board, post one". The DDL keeps the DEFAULT for the Python side's
    // benefit; this module never writes it.
    //
    // chat_id is written from the CLIENT'S CURRENT LINK, because that is the
    // chat the message it records was just posted into. Every later EDIT reads
    // it back out of this row instead. See runRefresh().
    upsertLive: db.prepare(`
      INSERT INTO client_boards (client_id, chat_id, message_id, state, updated_at)
      VALUES (?, ?, ?, 'live', CURRENT_TIMESTAMP)
      ON CONFLICT(client_id) DO UPDATE SET
        chat_id    = excluded.chat_id,
        message_id = excluded.message_id,
        state      = 'live',
        updated_at = CURRENT_TIMESTAMP
    `),

    touch: db.prepare(
      'UPDATE client_boards SET updated_at = CURRENT_TIMESTAMP WHERE client_id = ?'
    ),

    // Telegram has told us this message can never be edited again. The message_id
    // is KEPT: it costs nothing, it is the only forensic record of where the
    // board used to live, and `state` alone is what gates the edit path.
    markGone: db.prepare(
      "UPDATE client_boards SET state = 'gone', updated_at = CURRENT_TIMESTAMP WHERE client_id = ?"
    ),
  }

  /** clientId → { payload, dirty, running }. One refresh chain per client. */
  const chains = new Map()

  const warn = (what, err) => console.warn(`[board] ${what}: ${err?.message ?? err}`)

  /** Every write in this module goes through here. A busy file or a half-migrated
   *  database must cost one log line, never a rejected promise on a path whose
   *  whole purpose is to be ignorable. */
  function write(stmt, what, ...args) {
    try { stmt.run(...args) } catch (err) { warn(what, err) }
  }

  /**
   * Telegram chat ids arrive from two places — a SELECT on client_boards and a
   * SELECT on clients — and both are INTEGER affinity, so a plain === is already
   * right. The coercion is here for the one caller that hands in a client object
   * it built itself (a link route's `{ ...client, telegram_chat_id: row.chat_id }`),
   * where a string would otherwise silently read as a re-link and post a
   * duplicate board on every movement.
   */
  function sameChat(a, b) {
    if (a == null || b == null) return false
    return Number(a) === Number(b)
  }

  /**
   * Rebuild and republish this client's board.
   *
   * IDEMPOTENT AND COLLAPSING. Calls for the same client are serialized through
   * one chain with a dirty flag, and each call OVERWRITES the pending payload —
   * so twelve movements landing inside one edit's round trip cost two edits, and
   * the last one carries the NEWEST rows. Two concurrent first-ever calls cannot
   * both see "no row" and post two boards, because the second never runs
   * concurrently with the first.
   *
   * @param client      a clients row: needs id, name, telegram_chat_id
   * @param ledgerRows  the movements the board is to show, exactly as the caller
   *                    SELECTed them. The board is a VIEW of these rows; this
   *                    module never adds to, caches or carries forward a total.
   * @param balance     the client's balance, signed. Also straight from the
   *                    caller's SUM(amount).
   * @returns {Promise<void>} always resolves
   */
  function refresh(client, ledgerRows, balance) {
    if (typeof notify !== 'function') return Promise.resolve()
    // No client, no id, or no linked group: there is nowhere to put a board.
    // Identical to postReceipt's guard, and the reason a test with a null
    // chat_id must observe zero Telegram calls.
    if (!client || client.id == null || client.telegram_chat_id == null) {
      return Promise.resolve()
    }

    const payload = {
      client,
      rows: Array.isArray(ledgerRows) ? ledgerRows : [],
      balance,
    }

    const key = client.id
    const st = chains.get(key)
    if (st) { st.payload = payload; st.dirty = true; return st.running }

    const state = { payload, dirty: false, running: null }
    chains.set(key, state)
    const loop = async () => {
      do { state.dirty = false; await runRefresh(state.payload) } while (state.dirty)
    }
    state.running = loop()
      .catch(err => warn('refresh', err))
      .finally(() => { if (chains.get(key) === state) chains.delete(key) })
    return state.running
  }

  async function runRefresh({ client, rows, balance }) {
    try {
      // Built BEFORE anything is read or written: a renderer fault must cost a
      // log line and leave the stored board exactly as it was, not a half-applied
      // state change.
      const built = buildBoard(rows, { clientName: client.name, balance })
      if (!built || typeof built.text !== 'string') {
        warn('buildBoard', 'no text'); return
      }

      let row
      try { row = s.get.get(client.id) ?? null } catch (err) { warn('get', err); return }

      // A board is LIVE only if all three hold. The third is not paranoia:
      // POST /api/clients/:id/link UNLINKS whoever currently holds that chat_id
      // and rebinds it, so a stored chat_id can become ANOTHER CLIENT'S group.
      // message_id is only meaningful inside the chat it was issued in — editing
      // our stored message_id against a re-read chat_id would overwrite whatever
      // message happens to carry that id in a stranger's group. So the edit below
      // uses row.chat_id, the STORED one, and a mismatch is treated as "this
      // client has no board here" and posts a fresh one into the new group.
      const live = row
        && row.state === 'live'
        && row.message_id != null
        && sameChat(row.chat_id, client.telegram_chat_id)

      if (live) {
        if (typeof notify.edit !== 'function') {
          // Without an edit path the fresh-post branch would append a NEW board
          // per movement — exactly the per-delivery spam the living board exists
          // to replace. Better to leave the board stale.
          warn('edit', 'notify.edit unavailable'); return
        }

        // ONE call carries the new text AND the new grid. Two calls
        // (editMessageText then editMessageReplyMarkup) can half-fail and leave
        // a header whose total disagrees with the rows underneath it.
        const res = await notify.edit(row.chat_id, row.message_id, built)

        // ok also covers "message is not modified" — notify.edit reports that as
        // success, which is what makes calling refresh() after EVERY movement
        // free when nothing about the board actually changed.
        if (res?.ok) { write(s.touch, 'touch', client.id); return }

        if (!res?.permanent) {
          // Transient: a 429, a 5xx, a socket, a timeout. THE ROW IS LEFT
          // EXACTLY AS IT IS, so the next movement edits the same message again
          // from current state. No sleep-and-retry here: the next movement is
          // the retry, and a board that is one movement stale is a far smaller
          // fault than a chain holding a request-adjacent promise open.
          warn('edit', res?.error ?? 'edit_failed')
          return
        }

        // Permanent: deleted, chat left, rights lost, message too old to edit.
        // Recorded FIRST so that even if the fresh post below fails, this message
        // is never edited again — that is the "must not be retried forever" half.
        // Then fall through and post a new board in the same call, so the client
        // is never left without one — that is the other half.
        warn('edit', `${res.error ?? 'permanent'} (permanent) — posting a fresh board`)
        write(s.markGone, 'markGone', client.id)
      }

      // No board, a board in a group this client no longer uses, or one Telegram
      // just declared gone. Post a fresh one into the CURRENT group.
      const sent = await notify(client.telegram_chat_id, built.text, {
        reply_markup: built.reply_markup,
      })

      if (sent?.ok && sent.messageId != null) {
        // Clears 'gone' and rebinds chat_id + message_id in one statement.
        write(s.upsertLive, 'upsertLive', client.id, client.telegram_chat_id, sent.messageId)
        return
      }

      // The post failed. The row is untouched — still absent, or still 'gone'.
      // The next movement makes exactly ONE more attempt, which is bounded by
      // the rate movements happen at, not a loop.
      warn('post', sent?.skipped ? 'skipped' : (sent?.error ?? 'send_failed'))
    } catch (err) {
      // A buildBoard throw, a Telegram client fault, a busy database file. The
      // ledger row is already committed and the client's short movement line is
      // already sent; this costs a stale grid and one log line.
      warn('runRefresh', err)
    }
  }

  return { refresh }
}

export default makeBoard
