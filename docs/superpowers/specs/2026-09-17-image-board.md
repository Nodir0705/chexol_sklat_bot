# Living image board

Owner's decision after trying text receipts, a poll, per-delivery images, and a button-grid board:
**the image, made editable.** One photo message per client group, replaced in place on every
movement, with buttons underneath.

## Verified against the live Bot API (2026-09-17, real calls, message 146)

- `sendPhoto` WITH `reply_markup`: **OK**. A photo message can carry an inline keyboard.
- `editMessageMedia` + `reply_markup` in one call: **OK** — the picture AND the buttons are
  replaced together, so they can never disagree.
- `editMessageReplyMarkup` on a photo message: **OK** — buttons alone.

## Shape

    ┌──────────────────────────────────┐
    │  📦 HER            ▲             │   the image: the client's whole ledger,
    │  Jami qarz  2 120 000            │   full product names, aligned columns,
    │  ──────────────────────────────  │   date grouping, the balance as hero
    │  17.09  Tarpetka › Damas         │
    │      9 dona           1 080 000  │
    │  15.09  Cristal › Qora           │
    │     10 dona             800 000  │
    │  ──────────────────────────────  │
    │  JAMI QARZ            2 120 000  │
    └──────────────────────────────────┘
    caption: 📦 Berildi · 1 080 000 so'm · Jami qarz: 2 120 000 so'm
    [ ✏️ Tahrirlash ]  [ 📊 Hisobot ]

- The IMAGE carries everything visual. It already renders 50 items with a fold, full names and
  correct alignment — that machinery exists and is tested.
- The CAPTION is one line: direction, movement, balance. It is the client's notification (editing
  a message notifies nobody, so each movement also posts one short line) and the searchable record.
- The KEYBOARD is two buttons and NEVER changes. That is deliberate: an inline keyboard is shared
  state on the message, so a picker opened in place would appear on the client's phone too, and be
  tappable by them.

## Editing

`✏️ Tahrirlash` → operator gate on `callback_query.from.id`
  → operator: `answerCallbackQuery(url = t.me/<bot>?start=b_<clientId>)`, opening the bot privately,
    where a `web_app` button opens the Mini App on that client's ledger. Every row is editable
    there, through `POST /api/ledger/:entryId/edit`, which already exists and appends a reversal
    plus a corrected re-entry.
  → anyone else (including the client, who is in this group): a plain toast. No url, and nothing
    that reveals an edit affordance exists.

`📊 Hisobot` → any group member: a toast with the current balance and this month's totals. It is
their own account; nothing about other clients is reachable.

After any edit the board re-renders and `editMessageMedia` replaces it in place.

## Rules carried over, not to be re-litigated

- `client_ledger` is APPEND-ONLY. An edit writes a reversal plus a re-entry (`corrects_id`).
  Balance is always `SUM(amount)`.
- The board is REBUILT from the ledger on every update, never accumulated, so it cannot drift.
- A Telegram failure NEVER affects a ledger write or an API response.
- The STORED chat_id is used to edit; a re-link must not edit a stranger's group.
- `state='gone'` when Telegram reports the message deleted, so the next movement posts afresh.
- If rendering or upload fails, fall back to the text receipt. The client always learns what they
  received.
