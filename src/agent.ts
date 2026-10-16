import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { Db } from "./db";
import { describeError, fetchPages, hostOf, runAgent, search, type FetchError } from "./tinyfish";

export const MODEL = process.env.KAYPOH_MODEL ?? "claude-opus-5-5";
const MAX_AGENT_RUNS = Number(process.env.KAYPOH_MAX_AGENT_RUNS_PER_DAY ?? 10);
const AGENT_MAX_SECONDS = Number(process.env.KAYPOH_AGENT_MAX_SECONDS ?? 180);

export type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string };
};
export type Turn = { spaceId: string; sender: string; platform: string; text: string; images?: ImageBlock[]; onLongJob?: () => void };
export type Sources = { used: string[]; failed: FetchError[] };

const SYSTEM = `You are Kaypoh, the friend who checks things on the web for a university student in Singapore. You talk over iMessage.

What you can do
- web_search: live web search. fetch_page: read pages. run_agent: operate a website in a real browser (enter dates, apply filters, read pages that block plain fetching, walk to a checkout or booking page). set_watch / cancel_watch / list_watches: keep an eye on a page and text the user once when their condition is met. remember: save durable facts about the user.

Rules
- Live facts (prices, dates, availability, news, "is this cheaper elsewhere") come ONLY from tool results in this conversation. Never answer them from memory. If you have not fetched it, you do not know it.
- Name the page each fact came from, as a URL. If a page could not be read, say which one and why; never guess what it says.
- When the user sends a URL: fetch it first. If they want a comparison, search for alternatives, fetch the best two or three, then answer. If fetch_page fails with a bot block or login wall, or the page needs dates or filters entered, use run_agent with action "read".
- run_agent with action "act" is for anything that adds to a cart, books, reserves, submits or sends. It returns NEEDS_CONFIRMATION the first time: ask the user one short question describing exactly what will happen, ending with "yes/no?", and stop. Only after they say yes, call it again. It always stops at the final confirmation page and never pays; give the user the link to finish themselves.
- Set a watch only when the user asks to be told later ("tell me if", "let me know when", "watch this"). Confirm what you are watching, the condition and how often. Say you will text once when it happens and stay quiet otherwise.
- Photos: read them (posters, screenshots, listings) and act on what they show.
- Write like a text message: short and plain. One or two short paragraphs or a few short lines. No headings. Bold and short lists only when they help. Do not repeat the question back.
- Money: assume Singapore dollars unless the page says otherwise, and say the currency.
- Use remember() for durable facts the user tells you about themselves (school, travel dates, budget, preferences). Not for one-off details.`;

const READ_SUFFIX = " Do not log in, buy, book, add to cart, or submit anything. Report what you find.";
const ACT_SUFFIX =
  " Stop at the final confirmation or checkout page and report its URL. Do not complete any payment, do not place the order or booking, do not send messages, and do not log in with credentials you were not given.";

// TinyFish structured-output subset: no additionalProperties, nullable instead of type arrays.
const AGENT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    final_url: { type: "string" },
    price: { type: "string", nullable: true },
    available: { type: "boolean", nullable: true },
    details: { type: "string" },
  },
  required: ["summary", "final_url", "details"],
};

export const isAffirmative = (t: string): boolean =>
  /^(y|ye|yes|yup|yeah|ya|ok|okay|sure|go|do it|confirm|confirmed|proceed|can)(\s+(please|pls|ahead|lah|la))?[\s!.]*$/i.test(t.trim());
export const isNegative = (t: string): boolean => /^(n|no|nope|nah|stop|cancel|don'?t|never ?mind|nvm)\b/i.test(t.trim());

/** Enforces "cite it or say you couldn't read it" after the model has answered. */
export function ensureSources(reply: string, sources: Sources): string {
  let out = reply.trimEnd();
  const cited = sources.used.some((u) => out.includes(u) || out.includes(u.replace(/^https?:\/\/(www\.)?/, "")));
  if (sources.used.length && !cited) out += `\n\nSources: ${[...new Set(sources.used)].slice(0, 3).join("\n")}`;
  const unmentioned = sources.failed.filter((f) => !out.includes(hostOf(f.url)));
  if (unmentioned.length) out += `\n\nCouldn't read ${unmentioned.map(describeError).join("; ")}.`;
  return out;
}

const safe = (fn: () => Promise<string> | string) => async () => {
  try {
    return await fn();
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export async function runTurn(db: Db, turn: Turn): Promise<string> {
  const client = new Anthropic();
  const sources: Sources = { used: [], failed: [] };

  // A bare "yes"/"no" answers an open confirmation question before the model sees it.
  if (db.pendingConfirm(turn.sender)) {
    if (isAffirmative(turn.text)) db.confirm(turn.sender);
    else if (isNegative(turn.text)) db.clearConfirms(turn.sender);
  }

  const tools = [
    betaTool({
      name: "web_search",
      description: "Search the live web (TinyFish Search). Returns ranked results with title, snippet, url and sometimes date.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          purpose: { type: "string", description: "Why you are searching and what the results are for" },
          recency_minutes: { type: "integer", description: "Only results from the last N minutes, e.g. 10080 for a week" },
          domain_type: { type: "string", enum: ["web", "news"] },
        },
        required: ["query", "purpose"],
        additionalProperties: false,
      },
      run: (a) => safe(async () => JSON.stringify(await search(a.query, a)))(),
    }),
    betaTool({
      name: "fetch_page",
      description:
        "Read up to 10 web pages as markdown (TinyFish Fetch). Use it for the user's URL and for the best search hits. Pages that failed come back under errors with a reason.",
      inputSchema: {
        type: "object",
        properties: {
          urls: { type: "array", items: { type: "string" }, maxItems: 10 },
          purpose: { type: "string", description: "What you are looking for on these pages" },
        },
        required: ["urls", "purpose"],
        additionalProperties: false,
      },
      run: (a) =>
        safe(async () => {
          const r = await fetchPages(a.urls, { purpose: a.purpose });
          sources.used.push(...r.pages.map((p) => p.final_url || p.url));
          sources.failed.push(...r.errors);
          return JSON.stringify({ pages: r.pages, errors: r.errors.map(describeError) });
        })(),
    }),
    betaTool({
      name: "run_agent",
      description:
        "Operate a website in a real browser (TinyFish Agent): enter dates, apply filters, read pages that block fetch_page, or walk to a checkout/booking page. Slow (30-120 s) and metered, so use it only when fetch_page cannot do the job. action 'read' only looks. action 'act' adds to cart / books / submits and needs the user's yes first.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          goal: { type: "string", description: "Precise steps and what to extract: dates, quantity, ticket category, which price to read" },
          action: { type: "string", enum: ["read", "act"] },
          what_would_happen: { type: "string", description: "For act: one plain sentence of exactly what will be done, with item, quantity, date and price" },
        },
        required: ["url", "goal", "action"],
        additionalProperties: false,
      },
      run: (a) =>
        safe(async () => {
          if (a.action === "act" && !db.takeConfirmed(turn.sender)) {
            const summary = a.what_would_happen ?? a.goal;
            db.requestConfirm(turn.sender, summary);
            return `NEEDS_CONFIRMATION. Nothing was done. Ask the user, in one short question ending with "yes/no?", to confirm exactly this: ${summary}`;
          }
          if (db.agentRunsToday(turn.sender) >= MAX_AGENT_RUNS) {
            return `budget: this user has used today's ${MAX_AGENT_RUNS} website runs. Tell them it resets tomorrow.`;
          }
          turn.onLongJob?.();
          const run = await runAgent({
            url: a.url,
            goal: a.goal + (a.action === "act" ? ACT_SUFFIX : READ_SUFFIX),
            output_schema: AGENT_SCHEMA,
            max_seconds: AGENT_MAX_SECONDS,
          });
          db.recordAgentRun(turn.sender, run.steps);
          if (run.status !== "COMPLETED") {
            return `the website run ${run.status.toLowerCase()}: ${run.error ?? "no details"}. Tell the user plainly; do not invent what the page says.`;
          }
          const r = run.result as { final_url?: string } | null;
          if (r?.final_url) sources.used.push(r.final_url);
          return JSON.stringify({ result: run.result, steps: run.steps, live_view: run.streaming_url });
        })(),
    }),
    betaTool({
      name: "set_watch",
      description:
        "Watch a page and text the user once when a condition is met (price below X, back in stock, date announced). Only when the user asked to be told later.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          condition: { type: "string", description: "Plain English with the threshold, e.g. 'price below S$60' or 'tickets available'" },
          interval_minutes: { type: "integer", minimum: 15, maximum: 1440, description: "How often to check; default 60" },
          any_time: { type: "boolean", description: "true only if the user said to text at any hour; otherwise nothing is sent 23:00-08:00" },
          days: { type: "integer", minimum: 1, maximum: 30, description: "How long to keep watching; default 14" },
        },
        required: ["url", "condition"],
        additionalProperties: false,
      },
      run: (a) => {
        const interval = Math.max(15, a.interval_minutes ?? 60);
        const days = Math.min(30, a.days ?? 14);
        const id = db.addWatch({
          sender: turn.sender,
          space_id: turn.spaceId,
          platform: turn.platform,
          url: a.url,
          condition: a.condition,
          interval_min: interval,
          any_time: a.any_time ?? false,
          days,
        });
        return `watch #${id} set: ${a.url}, "${a.condition}", checked every ${interval} min for ${days} days; first check within a minute.`;
      },
    }),
    betaTool({
      name: "cancel_watch",
      description: "Stop a watch. 'which' is a watch id, part of its URL, or 'all'.",
      inputSchema: { type: "object", properties: { which: { type: "string" } }, required: ["which"], additionalProperties: false },
      run: (a) => {
        const hits = db.activeWatches(turn.sender).filter((w) => a.which === "all" || String(w.id) === a.which || w.url.includes(a.which));
        hits.forEach((w) => db.cancelWatch(w.id));
        return hits.length ? `stopped ${hits.length} watch(es): ${hits.map((w) => w.url).join(", ")}` : "no matching active watch";
      },
    }),
    betaTool({
      name: "list_watches",
      description: "List this user's active watches.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => JSON.stringify(db.activeWatches(turn.sender).map((w) => ({ id: w.id, url: w.url, condition: w.condition, every_min: w.interval_min, last_value: w.last_value, expires: new Date(w.expires_at).toISOString().slice(0, 10) }))),
    }),
    betaTool({
      name: "remember",
      description: "Save a durable fact about this user: school, travel dates, budget, preferences.",
      inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false },
      run: (a) => {
        db.remember(turn.sender, a.note);
        return "saved";
      },
    }),
  ];

  const notes = db.notes(turn.sender);
  const history = db.history(turn.spaceId);
  const firstEver = !notes && history.length === 0;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [...(turn.images ?? []), { type: "text", text: turn.text }];
  const final = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low" }, // chat-shaped turns; raise to "medium" if answers get sloppy
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // server-side retry on a substitute model if a safety classifier declines
    system: [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
      ...(notes ? [{ type: "text" as const, text: `What you remember about this user:\n${notes}` }] : []),
      ...(firstEver ? [{ type: "text" as const, text: "This is the first message this person has ever sent you. Open with one short line saying who you are and what you can check, then help." }] : []),
    ],
    tools,
    messages: [...history, { role: "user", content }],
    max_iterations: 12,
  });

  if (final.stop_reason === "refusal") return "I can't help with that one.";
  const reply =
    final.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim() || "I got nothing back. Try again?";
  const out = ensureSources(reply, sources);
  db.append(turn.spaceId, "user", turn.images?.length ? `[photo] ${turn.text}` : turn.text);
  db.append(turn.spaceId, "assistant", out);
  return out;
}
