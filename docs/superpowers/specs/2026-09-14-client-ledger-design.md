# Client ledger (Mijozlar) — design

**Problem.** The owner gives products to clients on consignment, records each handover as a
message in a per-client Telegram group, and at month end reads back every message to tally what
each client took and owes. The warehouse app already logs outgoing stock but never records the
recipient, so the two records are unlinked and the tally is manual.

**Decisions taken** (from brainstorming, 2026-09-14):
- Month-end output is **quantities and money owed** — a statement, not just a count.
- Pricing is **per client**, falling back to a per-product default.
- Clients carry a **running balance**; partial payments are normal.
- It is **consignment**: unsold goods come back, and a return reduces what is owed.
- The owner records in the **Mini App**; the bot **auto-posts** a receipt to the client's group.
- The client ledger is **independent of warehouse stock** — a handover does NOT deduct stock.
- Ledger shape: **one append-only table** with a `kind` discriminator (mirrors `stock_transactions`).
- Groups are linked by the owner running **`/ulash`** in the client's group.

**Explicitly out of scope for v1:** clients using the Mini App themselves, per-client login,
invoice PDFs, multi-currency, and any coupling to `stock_items` / `stock_transactions`.

---

## 1. Data model

All money is **integer so'm**. No floats anywhere in the money path.

### `clients`
| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | |
| `phone` | TEXT NULL | |
| `telegram_chat_id` | INTEGER NULL UNIQUE | set by `/ulash`; negative for groups |
| `created_at` | DATETIME | |
| `deleted_at` | DATETIME NULL | soft delete, as `product_categories` does |

### `client_prices`
| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | |
| `client_id` | INTEGER NOT NULL FK → clients | |
| `category_id` | INTEGER NOT NULL FK → product_categories | |
| `unit_price` | INTEGER NOT NULL | so'm, > 0 |
| | | `UNIQUE(client_id, category_id)` |

### `product_categories.default_price`
New nullable `INTEGER` column. Used when a client has no override.
Price resolution: `client_prices` → `default_price` → error "narx belgilanmagan".

### `client_ledger`
| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | |
| `client_id` | INTEGER NOT NULL FK → clients | |
| `kind` | TEXT NOT NULL | `handover` · `return` · `payment` · `adjustment` |
| `category_id` | INTEGER NULL FK | set for handover/return |
| `qty` | INTEGER NULL | set for handover/return; > 0 |
| `unit_price` | INTEGER NULL | price snapshot at the time of the event |
| `amount` | INTEGER NOT NULL | **signed so'm**; the only field the balance reads |
| `note` | TEXT NULL | |
| `performed_by` | INTEGER NULL | Telegram id |
| `performed_by_name` | TEXT NULL | |
| `reverses_id` | INTEGER NULL FK → client_ledger | set when this row cancels another |
| `created_at` | DATETIME NOT NULL | |

**Sign convention.** `handover` → `+qty*unit_price`. `return` → `-qty*unit_price`. `payment` →
`-amount`. `adjustment` → either sign.
**Balance = `SELECT COALESCE(SUM(amount),0) FROM client_ledger WHERE client_id = ?`.**
There is exactly one way to compute it.

**Corrections never update or delete.** A mistake is cancelled by inserting a reversing row with
the opposite `amount` and `reverses_id` pointing at the original. A row that is already reversed
cannot be reversed twice.

### Indexes
`client_ledger(client_id, created_at)`, `client_ledger(reverses_id)`, `client_prices(client_id)`.

---

## 2. API contract

All routes require a verified Telegram user (`requireRead` for GET, `requireAuth` for mutations) —
the same guards the audit added. Money fields are integers. Errors are `{ error: "<message>" }`.

```
GET    /api/clients                  -> [{ id, name, phone, telegram_chat_id, balance }]
POST   /api/clients                  { name, phone? }            -> 201 { id, name, phone }
PATCH  /api/clients/:id              { name?, phone? }           -> { id, name, phone }
DELETE /api/clients/:id                                          -> { deleted: true }
        (refuses with 409 if balance != 0)

GET    /api/clients/:id              -> { id, name, phone, telegram_chat_id, balance }
GET    /api/clients/:id/ledger?limit=100
       -> [{ id, kind, category_id, category_name, category_path, qty, unit_price,
              amount, note, performed_by_name, reverses_id, reversed_by, created_at }]

GET    /api/clients/:id/prices       -> [{ category_id, name, path, unit_price, is_override }]
PUT    /api/clients/:id/prices/:catId { unit_price }             -> { category_id, unit_price }
DELETE /api/clients/:id/prices/:catId                            -> { removed: true }

PUT    /api/categories/:id/price     { default_price }           -> { id, default_price }

POST   /api/clients/:id/handover     { category_id, qty, note? } -> { entry, balance }
POST   /api/clients/:id/return       { category_id, qty, note? } -> { entry, balance }
POST   /api/clients/:id/payment      { amount, note? }           -> { entry, balance }
POST   /api/ledger/:entryId/reverse  { note? }                   -> { entry, balance }

GET    /api/clients/:id/statement?year=YYYY&month=MM
       -> { client, period, opening, handovers[], returns[], payments[],
            totals: { given, returned, paid }, closing }
GET    /api/statements.xlsx?year=YYYY&month=MM    (all clients, one sheet per client + summary)
POST   /api/clients/:id/statement/send  { year, month }  -> { sent: true }
```

**Validation, applied to every mutating route:**
`Number.isInteger` on every numeric field; `qty` in `[1, 99999]`; `amount` and `unit_price` in
`[1, 10_000_000_000]`; `category_id` must exist, not be soft-deleted, and have no active children
(same `stockTarget` rule the stock routes use); `client_id` must exist and not be soft-deleted.
A `return` may not exceed the net quantity of that product the client currently holds.

---

## 3. Screens (Mini App)

A fourth tab, **Mijozlar**, beside the existing three.

**Client list** — name, balance (red when owed, green at zero), search. `+` adds a client.

**Client detail** — balance at the top, then three actions (**Berish** / **Qaytarish** /
**To'lov**) and the ledger below, newest first, grouped by day like the existing history page.
Reversed rows render struck through. Each row shows product, qty, unit price and amount.

**Berish / Qaytarish** — product picker reusing the existing category tree, quantity stepper
reusing `ActionPage`'s input, resolved unit price shown before confirming, total computed live.

**To'lov** — amount, optional note.

**Prices** — per-client price list, showing the default and any override.

**Statement** — month picker; renders the statement and offers "Telegramga yuborish".

All UI text in Uzbek, matching the existing pages. Money formatted with thousands separators
(`2 400 000 so'm`).

---

## 4. Telegram group integration

`/ulash` run in a group: the bot checks the sender is `ADMIN_ID`, then replies with the group's
title and a 6-character code. The owner enters that code in the Mini App against a client, which
binds `telegram_chat_id`. Codes expire after 15 minutes and are single-use.

After a successful handover / return / payment, the bot posts a receipt into the linked group:

```
📦 Berildi: Ali cantara safir Qora — 5 dona × 120 000 = 600 000 so'm
📅 14.09.2026 15:04
💰 Umumiy qarz: 2 400 000 so'm
```

**Posting never blocks the ledger write.** The row is committed first; the post is attempted after
and its failure is logged, not surfaced as an error. A client with no linked group simply gets no
post. This matters because a Telegram outage must not stop the owner recording business.

---

## 5. Module boundaries

New code goes in new files; existing files change only where they must.

| file | responsibility |
|---|---|
| `server/clients.js` | clients, prices, ledger routes + balance logic (Fastify plugin) |
| `server/statement.js` | statement assembly + Excel workbook |
| `server/notify.js` | posting receipts to Telegram; never throws into a request |
| `frontend/src/pages/ClientsPage.tsx` | list |
| `frontend/src/pages/ClientDetailPage.tsx` | balance, actions, ledger |
| `frontend/src/hooks/useClients.ts` | react-query hooks |
| `frontend/src/api/clients.ts` | typed client for the routes above |
| `handlers/groups.py` | `/ulash` |
| `database/models.py` | the three new tables + `default_price` |

Wiring changes, kept minimal: `server/index.js` registers the two plugins; `bot.py` registers the
`/ulash` handler; `BottomNav.tsx` and `App.tsx` gain the fourth tab.

---

## 6. Error handling

Unlike the existing pages — where the audit found `isError` is never handled anywhere — every new
screen renders three states explicitly: loading, error with a retry, and empty. Every mutation
has an `onError` that shows the server's message. New code does not repeat that defect.

## 7. Testing

Each module ships with tests that run against a temporary SQLite file:
balance arithmetic including reversals; price resolution and its fallback; the full validation
matrix (negative, fractional, string, oversized, missing client, soft-deleted category);
return-exceeds-held rejection; statement opening/closing balance across a month boundary in
Tashkent time; and that a Telegram failure still commits the ledger row.
