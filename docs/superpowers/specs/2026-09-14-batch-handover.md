# Batch handover + product naming — spec

Owner feedback, 2026-09-14: "messages sent to group aren't beautiful, also items are sent
one by one, I want group selection send also."

Owner chose, from rendered options:
- MESSAGE SHAPE: **compact list** — one line per product, a rule, a total, then the balance.
- APP FLOW: **multi-select, then quantities** — tick several products, set each quantity on a
  second screen, send once.

## 1. Message shape (chosen by the owner)

```
📦 <b>Berildi</b>
<blockquote>{label} · {qty} dona · {total}
{label} · {qty} dona · {total}
{label} · {qty} dona · {total}
──────────
Jami: {grandTotal} so'm
{at}</blockquote>
<b>Jami qarz: {balance} so'm</b>
```

A SINGLE item must render exactly as it does today (the existing one-item template with
`qty × price = total`), NOT as a one-row list. Only two or more items use the list form.

TENSION TO RESOLVE, deliberately left to you: productLabel below makes labels longer
("Tarpetka › Damas"), and the compact list wants short lines. On a 320px screen
"Tarpetka › Damas · 5 dona · 600 000" will wrap. Decide and justify: either the label owns
its own line with qty/total beneath, or the parent renders in a quieter form. Do NOT let it
silently wrap into mush — that is the ugliness the owner is complaining about.

## 2. Product naming rule (decided by a judged workflow, 8.0/10)

`productLabel(categoryName, parentName)` — always "Parent › Leaf", EXCEPT when the leaf's
token sequence already contains the parent's token sequence as a contiguous in-order run, in
which case just the leaf.

```js
const PATH_SEP = ' › '   // U+203A — already used by fullPath() and the Excel Joylashuv column

// NFC, then .toLowerCase() (locale-INDEPENDENT by spec; toLocaleLowerCase IS locale-sensitive
// and is deliberately not used). Unify apostrophe variants -- o'/o'/o'/o'/o' is one Uzbek
// letter typed five ways -- and keep the apostrophe INSIDE the token so "qo'shimcha" stays
// one word. Everything else non-alphanumeric (space, !, (, ), -, ., emoji, ZWJ, variation
// selectors) is a token break.
const tokens = n => String(n ?? '').normalize('NFC').toLowerCase()
  .replace(/[‘’ʻʼ`´]/g, "'")
  .split(/[^\p{L}\p{N}']+/u).filter(Boolean)
```

Empty parent tokens (a name of pure punctuation/emoji) → NOT contained → keep the parent.
The asymmetry is intentional: a false suppression is an unrecoverable ambiguous receipt; a
false retention costs ~11 characters.

Worked against the real tree:

| category | parent | label |
|---|---|---|
| Ali cantara safir Qora | Ali cantara safir | `Ali cantara safir Qora` |
| Qora | Cristal | `Cristal › Qora` |
| Damas | Tarpetka | `Tarpetka › Damas` |
| Damas | !Tikuvda tarpetka💈 | `!Tikuvda tarpetka💈 › Damas` |
| Matiz | Tarpetka | `Tarpetka › Matiz` |
| Donalik | Ali cantara safir | `Ali cantara safir › Donalik` |

Measured over the 23 bookable leaves: product line median 5 → 18 chars, 20 of 23 leaves change,
max unchanged (33 → 33).

REJECTED, do not re-litigate:
- Stripping "!"/emoji "chrome" from ancestor names. Renaming the root "Tarpetka 🚗" would
  silently revert every receipt to the bare name — the reported bug restored, no error anywhere.
- Showing the ROOT instead of the parent. Both Damas rows have root "Tarpetka", so it resolves
  nothing that mode 1 needs, and costs characters on the most frequent message.
- Showing the parent only when the name collides. "Qora" is unique as a leaf string, so a
  collision-conditional rule still prints a bare colour.

The parent name must come from a JOIN added to LEDGER_SELECT, NOT from splitting
`category_path` — POST /api/categories only trims the name, so an owner-entered name may
itself contain " › ".

## 3. Batch API

```
POST /api/clients/:id/handover/batch   { items: [{ category_id, qty }], note? }
POST /api/clients/:id/return/batch     same shape
```

- ONE transaction. All items commit or none do.
- One `client_ledger` row PER ITEM. The ledger stays per-product; batching is a presentation
  and atomicity concern, not a schema change.
- ONE Telegram message for the whole batch, posted after commit.
- Per-item validation identical to the single routes: integer qty in [1, 99999]; category
  exists, is not soft-deleted, has no active children; price resolvable. A single bad item
  fails the WHOLE batch with an error naming which item and why.
- Reject an empty `items` array, and a batch of more than 50 items.
- The same category twice in one batch: merge the quantities rather than writing two rows.
- Returns must still honour the return-exceeds-held rule, evaluated across the whole batch.
- Response: `{ entries: [...], balance, total }`.

## 4. Also fix

`statement.js` writes bare `category_name` into the workbook's Mahsulot column, so a receipt
saying "Tarpetka › Damas" would not word-match the monthly file the client opens. Use the same
productLabel.

## 5. Noted, not in scope

There is no rename route for categories anywhere (`server/index.js` has POST, GET :id/impact,
DELETE only; DELETE is a soft delete and re-creating mints a new id, orphaning client_prices,
client_ledger and stock_items). That absence is why the catalogue accumulated six colliding
names and three bare ones. Fixing it is a separate piece of work, offered to the owner.
