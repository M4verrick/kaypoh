# Kaypoh

An AI assistant that lives in iMessage. Text it a link or a question like you would text a friend;
it reads the live page, checks the rest of the web, and texts back with sources. Ask it to watch
something and it stays quiet until that thing happens, then texts you once. It never buys, books or
submits anything without a fresh "yes".

**Who it's for.** A university student in Singapore. A friend drops a link in the group chat
(concert tickets, a Scoot fare, a Klook pass, a Shopee listing); you forward it to Kaypoh instead of
opening six tabs. "Kaypoh" is Singlish for the busybody friend who checks everything for you.

**Photon** is the iMessage layer: `spectrum-ts` with Photon's managed iMessage provider (a real
number), using the message stream, typing indicators, markdown, rich links, tapbacks, the native
contact card, and inbound photos. Inbound-first by design.

**TinyFish** is the web layer, three endpoints with distinct jobs:
- **Search**: find alternatives and context (`purpose`, recency filters).
- **Fetch**: read the user's link and the best hits as markdown; also powers watches. Failed pages
  come back with their reason, and the reply says so.
- **Agent**: only when Fetch cannot do the job (bot walls, date pickers, filters, checkout). Anything
  that acts needs the user's "yes" first, runs exactly the request they confirmed, and stops at the
  final confirmation page in its own browser. It then tells you what it selected and gives you the
  product link to redo it on your phone; it never pays and never pretends its cart is yours.

The brain is Claude via the Anthropic SDK tool runner, with seven tools: `web_search`, `fetch_page`,
`run_agent`, `set_watch`, `cancel_watch`, `list_watches`, `remember`. Memory is per person, history
per conversation, in one SQLite file.

## Run

```bash
bun install
cp .env.example .env   # ANTHROPIC_API_KEY, TINYFISH_API_KEY; SPECTRUM_PROJECT_ID/SECRET for iMessage
bun run src/index.ts    # terminal chat for local use; iMessage joins when the Photon vars are set
bun test
```

On Photon's free plan, add your own iMessage handle under **Users** in the dashboard first; shared
lines only message registered users.

It runs as one process on a Mac. Watches are checked while the process is up; a check that falls
during sleep runs when the Mac wakes. Text from web pages is treated as data, never as instructions,
and is never written to long-term memory.
