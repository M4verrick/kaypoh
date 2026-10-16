import { describe, expect, test } from "bun:test";
import { openDb, type Watch } from "./db";
import { runAgent } from "./tinyfish";
import { decide, isQuietHour, nextMorning, tick, type Judgement } from "./watches";

process.env.TINYFISH_API_KEY ??= "test-key";
const SGT = (iso: string) => new Date(`${iso}+08:00`);

describe("quiet hours (Asia/Singapore)", () => {
  test("23:00-08:00 is quiet", () => {
    expect(isQuietHour(SGT("2026-10-16T23:30:00"))).toBe(true);
    expect(isQuietHour(SGT("2026-10-16T07:59:00"))).toBe(true);
    expect(isQuietHour(SGT("2026-10-16T08:00:00"))).toBe(false);
    expect(isQuietHour(SGT("2026-10-16T13:00:00"))).toBe(false);
  });
  test("nextMorning lands on the next 08:00 local", () => {
    expect(nextMorning(SGT("2026-10-16T23:30:00")).toISOString()).toBe(SGT("2026-10-17T08:00:00").toISOString());
    expect(nextMorning(SGT("2026-10-16T02:10:00")).toISOString()).toBe(SGT("2026-10-16T08:00:00").toISOString());
  });
});

const baseWatch = (over: Partial<Watch> = {}): Watch => ({
  id: 1, sender: "u", space_id: "chat-1", platform: "terminal", url: "https://shop.example/x", condition: "price below S$60",
  interval_min: 60, any_time: 1, created_at: 0, expires_at: 10 ** 13, last_check_at: null, last_hash: null, last_value: null,
  notified_at: null, notify_count: 0, error_count: 0, pending_notice: null, deliver_after: null, active: 1, mode: "fetch", ...over,
});

describe("decide", () => {
  const met: Judgement = { met: true, value: "S$58", note: "Dropped below your S$60 limit." };
  const unmet: Judgement = { met: false, value: "S$78", note: "Still above." };
  test("first hit notifies once, repeats stay quiet, a miss re-arms", () => {
    const first = decide(baseWatch(), met, 100);
    expect(first.notice).toContain("S$58");
    expect(first.patch.notify_count).toBe(1);
    expect(decide(baseWatch({ notified_at: 100, notify_count: 1 }), met, 200).notice).toBeUndefined();
    const miss = decide(baseWatch({ notified_at: 100, notify_count: 1 }), unmet, 300);
    expect(miss.notice).toBeUndefined();
    expect(miss.patch.notified_at).toBeNull();
    expect(decide(baseWatch({ notify_count: 3 }), met, 400).notice).toBeUndefined();
  });
});

describe("tick", () => {
  function harness(startNow: number) {
    const db = openDb(":memory:");
    let now = startNow;
    let pageText = "Universal Studios ticket S$78";
    const judged: string[] = [];
    const sent: string[] = [];
    let judgement: Judgement = { met: false, value: "S$78", note: "Still above." };
    const deps = {
      now: () => now,
      fetchPages: async () => ({ pages: [{ url: "u", final_url: "u", title: null, published_date: null, text: pageText }], errors: [] }),
      judge: async (c: string) => (judged.push(c), judgement),
      send: async (_w: Watch, text: string): Promise<void> => void sent.push(text),
    };
    return { db, deps, judged, sent, setNow: (t: number) => (now = t), setPage: (t: string) => (pageText = t), setJudgement: (j: Judgement) => (judgement = j) };
  }
  const HOUR = 3_600_000;
  const noon = SGT("2026-10-16T12:00:00").getTime();

  test("checks on schedule, skips the judge when the page is unchanged, texts once when met", async () => {
    const h = harness(noon);
    h.db.addWatch({ sender: "u", space_id: "chat-1", platform: "terminal", url: "https://shop.example/x", condition: "price below S$60", interval_min: 60, any_time: true, days: 14 }, noon);
    await tick(h.db, h.deps);
    expect(h.judged.length).toBe(1);
    expect(h.sent).toEqual([]);
    await tick(h.db, h.deps); // same minute: not due
    expect(h.judged.length).toBe(1);
    h.setNow(noon + HOUR + 1);
    await tick(h.db, h.deps); // due, page unchanged: no judge call
    expect(h.judged.length).toBe(1);
    h.setNow(noon + 2 * HOUR + 2);
    h.setPage("Universal Studios ticket S$58");
    h.setJudgement({ met: true, value: "S$58", note: "Dropped below your S$60 limit." });
    await tick(h.db, h.deps);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]).toContain("S$58");
    h.setNow(noon + 3 * HOUR + 3);
    h.setPage("Universal Studios ticket S$57");
    await tick(h.db, h.deps); // still met: stays quiet
    expect(h.sent.length).toBe(1);
  });

  test("holds a notice through quiet hours and delivers it at 08:00", async () => {
    const night = SGT("2026-10-16T23:30:00").getTime();
    const h = harness(night);
    h.db.addWatch({ sender: "u", space_id: "chat-1", platform: "terminal", url: "https://shop.example/x", condition: "price below S$60", interval_min: 60, any_time: false, days: 14 }, night);
    h.setJudgement({ met: true, value: "S$58", note: "Dropped." });
    await tick(h.db, h.deps);
    expect(h.sent).toEqual([]);
    const w = h.db.watchesToVisit()[0]!;
    expect(w.pending_notice).toContain("S$58");
    expect(w.deliver_after).toBe(SGT("2026-10-17T08:00:00").getTime());
    h.setNow(SGT("2026-10-17T07:00:00").getTime());
    await tick(h.db, h.deps);
    expect(h.sent).toEqual([]);
    h.setNow(SGT("2026-10-17T08:00:30").getTime());
    await tick(h.db, h.deps);
    expect(h.sent.length).toBe(1);
    expect(h.db.watchesToVisit()[0]!.pending_notice).toBeNull();
  });

  test("a failed send keeps the notice queued and retries next tick", async () => {
    const h = harness(noon);
    h.db.addWatch({ sender: "u", space_id: "chat-1", platform: "terminal", url: "https://shop.example/x", condition: "price below S$60", interval_min: 60, any_time: true, days: 14 }, noon);
    h.setJudgement({ met: true, value: "S$58", note: "Dropped." });
    let failOnce = true;
    const flaky = { ...h.deps, send: async (w: Watch, text: string) => { if (failOnce) { failOnce = false; throw new Error("Target not allowed"); } h.deps.send(w, text); } };
    await tick(h.db, flaky);
    expect(h.sent).toEqual([]);
    expect(h.db.watchesToVisit()[0]!.pending_notice).toContain("S$58");
    h.setNow(noon + 60_000);
    await tick(h.db, flaky);
    expect(h.sent.length).toBe(1);
    expect(h.db.watchesToVisit()[0]!.pending_notice).toBeNull();
  });

  test("agent-mode watches read through a browser run instead of Fetch", async () => {
    const h = harness(noon);
    h.db.addWatch({ sender: "u", space_id: "chat-1", platform: "terminal", url: "https://ticketmaster.example/x", condition: "price below S$40", interval_min: 360, any_time: true, days: 14, mode: "agent" }, noon);
    const agentCalls: string[] = [];
    const deps = {
      ...h.deps,
      fetchPages: async () => { throw new Error("fetch must not be used for agent-mode watches"); },
      runAgent: async (req: { url: string; goal: string }) => (agentCalls.push(req.url), { run_id: "r", status: "COMPLETED" as const, result: { summary: "Cat 1 S$168, Cat 3 S$38, on sale" }, error: null, steps: 4, streaming_url: null }),
    };
    h.setJudgement({ met: true, value: "S$38", note: "Cat 3 is below your S$40 limit." });
    await tick(h.db, deps);
    expect(agentCalls).toEqual(["https://ticketmaster.example/x"]);
    expect(h.judged.length).toBe(1);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]).toContain("S$38");
  });

  test("expiry sends one closing text and deactivates", async () => {
    const h = harness(noon);
    h.db.addWatch({ sender: "u", space_id: "chat-1", platform: "terminal", url: "https://shop.example/x", condition: "price below S$60", interval_min: 60, any_time: true, days: 1 }, noon);
    h.setNow(noon + 25 * HOUR);
    await tick(h.db, h.deps);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]).toContain("Stopped watching");
    expect(h.db.activeWatches("u")).toEqual([]);
  });
});

describe("runAgent", () => {
  const fakeFetch = (routes: { test: RegExp; body: () => unknown }[]) => {
    const calls: string[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const r = routes.find((x) => x.test.test(url));
      if (!r) throw new Error(`unexpected ${url}`);
      return new Response(JSON.stringify(r.body()), { status: 200 });
    }) as typeof fetch;
    return { f, calls };
  };

  test("starts async, polls to COMPLETED", async () => {
    let polls = 0;
    const { f, calls } = fakeFetch([
      { test: /run-async$/, body: () => ({ run_id: "r1", error: null }) },
      { test: /\/v1\/runs\/r1$/, body: () => (++polls < 2 ? { status: "RUNNING" } : { status: "COMPLETED", result: { price: "S$58" }, num_of_steps: 4, streaming_url: "https://live" }) },
    ]);
    const run = await runAgent({ url: "https://x", goal: "read price" }, { fetchImpl: f, pollMs: 1 });
    expect(run.status).toBe("COMPLETED");
    expect(run.result).toEqual({ price: "S$58" });
    expect(run.steps).toBe(4);
    expect(calls.filter((c) => c.startsWith("POST")).length).toBe(1);
  });

  test("a queued run gets its budget from when it starts", async () => {
    let polls = 0;
    const startedAt = new Date().toISOString();
    const { f } = fakeFetch([
      { test: /run-async$/, body: () => ({ run_id: "r3", error: null }) },
      // first polls: still queued (no started_at); then running from now; then done
      { test: /\/v1\/runs\/r3$/, body: () => (++polls < 3 ? { status: "PENDING", started_at: null } : polls < 5 ? { status: "RUNNING", started_at: startedAt } : { status: "COMPLETED", started_at: startedAt, result: { ok: true }, num_of_steps: 2, streaming_url: null }) },
    ]);
    const run = await runAgent({ url: "https://x", goal: "queued", max_seconds: 0 }, { fetchImpl: f, pollMs: 1, graceMs: 50, queueMs: 500 });
    expect(run.status).toBe("COMPLETED");
  });

  test("cancels and reports TIMEOUT when it overruns", async () => {
    const { f, calls } = fakeFetch([
      { test: /run-async$/, body: () => ({ run_id: "r2", error: null }) },
      { test: /\/v1\/runs\/r2$/, body: () => ({ status: "RUNNING" }) },
      { test: /\/cancel$/, body: () => ({ status: "CANCELLED" }) },
    ]);
    const run = await runAgent({ url: "https://x", goal: "slow", max_seconds: 0 }, { fetchImpl: f, pollMs: 1, graceMs: 20, queueMs: 0 });
    expect(run.status).toBe("TIMEOUT");
    expect(calls.some((c) => c.endsWith("/cancel"))).toBe(true);
  });
});
