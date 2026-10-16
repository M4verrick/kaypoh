// TinyFish Search, Fetch and Agent over plain fetch().
// Docs: docs.tinyfish.ai/search-api/reference, /fetch-api/reference, /agent-api/reference

export type SearchHit = { position: number; site_name: string; title: string; snippet: string; url: string; date?: string };
export type FetchedPage = { url: string; final_url: string; title: string | null; published_date: string | null; text: string };
export type FetchError = { url: string; error: string; status?: number };
export type AgentRun = {
  run_id: string | null;
  status: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT";
  result: unknown;
  error: string | null;
  steps: number | null;
  streaming_url: string | null;
};

const AGENT = "https://agent.tinyfish.ai";
const MAX_TOTAL_CHARS = 15_000; // ponytail: flat budget per fetch call (~4k tokens); use Fetch include_selectors/highlights if pages need more

function key(): string {
  const k = process.env.TINYFISH_API_KEY;
  if (!k) throw new Error("TINYFISH_API_KEY is not set (see .env.example)");
  return k;
}

async function httpError(what: string, res: Response): Promise<string> {
  if (res.status === 402) return `${what}: TinyFish wallet is empty or today's free allowance is used up`;
  if (res.status === 429) return `${what}: TinyFish rate limit hit, try again in a minute`;
  return `${what} ${res.status}: ${(await res.text()).slice(0, 200)}`;
}

export async function search(
  query: string,
  opts: { purpose?: string; recency_minutes?: number; include_domains?: string; domain_type?: "web" | "news" } = {},
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ query });
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) params.set(k, String(v));
  const res = await fetch(`https://api.search.tinyfish.ai?${params}`, { headers: { "X-API-Key": key() }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(await httpError("Search", res));
  const body = (await res.json()) as { results?: SearchHit[] };
  return body.results ?? [];
}

export async function fetchPages(urls: string[], opts: { purpose?: string; ttl?: number } = {}): Promise<{ pages: FetchedPage[]; errors: FetchError[] }> {
  const res = await fetch("https://api.fetch.tinyfish.ai", {
    method: "POST",
    headers: { "X-API-Key": key(), "Content-Type": "application/json" },
    body: JSON.stringify({ urls: urls.slice(0, 10), format: "markdown", ...opts }),
    signal: AbortSignal.timeout(150_000), // docs: 120 s CDN ceiling, client timeout >= 150 s
  });
  if (!res.ok) throw new Error(await httpError("Fetch", res));
  const body = (await res.json()) as { results?: (Omit<FetchedPage, "text"> & { text: string | null })[]; errors?: FetchError[] };
  const results = body.results ?? [];
  const perPage = Math.max(1500, Math.floor(MAX_TOTAL_CHARS / Math.max(1, results.length)));
  return {
    pages: results.map((p) => ({ ...p, text: (p.text ?? "").slice(0, perPage) })),
    errors: body.errors ?? [],
  };
}

/** Start an Agent run (run-async), poll until terminal, cancel if it overruns. */
export async function runAgent(
  req: { url: string; goal: string; output_schema?: object; max_seconds?: number },
  deps: { fetchImpl?: typeof fetch; pollMs?: number; graceMs?: number; queueMs?: number } = {},
): Promise<AgentRun> {
  const f = deps.fetchImpl ?? fetch;
  const maxSeconds = req.max_seconds ?? 180;
  const headers = { "X-API-Key": key(), "Content-Type": "application/json" };
  const start = await f(`${AGENT}/v1/automation/run-async`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: req.url, goal: req.goal, output_schema: req.output_schema, agent_config: { max_duration_seconds: maxSeconds } }),
  });
  if (!start.ok) throw new Error(await httpError("Agent", start));
  const started = (await start.json()) as { run_id: string | null; error: { message?: string } | null };
  if (!started.run_id) throw new Error(`Agent did not start: ${started.error?.message ?? "unknown error"}`);

  // The budget counts from when a browser actually starts on the run (runs can queue), with a hard cap on total waiting.
  const grace = deps.graceMs ?? 60_000; // anti-bot sites can run past their own cap by a minute
  const submitted = Date.now();
  const hardCap = submitted + maxSeconds * 1000 + grace + (deps.queueMs ?? 180_000);
  let deadline = submitted + maxSeconds * 1000 + grace;
  while (Date.now() < Math.min(deadline, hardCap)) {
    await Bun.sleep(deps.pollMs ?? 5000);
    const res = await f(`${AGENT}/v1/runs/${started.run_id}`, { headers });
    if (!res.ok) throw new Error(await httpError("Agent", res));
    const run = (await res.json()) as { status: string; started_at?: string | null; result: unknown; error: { message?: string } | null; num_of_steps: number | null; streaming_url: string | null };
    if (run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED") {
      return { run_id: started.run_id, status: run.status, result: run.result ?? null, error: run.error?.message ?? null, steps: run.num_of_steps ?? null, streaming_url: run.streaming_url ?? null };
    }
    if (run.started_at) deadline = Math.max(deadline, Date.parse(run.started_at) + maxSeconds * 1000 + grace);
  }
  await f(`${AGENT}/v1/runs/${started.run_id}/cancel`, { method: "POST", headers }).catch(() => {});
  return { run_id: started.run_id, status: "TIMEOUT", result: null, error: `gave up after ${maxSeconds} s`, steps: null, streaming_url: null };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Human-readable reason for a per-URL fetch failure, e.g. "klook.com: the site blocks automated readers". */
export function describeError(e: FetchError): string {
  const why: Record<string, string> = {
    bot_blocked: "the site blocks automated readers",
    login_required: "the page needs a login",
    timeout: "the page took too long to load",
    page_not_found: "the page does not exist",
    target_unreachable: "the site could not be reached",
    empty_content: "the page had no readable text",
    target_http_error: "the site returned an error",
    content_too_large: "the page is too big to read",
    proxy_error: "a network hop failed; it may work later",
    invalid_url: "that is not a public web address",
    invalid_redirect_url: "it redirected somewhere that is not a public web address",
    conditional_unsupported: "the page could not be checked for changes",
    selector_not_matched: "the requested part of the page was not found",
    selector_unsupported: "that file type cannot be sectioned",
  };
  return `${hostOf(e.url)}: ${why[e.error] ?? e.error}${e.status ? ` (HTTP ${e.status})` : ""}`;
}
