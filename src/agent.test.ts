import { describe, expect, test } from "bun:test";
import { ensureSources, firstUrl, isAffirmative, isNegative } from "./agent";
import { CONFIRM_TTL_MS, openDb } from "./db";
import { createDebouncer, splitForPlatform, toImageBlock } from "./index";
import { describeError } from "./tinyfish";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("debounce", () => {
  test("a burst becomes one batch per key", async () => {
    const flushed: [string, string[]][] = [];
    const push = createDebouncer<string>(20, (k, items) => flushed.push([k, items]));
    push("a", "hey");
    push("a", "wait");
    push("b", "other");
    push("a", "actually, is this cheap?");
    await sleep(60);
    expect(flushed).toEqual([
      ["b", ["other"]],
      ["a", ["hey", "wait", "actually, is this cheap?"]],
    ]);
  });
});

describe("ensureSources: cite it or say you couldn't read it", () => {
  const used = ["https://www.klook.com/activity/123", "https://trip.com/x"];
  test("appends host names and a primary URL when the reply cites none", () => {
    const r = ensureSources("It's S$78 right now.", { used, searched: [], failed: [] }, { inlineUrl: true });
    expect(r.text).toContain("via klook.com, trip.com");
    expect(r.text).toContain(used[0]!);
    expect(r.primaryUrl).toBe(used[0]);
  });
  test("on iMessage the URL is left for the rich link, not the bubble", () => {
    const r = ensureSources("It's S$78 right now.", { used, searched: [], failed: [] }, { inlineUrl: false });
    expect(r.text).toContain("via klook.com");
    expect(r.text).not.toContain("https://");
    expect(r.primaryUrl).toBe(used[0]);
  });
  test("leaves a reply alone when it already cites a source", () => {
    const reply = "It's S$78 on klook.com/activity/123.";
    expect(ensureSources(reply, { used, searched: [], failed: [] }).text).toBe(reply);
  });
  test("search-only answers still get their sources", () => {
    const r = ensureSources("Tickets go on sale 2 Nov.", { used: [], searched: ["https://www.ticketmaster.sg/x"], failed: [] }, { inlineUrl: true });
    expect(r.text).toContain("via ticketmaster.sg");
    expect(r.primaryUrl).toBe("https://www.ticketmaster.sg/x");
  });
  test("names the user's own page when it could not be read, ignores failed search hits", () => {
    const failed = [
      { url: "https://www.scoot.com/fare", error: "bot_blocked" },
      { url: "https://random-hit.example/p", error: "timeout" },
    ];
    const r = ensureSources("Found S$89 on trip.com/x.", { used: ["https://trip.com/x"], searched: [], failed }, { userUrls: ["https://scoot.com/fare/"] });
    expect(r.text).toContain("Couldn't read scoot.com: the site blocks automated readers");
    expect(r.text).not.toContain("random-hit");
  });
  test("does not repeat a failure the model already mentioned", () => {
    const failed = [{ url: "https://www.scoot.com/fare", error: "bot_blocked" }];
    const reply = "scoot.com blocked me, but trip.com/x has it at S$89.";
    expect(ensureSources(reply, { used: ["https://trip.com/x"], searched: [], failed }, { userUrls: ["https://www.scoot.com/fare"] }).text).toBe(reply);
  });
});

describe("confirmation gate", () => {
  test("ask -> yes -> exactly one run may proceed", () => {
    const db = openDb(":memory:");
    const t0 = 1_000_000;
    expect(db.takeConfirmed("u", t0)).toBeNull();
    db.requestConfirm("u", "Add 2 USS tickets for 24 Oct at S$166 to the Klook cart", { url: "https://klook.com/uss", goal: "add 2 tickets for 24 Oct" }, t0);
    expect(db.pendingConfirm("u", t0)?.summary).toContain("USS");
    expect(db.takeConfirmed("u", t0)).toBeNull(); // asked, not yet answered
    expect(db.confirm("u", t0 + 1000)).toBe(true);
    const taken = db.takeConfirmed("u", t0 + 2000);
    expect(taken?.summary).toContain("USS");
    expect(taken?.url).toBe("https://klook.com/uss"); // the run executes what was confirmed, not a new request
    expect(taken?.goal).toBe("add 2 tickets for 24 Oct");
    expect(db.takeConfirmed("u", t0 + 3000)).toBeNull(); // a yes is good for one run only
  });
  test("a stale question cannot be confirmed; 'no' clears it", () => {
    const db = openDb(":memory:");
    const t0 = 1_000_000;
    db.requestConfirm("u", "book it", null, t0);
    expect(db.confirm("u", t0 + CONFIRM_TTL_MS + 1)).toBe(false);
    db.requestConfirm("u", "book it again", null, t0 + CONFIRM_TTL_MS + 2);
    db.clearConfirms("u", t0 + CONFIRM_TTL_MS + 3);
    expect(db.pendingConfirm("u", t0 + CONFIRM_TTL_MS + 4)).toBeNull();
  });
  test("yes/no detection is whole-message only", () => {
    for (const t of ["yes", "Yes!", "ok", "go ahead", "sure please", "do it"]) expect(isAffirmative(t)).toBe(true);
    for (const t of ["yes but only if under $60", "what's the price", "okay what about Trip.com", "can"]) expect(isAffirmative(t)).toBe(false);
    for (const t of ["no", "nah", "stop", "cancel that", "nvm", "No thanks."]) expect(isNegative(t)).toBe(true);
    for (const t of ["not sure, what else is there?", "no idea, what's the price?"]) expect(isNegative(t)).toBe(false);
  });
});

describe("db", () => {
  test("isDuplicate is false once, then true", () => {
    const db = openDb(":memory:");
    expect(db.isDuplicate("m1")).toBe(false);
    expect(db.isDuplicate("m1")).toBe(true);
    expect(db.isDuplicate("m2")).toBe(false);
  });
  test("history is per space, notes are per person, first contact fires once", () => {
    const db = openDb(":memory:");
    db.append("chat-1", "user", "hi");
    db.append("chat-1", "assistant", "hello");
    db.append("chat-2", "user", "unrelated");
    expect(db.history("chat-1")).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    db.remember("+65", "studies at SMU");
    db.remember("+65", "budget S$100");
    expect(db.notes("+65")).toBe("studies at SMU\nbudget S$100");
    expect(db.notes("+1")).toBe("");
    expect(db.firstContact("+65")).toBe(true);
    expect(db.firstContact("+65")).toBe(false);
  });
  test("agent run budget is a rolling 24 h window", () => {
    const db = openDb(":memory:");
    const t0 = 10_000_000_000;
    db.recordAgentRun("u", 5, t0);
    db.recordAgentRun("u", 7, t0 + 1000);
    expect(db.agentRunsToday("u", t0 + 2000)).toBe(2);
    expect(db.agentRunsToday("u", t0 + 86_400_000 + 5000)).toBe(0);
  });
});

test("describeError maps codes to plain reasons", () => {
  expect(describeError({ url: "https://www.klook.com/a", error: "login_required" })).toBe("klook.com: the page needs a login");
  expect(describeError({ url: "https://x.com/a", error: "target_http_error", status: 503 })).toBe("x.com: the site returned an error (HTTP 503)");
});

test("firstUrl, platform split and image blocks", async () => {
  expect(firstUrl("see https://trip.com/x) and more")).toBe("https://trip.com/x");
  expect(firstUrl("no links")).toBeUndefined();
  const split = splitForPlatform("S$58 now.\n\nvia trip.com\nhttps://trip.com/x", "imessage");
  expect(split.url).toBe("https://trip.com/x");
  expect(split.text).not.toContain("https://");
  expect(splitForPlatform("S$58 https://trip.com/x", "terminal")).toEqual({ text: "S$58 https://trip.com/x" });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // not a decodable image: sips fails, raw bytes are used
  expect((await toImageBlock(jpeg, "image/jpeg"))?.source.media_type).toBe("image/jpeg");
  expect(await toImageBlock(jpeg, "application/pdf")).toBeNull();
  expect(await toImageBlock(new Uint8Array(5_000_000), "image/png")).toBeNull();
});
