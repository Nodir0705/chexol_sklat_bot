# Living board — one growing table per client

Owner chose this over per-delivery receipts, from rendered options: ONE message per client group
holding an inline-keyboard grid that every delivery appends to. The bot edits that message; it is
never re-posted.

## Verified against the live Bot API (2026-09-17, real calls)

- 400 rows × 3 buttons = 51 005 B of `reply_markup`: **accepted**. No ceiling found in practice.
- Button text of 128 chars: accepted (it is visually clipped, not rejected).
- `editMessageReplyMarkup` grows a grid in place: **OK**.
- `editMessageText` with a new `reply_markup` in one call: **OK**.

So the constraint is READABILITY, not the API.

## Shape

```
📦 Her · Jami qarz: 7 570 000 so'm      <- message TEXT (bold, carries the balance)

┌──────────────────┬──────┬───────────┐  <- inline keyboard, one row per movement
│ MAHSULOT         │ DONA │   SUMMA   │
│ 14.09 Damas      │    5 │   600 000 │
│ 15.09 Qora       │   10 │   650 000 │
│ 17.09 Matiz      │    3 │   330 000 │
│ JAMI QARZ        │   18 │ 7 570 000 │
└──────────────────┴──────┴───────────┘
```

- Header row and a final JAMI QARZ row are always present.
- Newest movement at the BOTTOM, so the table reads like a ledger and the total stays adjacent
  to the most recent entry.
- Visible row cap: **25 movements**. Older ones fold into a single row
  `+N oldingi · <qty> dona · <summa>` placed directly under the header. The cap is about a phone
  screen, not the API.
- A reversed movement stays in the table prefixed `✗` and is excluded from the JAMI totals.
  Buttons cannot render strikethrough, so the prefix is the only channel available.
- Date prefix is `DD.MM`. Product label is `productLabel(category_name, parent_name)` truncated
  to fit; the date is never truncated.

## Notifications

Editing a message notifies nobody. So each movement ALSO posts one short text line:

    📦 <b>Berildi</b> · 1 250 000 so'm · Jami qarz: <b>7 570 000 so'm</b>

That is the client's notification and their searchable record. The board carries the detail.
This is far less noise than a full receipt per delivery, which is what the owner objected to.

## Tapping a row

Every button needs `callback_data`, and an unanswered callback leaves a spinner on the client's
phone forever. The PYTHON bot receives these (not the Node server), so it must answer every one.

- `callback_data` is `led:<ledger_id>` for a movement row, `boardhdr` for the header/total/fold.
- The handler answers with a toast: product, quantity, unit price, total, who recorded it, when.
- It must answer EVERY callback it matches, including unknown ids, within Telegram's ~15s window.

## Schema (server/schema.js — the single DDL owner)

    client_boards(
      client_id   INTEGER PRIMARY KEY REFERENCES clients(id),
      chat_id     INTEGER NOT NULL,
      message_id  INTEGER,
      state       TEXT NOT NULL DEFAULT 'pending',   -- pending | live | gone
      updated_at  DATETIME
    )

Display state only. No column feeds SUM(amount); dropping the table must leave every balance
bit-for-bit identical, exactly as receipt_posts does.

## Rules carried over, not to be re-litigated

- The ledger stays APPEND-ONLY. The board is a view of it, rebuilt from `client_ledger` on every
  update — never an accumulator that could drift from SUM(amount).
- A Telegram failure NEVER affects the ledger write or the API response.
- Use the STORED chat_id to edit; a re-link must not edit a stranger's group.
- `state='gone'` when Telegram reports the message deleted, so the next movement posts a fresh
  board instead of retrying forever.
- Money is integer so'm, U+00A0 separators, Tashkent time.
