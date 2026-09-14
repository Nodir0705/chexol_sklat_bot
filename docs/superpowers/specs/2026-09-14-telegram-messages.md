# Telegram group message redesign — final spec
Produced by a 4-design / 3-judge / 1-synthesis workflow. Winner: 'receipt' (7.3/10).
## Summary
FINAL DESIGN — one receipt grammar, four lines of chrome, zero <pre>.

Base: the winning "receipt" design. Every message is: bold emoji+verb header / <blockquote> detail box / one bold bottom line naming the balance. Ten in a row read as a running account book: a column of type-badges down the left edge, a column of balances down the bottom.

GRAFTED FROM RUNNERS-UP (judges' named "strongest ideas"):
- structured: "an icon per line is a bullet list, an icon per message is a badge" — exactly one owner-controlled emoji per message, always character 1. 📅/💰 deleted (tautologies next to a date and a debt figure).
- ledger: the product name owns a full-width line, qty × price = total on its own line beneath. This is what makes refusing <pre> honest — "Ali cantara safir dark bule (Kok)" wraps into itself instead of shattering the arithmetic.
- conversational: the reversal quotes the WHOLE original entry inside <blockquote>, so a cancelled payment and a cancelled handover are structurally unconfusable and the quote block says "this refers to something earlier" before a word is read.
- ledger's balance-first hero was NOT grafted: it conflicts head-on with the invariant bottom line, which 5 of 9 judges named the single strongest idea in the whole set. The preview win it was after is recovered instead by moving the timestamp off line 1 (see below), so the notification now opens with verb + product + amount.

FIXES TO EVERY WEAKNESS THE JUDGES NAMED:
1. Reversal no longer depends on <s> for its meaning. The header word "Bekor qilindi" is characters 3-16 of the message, and the quote's first line is an UNSTRUCK reference to the cancelled entry ("Berildi · 14.09.2026 15:04"). Strip every entity — push preview, 2019 third-party client — and it still reads as a cancellation, not a fresh sale.
2. The reversal now shows its note (the reason), unstruck, the one message where a dispute needs a sentence. The auto-placeholder "Bekor qilindi #47" is filtered out so it never prints noise.
3. Notes are escaped, whitespace-collapsed and capped at 120 chars. This was the redesign's own new hole: cleanNote() trims to 500 and does not escape, so one owner note containing "&" would make Telegram reject the message and the client would silently stop getting receipts.
4. Timestamp demoted to the last line INSIDE the quote. Constraint 5 is hard and a forwarded/screenshotted receipt loses Telegram's day separator, so the date stays — but it no longer spends ~20 preview characters restating a time Telegram already prints. The reversal carries the CANCELLED entry's stamp instead of its own (Telegram supplies "now"), which also kills the two-unlabelled-timestamps confusion.
5. Bare "Qarz:" fixed → "Jami qarz:" (three judges: bare Qarz sitting under "= 600 000 so'm" is ambiguous between this sale and the running total; "Jami" is already in the vocabulary). Statement keeps "Oy oxiriga qarz" verbatim, word-for-word with the workbook strings at statement.js:340-341.
6. Overpayment: the label flips to "Oldindan to'lov: 160 000 so'm" — never "Qarz: -160 000", which reads as a broken bot. Two branches only, >= 0 and < 0. The honest claim is "one bold slot in one fixed position whose label names what the number is", not "an identical line"; that is what the judges said was true and worth keeping.
7. The fifth live kind is covered: adjustment / ✏️ Tuzatish now has a template (and so does a reversal of one). headlineFor already falls through to it, so "one grammar" no longer breaks on a real code path.
8. "To'lov" → "To'landi" in receipts: Berildi / Qaytarildi / To'landi are all past passives; "To'lov" was a bare noun in the same slot, which reads as an unfinished rename. It also matches the workbook.
9. /ulash: "Guruh:" restored (an owner with forty groups is confirming WHICH group is bound, not reading a heading); "kodni qo'ying" → "kodni kiriting" (qo'ymoq is to place; entering a value is kiritmoq); the imperative chain ends on a verb, not a bare noun; the CopyTextButton-absent fallback branch is preserved.
10. Statement caption: its <b> tags ship as literal text today — statement.js appends only chat_id/caption/document with no parse_mode. Fixed, with esc() on interpolated text, the conditional Tuzatish line, and a caption that finally names the document ("2026-yil sentabr hisoboti", the native izafa the code already builds).
11. Money separator: U+00A0 NO-BREAK SPACE, in the digit groups AND before "so'm", so "2 400 000 so'm" can never break across a line. All three formatters emit an ordinary U+0020 today, which does break on a 320px screen — a receipt showing "2 400" at a line end is a trust defect. DEVIATION FROM CONSTRAINT 4, needs owner sign-off: the constraint says "thin space" (U+202F); U+202F has documented tofu on older Android/Windows font stacks, and a missing-glyph box inside the debt figure is worse than slightly loose tracking. U+00A0 serves the constraint's intent and matches its worked example.

DELIBERATELY REJECTED (so nobody re-litigates):
- "Sizda: 17 dona" (held quantity) on receipts — real value for consignment, but it makes the most frequent message six lines, and constraint 8 is the one the judges said matters most. Belongs in the Mini App, not in every receipt.
- "Qarz: 2 400 000 → 1 800 000" movement arrows — cost the invariant bottom line for a number the client can read off the previous receipt.
- ASCII apostrophe kept in so'm / To'landi (correct Uzbek Latin is U+02BB). U+02BB appears in zero files in the repo; changing it is a repo-wide decision, not a receipt decision. Flagged, not slipped in.
- {client} and {path} are intentionally unused: Telegram prints the filename above the caption, and the category leaf is already a full self-describing name ("Ali cantara safir Qora"), so the full › path is noise.

## Messages

### handover

```
TEMPLATE
📦 <b>Berildi</b>
<blockquote>{product}
{qty} dona × {unitPrice} = {total} so'm{note}
{at}</blockquote>
<b>Jami qarz: {balance} so'm</b>

{product} = esc(category_name), leaf only. {note} = "\n<i>" + escaped note + "</i>" or "".

FILLED
📦 <b>Berildi</b>
<blockquote>Ali cantara safir Qora
5 dona × 120 000 = 600 000 so'm
14.09.2026 15:04</blockquote>
<b>Jami qarz: 2 400 000 so'm</b>

LONG NAME (name owns its line, arithmetic never splits)
📦 <b>Berildi</b>
<blockquote>Ali cantara safir dark bule (Kok)
12 dona × 120 000 = 1 440 000 so'm
14.09.2026 15:04</blockquote>
<b>Jami qarz: 3 840 000 so'm</b>
```

### return

```
TEMPLATE
↩️ <b>Qaytarildi</b>
<blockquote>{product}
{qty} dona × {unitPrice} = {total} so'm{note}
{at}</blockquote>
<b>Jami qarz: {balance} so'm</b>

No minus sign: the verb carries the direction and the bottom line visibly drops.
"2 × 120 000 = −240 000" is false arithmetic, and a client who checks a receipt
by hand must never find a wrong sum on it.

FILLED
↩️ <b>Qaytarildi</b>
<blockquote>Ali cantara safir Qora
2 dona × 120 000 = 240 000 so'm
14.09.2026 16:20</blockquote>
<b>Jami qarz: 2 160 000 so'm</b>
```

### payment

```
TEMPLATE
💵 <b>To'landi</b>
<blockquote>{total} so'm{note}
{at}</blockquote>
<b>Jami qarz: {balance} so'm</b>

FILLED
💵 <b>To'landi</b>
<blockquote>600 000 so'm
<i>Naqd, do'konda</i>
14.09.2026 17:05</blockquote>
<b>Jami qarz: 1 800 000 so'm</b>

OVERPAYMENT — bottom line flips, magnitude printed, never "-160 000":
<b>Oldindan to'lov: 160 000 so'm</b>

ADJUSTMENT (kind='adjustment', same body shape — the fifth live kind):
✏️ <b>Tuzatish</b>
<blockquote>−50 000 so'm{note}
{at}</blockquote>
<b>Jami qarz: {balance} so'm</b>
This is the ONLY message carrying a sign (+ U+002B / − U+2212): no verb states
its direction, and the sign is not hanging off an "=".
```

### reversal

```
TEMPLATE — goods kinds
❌ <b>Bekor qilindi</b>
<blockquote>{origLabel} · {at}
<s>{product}</s>
<s>{qty} dona × {unitPrice} = {total} so'm</s>{note}</blockquote>
<b>Jami qarz: {balance} so'm</b>

TEMPLATE — payment / adjustment (no goods lines)
❌ <b>Bekor qilindi</b>
<blockquote>{origLabel} · {at}
<s>{total} so'm</s>{note}</blockquote>
<b>Jami qarz: {balance} so'm</b>

{at} is the CANCELLED entry's stamp, not this one's — the message points
backwards, and Telegram already stamps "now". {origLabel} is the original kind's
label (Berildi / Qaytarildi / To'landi / Tuzatish) and is NOT struck: it is the
reference to the row being killed, and it is what keeps the message readable
when a push preview strips every entity. {note} is the owner's reason, unstruck,
suppressed when it is the auto-placeholder "Bekor qilindi #47".

FILLED
❌ <b>Bekor qilindi</b>
<blockquote>Berildi · 14.09.2026 15:04
<s>Ali cantara safir Qora</s>
<s>5 dona × 120 000 = 600 000 so'm</s>
<i>Miqdor xato kiritilgan</i></blockquote>
<b>Jami qarz: 1 800 000 so'm</b>

ENTITIES STRIPPED (push preview) — still unmistakably a cancellation:
❌ Bekor qilindi  Berildi · 14.09.2026 15:04  Ali cantara safir Qora …
```

### ulash

```
TEMPLATE — owner-facing, 📋 Kodni nusxalash button attached below
🔗 Guruh: <b>{group}</b>

<code>{code}</code>

Mini App → Mijozlar → mijozni tanlang → kodni kiriting va <b>Ulash</b> tugmasini bosing.
Shundan keyin har bir berish, qaytarish va to'lov shu guruhga yoziladi.
<i>Kod 15 daqiqa amal qiladi va faqat bir marta ishlatiladi.</i>

When CopyTextButton is None (PTB < 21.7), append unchanged:
\n\n👆 Kodni bosib nusxalang.

FILLED
🔗 Guruh: <b>Nodir 🥋 and Her</b>

<code>EN82M5</code>

Mini App → Mijozlar → mijozni tanlang → kodni kiriting va <b>Ulash</b> tugmasini bosing.
Shundan keyin har bir berish, qaytarish va to'lov shu guruhga yoziladi.
<i>Kod 15 daqiqa amal qiladi va faqat bir marta ishlatiladi.</i>

The one-emoji law is "one emoji I control" — 🥋 here is group-title data.
⏳ is dropped: the TTL is a footnote, so it is set as one.
```

### statement

```
TEMPLATE — sendDocument caption; REQUIRES form.append('parse_mode','HTML')
📄 <b>{period} hisoboti</b>
<blockquote>Oy boshiga qarz: {opening} so'm
Berildi: {given} so'm
Qaytarildi: {returned} so'm
To'landi: {paid} so'm</blockquote>
<b>Oy oxiriga qarz: {closing} so'm</b>

Insert "Tuzatish: {adjusted} so'm" as the last quote line only when
st.totals.adjusted !== 0, mirroring statement.js:340. All five labels are
byte-identical to the workbook's own strings, so the caption and the file the
client opens agree word for word. Zero lines are kept, not dropped: a statement
of account states every line. {closing} < 0 → "Oy oxiriga oldindan to'lov:".

FILLED
📄 <b>2026-yil sentabr hisoboti</b>
<blockquote>Oy boshiga qarz: 1 200 000 so'm
Berildi: 3 600 000 so'm
Qaytarildi: 480 000 so'm
To'landi: 1 920 000 so'm</blockquote>
<b>Oy oxiriga qarz: 2 400 000 so'm</b>

The four middle figures are the arithmetic of the bold number
(1 200 000 + 3 600 000 − 480 000 − 1 920 000 = 2 400 000), so the client can
verify the closing balance without opening the file.
```

## Implementation notes

THE LIVE PATH IS server/clients.js ONLY. `post()` (clients.js:253) calls `receipt(headlineFor(entry), entry, balance)`, and it is reached from `insertAndReply` (clients.js:550-551, all of handover/return/payment/adjustment) and from the reverse route (clients.js:642). server/notify.js's `formatReceipt` is a second, divergent, DEAD implementation: `grep -rn "formatReceipt\|formatSom\|tashkentStamp"` returns only its own definitions — zero importers (index.js takes `makeNotifier` only), zero tests. Patching notify.js ships nothing; two judges watched other designs fall into exactly this trap.

=== server/notify.js — DELETE the formatting half ===
Delete `TASHKENT_OFFSET_MS` (:7), `KIND` (:10-15), `formatSom` (:20-25), `esc` (:28-30), `toDate` (:32-44), `tashkentStamp` (:47-52) and `formatReceipt` (:64-79). Keep `TELEGRAM_TIMEOUT_MS` and `makeNotifier` (:89-125) exactly as they are — it already sends parse_mode:'HTML' and disable_web_page_preview, which every template above relies on. Update the file header comment: it says "the receipt body, exactly as spec §4 shows it"; the file no longer formats anything, it posts. Deleting rather than updating is the point — it is what stops the next redesign patching the wrong copy.

=== server/clients.js — all six messages are built here ===

1) `money(n)` (:207). Change the separator from `' '` to `' '` (NO-BREAK SPACE). Add beside it:
   `const som = n => `${money(n)} so'm``   // NBSP before so'm too, so the unit never orphans
   Callers pass magnitudes; `money`'s existing ASCII `-` branch survives only for the adjustment path, which is replaced by `signed` below.
   `const signed = n => (n < 0 ? '−' : '+') + money(Math.abs(n))`   // U+2212, adjustment only

2) `esc` (:239-240) unchanged. `tashkentStr` (:215) unchanged — now used for the entry stamp and the reversal's back-reference.

3) NEW `noteLine(entry)` — place directly under `esc`:
   returns '' when `entry.note` is null/blank OR matches `/^Bekor qilindi #\d+$/` (the auto-placeholder written at clients.js:632);
   otherwise `"\n<i>" + esc(String(entry.note).replace(/\s+/g, ' ').trim().slice(0, 120)) + "</i>"`.
   ORDER MATTERS: collapse whitespace, then slice raw, THEN escape — escaping first and slicing after can cut `&amp;` in half and produce "can't parse entities". This is the only new free-text surface in the design; cleanNote (:162) caps at 500 and does not escape, so escaping must happen here.

4) NEW `KIND_UI` const near KINDS (:19):
   `{ handover:{icon:'📦',label:'Berildi'}, return:{icon:'↩️',label:'Qaytarildi'}, payment:{icon:'💵',label:"To'landi"}, adjustment:{icon:'✏️',label:'Tuzatish'} }`

5) NEW `balanceLine(balance, prefix = 'Jami qarz')`:
   `balance >= 0` → `<b>${prefix}: ${som(balance)}</b>`
   `balance < 0`  → `<b>Oldindan to'lov: ${som(-balance)}</b>`
   Always the literal last line of every message. Nothing else in the message is bold except the header verb.

6) REPLACE `lineFor` (:236-239), `headlineFor` (:241-249) and `receipt` (:221-227) with one builder. `receipt(entry, balance, orig)`:
   - `const hasGoods = entry.category_id != null && entry.qty != null`
   - `const goods = [esc(entry.category_name ?? '?'), `${entry.qty} dona × ${money(entry.unit_price)} = ${som(Math.abs(entry.amount))}`]`
   - REVERSAL (`entry.reverses_id != null`): header `❌ <b>Bekor qilindi</b>`; quote line 1 `${KIND_UI[entry.kind].label} · ${tashkentStr(orig?.created_at ?? entry.created_at)}` (NOT struck); then either `<s>${goods[0]}</s>\n<s>${goods[1]}</s>` or, when !hasGoods, `<s>${som(Math.abs(entry.amount))}</s>`; then `noteLine(entry)`. No stamp of its own.
   - ADJUSTMENT: header `✏️ <b>Tuzatish</b>`; quote `${signed(entry.amount)} so'm` + noteLine + `\n${tashkentStr(entry.created_at)}`.
   - HANDOVER / RETURN: header `${icon} <b>${label}</b>`; quote `goods[0]\ngoods[1]` + noteLine + `\n${stamp}`.
   - PAYMENT: header `💵 <b>To'landi</b>`; quote `${som(Math.abs(entry.amount))}` + noteLine + `\n${stamp}`.
   - Join: `header + '\n<blockquote>' + body + '</blockquote>\n' + balanceLine(balance)`.
   NOTE the escaping rule the existing esc() comment already states: `entry.category_name` and `entry.note` are the only DB/owner text interpolated; both go through esc(). Labels come from KIND_UI and need none.

7) `post(client, entry, balance)` (:253-261). It currently calls `receipt(headlineFor(entry), entry, balance)`. Change to fetch the original for reversals and pass it:
   ```
   let orig = null
   if (entry.reverses_id != null) { try { orig = q.rawEntry.get(entry.reverses_id) } catch {} }
   … notify(client.telegram_chat_id, receipt(entry, balance, orig))
   ```
   `q.rawEntry` already exists (:82) and returns `created_at`; LEDGER_SELECT does not join the reversed row, so this one extra read is required and is the only new query. It sits inside post()'s existing try/catch, so a failed lookup degrades to the reversal's own stamp rather than losing the receipt. No change to the two call sites (:551, :642) — the signature they use is `post(client, entry, balance)` in both.

=== handlers/groups.py — /ulash (the reply_html block at ~:249-259) ===
Replace the `text=` argument with:
```
f"🔗 Guruh: <b>{html.escape(title)}</b>\n\n"
f"<code>{code}</code>\n\n"
"Mini App → Mijozlar → mijozni tanlang → kodni kiriting va "
"<b>Ulash</b> tugmasini bosing.\n"
"Shundan keyin har bir berish, qaytarish va to'lov shu guruhga yoziladi.\n"
f"<i>Kod {CODE_TTL_MINUTES} daqiqa amal qiladi va faqat bir marta ishlatiladi.</i>"
+ ("" if CopyTextButton is not None else "\n\n👆 Kodni bosib nusxalang.")
```
Three changes only: "kodni qo'ying" → "kodni kiriting"; the TTL line loses ⏳ and becomes <i>; the instruction and the consequence become two lines. `markup` (:242-247) and the CopyTextButton fallback branch are untouched — requirements.txt still allows PTB 21.6, where that branch is the only way to copy the code.

=== server/statement.js — message F (not in the read list, but it is the statement) ===
1) `fmtMoney` (:73-78): separator → `' '`, and append the unit with NBSP at the call sites (or add a `som()` twin as in clients.js). Its comment "non-breaking-space-free; matches the Mini App" becomes false — update it to say the bot deliberately diverges from the Mini App here so money never wraps. This is caption-only; xlsx cells use numFmt (:350/:421/:457) and are unaffected.
2) Add an `esc()` (statement.js has none) — same three replacements as clients.js:239.
3) Replace the caption (:519-525) with the template above. `st.period.label` (:234) is generated, not user text, so it needs no escaping; there is no interpolated client name any more, which removes the raw-`st.client.name` parse bug the judges flagged. Insert the Tuzatish line only when `st.totals.adjusted !== 0`, and flip the closing label when `st.closing < 0`.
4) BLOCKING, verified at :527-531: the form appends only `chat_id`, `caption` and `document`. Add `form.append('parse_mode', 'HTML')` or the caption ships as literal `&lt;b&gt;Hisobot`. Caption length is ~200 of 1024 UTF-16 units — no risk. blockquote is valid in caption_entities (Bot API 7.0+).
5) OPTIONAL one-word alignment: `KIND_LABEL.payment` (:69) is "To'lov" while the totals row (:340) says "To'landi"; setting :69 to "To'landi" makes the workbook, the caption and the receipts use one word for one thing.

=== docs/superpowers/specs/2026-09-14-client-ledger-design.md §4 ===
Replace the three-line sample receipt block with the handover template above, and correct the surrounding text: the receipt is formatted in server/clients.js, not server/notify.js (§5's table says notify.js is "posting receipts to Telegram" — that stays true once formatReceipt is deleted). Leave the "posting never blocks the ledger write" paragraph alone; it still holds.

=== Tests worth adding alongside §7's list ===
- A note containing `Qora & Oq <test>` produces a message Telegram accepts (assert no raw `&`/`<` outside a tag).
- A reversal rendered with every HTML tag stripped still contains "Bekor qilindi" before any figure.
- `balanceLine(-160000)` emits "Oldindan to'lov" and no `-`.
- Every emitted message contains exactly one emoji outside of interpolated data.
