// Living board — ONE growing message per client group, edited in place.
//
// A client's group holds exactly one board: a PHOTO of the whole ledger, with a
// caption and two buttons under it. Every movement REBUILDS that picture from the
// ledger rows it is handed and EDITS the message. Nothing here accumulates; there
// is no counter, no running total, no "add one row to what is already there".
// That is why the board's JAMI can never drift from SUM(amount): the only
// arithmetic in the system lives in the rows the caller SELECTed, and this module
// is a transport for them.
//
// ─── Picture, with text as the floor ──────────────────────────────────────────
//
// The board is rendered TWO ways on every movement: boardImage() for the picture
// and buildBoard() for the text board that predates it. The picture is posted
// when it renders and uploads; the text board goes out when either fails. A
// picture is a nicety — the client knowing their balance is not — so there is no
// path here on which a movement leaves the group with nothing.
//
// WHICH FORM WENT OUT IS RECORDED (client_boards.is_photo), because it decides
// how the NEXT movement edits: editMessageMedia for a photo, editMessageText for
// a text message. Telegram refuses the mismatch, so an unrecorded form is not a
// cosmetic slip, it is every later edit failing. Two consequences worth stating
// plainly:
//
//   - A text board is never UPGRADED to a photo in place. editMessageMedia
//     cannot turn a text message into a photo, so a board that fell back stays
//     text until Telegram declares it gone and a fresh one is posted. Boards
//     that predate this file's photo support have is_photo = 0 and behave
//     exactly as they always did.
//   - A LIVE PHOTO board whose picture fails to render this time is left ALONE.
//     It cannot be edited as text, and posting a text board beside it would give
//     the client two boards disagreeing about their debt. One movement stale is
//     the smaller fault; the next movement is the retry.
//
// This module owns client_boards (client_id → chat_id, message_id, state) and
// nothing else. It is display state, not money: no column here feeds
// SUM(amount), no route computes a balance from it, and DROP TABLE client_boards
// leaves every balance bit-for-bit identical — the same contract receipt_posts
// keeps. It imports NOTHING from clients.js; both renderers — `buildBoard` and
// `boardImage` — are injected, so the dependency runs one way only.
//
// THE STANDING RULE OF THIS SERVER, which every line below obeys: a notification
// concern never affects the ledger write or the API response. refresh() is
// total — it returns a promise that always resolves, and it never throws into
// its caller.
//
// ── The renderer and notify contracts this file assumes ───────────────────────
// Both renderers are PURE — rows in, Telegram's own vocabulary out — and their
// output is passed through VERBATIM, with no translation step that could drift:
//
//   img   = boardImage(rows, { clientName, balance })  → { svg, width, height, caption }
//   built = buildBoard(rows, { clientName, balance })  → { text, reply_markup }
//
//   notify.photo(chatId, { svg, caption, reply_markup })   → { ok, messageId, photo }
//                                                          | { ok: false, error }
//   notify(chatId, built.text, { reply_markup })           → { ok, messageId }
//   notify.edit(chatId, messageId, { isPhoto, svg, caption, reply_markup })
//   notify.edit(chatId, messageId, built)                  → { ok }
//                                                          | { ok: false, permanent, error }
//                                                          | { ok: false, error, retryAfter? }
//
// notify.edit takes ONE object and the `isPhoto` flag in it selects the method:
// editMessageMedia carries svg + caption + reply_markup, editMessageText carries
// text + reply_markup. Either way the whole message is replaced in ONE call, so
// no part of a board can ever disagree with another part of the same board.
//
// The picture is OPTIONAL. Without a boardImage dependency — or with one that
// throws — every board is the text board, which is what this module did before
// the picture existed and what it must keep doing when the picture is unavailable.

// ── The keyboard ──────────────────────────────────────────────────────────────
//
// TWO BUTTONS, AND THEY NEVER CHANGE. That is a design constraint, not an
// unfinished feature: an inline keyboard is SHARED STATE ON THE MESSAGE. A picker
// "opened in place" would open on the client's phone too — the client is in this
// group — and be tappable by them. So nothing here is ever a mode, a step or a
// selection; both buttons are one-shot requests answered with answerCallbackQuery
// (a toast, or a url that opens the bot privately, where per-user state is legal).
//
// CONTRACT WITH handlers/board.py — these two literal strings are the whole
// interface, and the Python side must match them exactly:
//
//   bed:<clientId>   ✏️ Tahrirlash — operator-gated on callback_query.from.id;
//                    an operator is answered with url = t.me/<bot>?start=b_<clientId>,
//                    anyone else (the client included) with a plain toast that
//                    reveals no edit affordance.
//   brp:<clientId>   📊 Hisobot — any group member: a toast with the balance and
//                    this month's totals. Their own account, nothing else reachable.
//
// The 4-byte prefix follows board-grid.js's `led:` / `edq:` / `eds:` vocabulary.
// Telegram caps callback_data at 64 bytes; a SQLite rowid is at most 19 digits,
// so `bed:` + id is at most 23 and cannot overflow in this universe.
const KB_EDIT   = 'bed:'
const KB_REPORT = 'brp:'

/** The board's keyboard. Identical on the fresh post and on every edit, so the
 *  two can never disagree about what the buttons are. */
function boardKeyboard(clientId) {
  return {
    inline_keyboard: [[
      { text: '✏️ Tahrirlash', callback_data: `${KB_EDIT}${clientId}` },
      { text: '📊 Hisobot',    callback_data: `${KB_REPORT}${clientId}` },
    ]],
  }
}

/**
 * @param {object}   deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {Function} deps.notify      the notifier; needs notify.edit, and
 *                                    notify.photo for the picture
 * @param {Function} deps.buildBoard  buildBoard(rows, { clientName, balance })
 *                                      → { text, reply_markup }
 * @param {Function} [deps.boardImage] boardImage(rows, { clientName, balance })
 *                                      → { svg, width, height, caption }.
 *                                    Absent, every board is a text board.
 */
export function makeBoard({ db, notify, buildBoard, boardImage } = {}) {
  // Which FORM the stored message took. Additive, defaulted, and applied the way
  // every other late column in this server is (server/index.js, server/schema.js):
  // an existing row reads 0 and is a text board, which is exactly what it is.
  // MUST run before the prepares below — upsertLive names the column.
  try {
    db.exec('ALTER TABLE client_boards ADD COLUMN is_photo INTEGER NOT NULL DEFAULT 0')
  } catch { /* already there */ }

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
    //
    // is_photo is written on EVERY fresh post, 1 or 0, never left to the column
    // default: the row that records where the board lives must also record what
    // it is, or the next movement edits it down the wrong method.
    upsertLive: db.prepare(`
      INSERT INTO client_boards (client_id, chat_id, message_id, state, is_photo, updated_at)
      VALUES (?, ?, ?, 'live', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(client_id) DO UPDATE SET
        chat_id    = excluded.chat_id,
        message_id = excluded.message_id,
        state      = 'live',
        is_photo   = excluded.is_photo,
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

  /**
   * The picture, or null if there is not going to be one.
   *
   * TOTAL, like everything else here: a renderer that throws, returns nothing,
   * or returns something that is not a usable SVG is a MISSING PICTURE, which is
   * a condition this module already handles, not an exception for a caller to
   * catch. Validated here rather than at the upload, so a fresh post never
   * spends a round trip discovering that `svg` was undefined.
   *
   * Deliberately independent of notify.photo: an ALREADY-LIVE photo board is
   * edited through notify.edit and still needs a picture, so tying the render to
   * the poster would freeze such a board the moment the poster went missing.
   */
  function renderImage(client, rows, balance) {
    if (typeof boardImage !== 'function') return null
    try {
      const img = boardImage(rows, { clientName: client.name, balance })
      if (!img || typeof img.svg !== 'string' || !img.svg.trim()) {
        warn('boardImage', 'no svg'); return null
      }
      // The caption is the client's searchable record and their push line, but a
      // picture with a missing caption still shows the whole ledger — so a bad
      // caption costs the caption, not the board.
      return { svg: img.svg, caption: typeof img.caption === 'string' ? img.caption : '' }
    } catch (err) {
      warn('boardImage', err)
      return null
    }
  }

  async function runRefresh({ client, rows, balance }) {
    try {
      // Both renderings happen BEFORE anything is read or written: a renderer
      // fault must cost a log line and leave the stored board exactly as it was,
      // not a half-applied state change.
      //
      // The TEXT board is built unconditionally, even when the picture renders.
      // It is the floor under every path below and it is a pure function over
      // rows already in memory; making it conditional would trade nothing for a
      // branch that is only exercised on the day the renderer breaks.
      const built = buildBoard(rows, { clientName: client.name, balance })
      if (!built || typeof built.text !== 'string') {
        warn('buildBoard', 'no text'); return
      }
      const img = renderImage(client, rows, balance)
      const keyboard = boardKeyboard(client.id)

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

        // THE STORED FORM DECIDES THE METHOD. Telegram will not edit a photo
        // message as text or a text message as media, so this flag — not what we
        // happen to have rendered this time — is what selects the call.
        const wasPhoto = !!row.is_photo

        if (wasPhoto && !img) {
          // A live photo board and no picture to put in it. There is no second
          // move here: editMessageText would be refused, and posting the text
          // board fresh would leave the client with TWO boards, the old one
          // frozen at a stale total. Treated exactly like a transient edit
          // failure — row untouched, next movement is the retry.
          warn('edit', 'no image for a photo board — leaving it stale')
          return
        }

        // ONE call carries the new picture AND its caption AND its buttons — or
        // the new text AND its grid. Two calls (edit the content, then edit the
        // markup) can half-fail and leave a board whose buttons or header
        // disagree with the rows underneath them.
        const res = wasPhoto
          ? await notify.edit(row.chat_id, row.message_id,
              { isPhoto: true, svg: img.svg, caption: img.caption, reply_markup: keyboard })
          : await notify.edit(row.chat_id, row.message_id, built)

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
      // just declared gone. Post a fresh one into the CURRENT group — as a
      // PICTURE if there is one and it uploads, otherwise as the text board.
      //
      // THE FALLBACK IS A DEGRADE, NOT A RETRY. The one-attempt-per-movement rule
      // is about never hammering the same failing call; this is the second FORM
      // of the message, tried once, and it is the same shape notify.receipt has
      // used for every receipt this server has ever sent. If both fail the row is
      // left untouched and the next movement makes exactly one more attempt.
      let sent = null
      let posted = 0        // what actually went out: 1 photo, 0 text
      if (img && typeof notify.photo === 'function') {
        sent = await notify.photo(client.telegram_chat_id, {
          svg: img.svg, caption: img.caption, reply_markup: keyboard,
        })
        if (sent?.ok && sent.messageId != null) posted = 1
        else warn('photo', sent?.skipped ? 'skipped' : (sent?.error ?? 'send_failed'))
      }

      if (!posted) {
        sent = await notify(client.telegram_chat_id, built.text, {
          reply_markup: built.reply_markup,
        })
      }

      if (sent?.ok && sent.messageId != null) {
        // Clears 'gone' and rebinds chat_id + message_id + is_photo in one
        // statement. is_photo is what every later edit reads to pick its method,
        // so it is written from what was ACTUALLY posted, never from what was
        // attempted.
        write(s.upsertLive, 'upsertLive',
          client.id, client.telegram_chat_id, sent.messageId, posted)
        return
      }

      // The post failed. The row is untouched — still absent, or still 'gone'.
      // The next movement makes exactly ONE more attempt, which is bounded by
      // the rate movements happen at, not a loop.
      warn('post', sent?.skipped ? 'skipped' : (sent?.error ?? 'send_failed'))
    } catch (err) {
      // A renderer throw the guards above did not catch, a Telegram client
      // fault, a busy database file. The ledger row is already committed and the
      // client's short movement line is already sent; this costs a stale board
      // and one log line.
      warn('runRefresh', err)
    }
  }

  return { refresh }
}

export default makeBoard
