import { Database } from "bun:sqlite";

export type Role = "user" | "assistant";

export type Confirm = { id: number; sender: string; summary: string; url: string | null; goal: string | null; created_at: number; confirmed_at: number | null; consumed_at: number | null };

export type Watch = {
  id: number; sender: string; space_id: string; platform: string; url: string; condition: string;
  interval_min: number; any_time: number; created_at: number; expires_at: number;
  last_check_at: number | null; last_hash: string | null; last_value: string | null;
  notified_at: number | null; notify_count: number; error_count: number;
  pending_notice: string | null; deliver_after: number | null; active: number; mode: "fetch" | "agent";
};

/** A "yes" is only good for this long after the question was asked. */
export const CONFIRM_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** One SQLite file: per-person notes, per-conversation history, seen ids, confirmations, watches, run budget. */
export function openDb(path = process.env.KAYPOH_DB ?? "kaypoh.sqlite") {
  const db = new Database(path);
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists users (address text primary key, notes text not null default '', greeted_at integer);
    create table if not exists history (id integer primary key, space_id text not null, role text not null, content text not null, ts integer not null);
    create index if not exists history_space on history(space_id, id);
    create table if not exists seen (message_id text primary key, ts integer not null);
    create table if not exists confirms (id integer primary key, sender text not null, summary text not null, url text, goal text, created_at integer not null, confirmed_at integer, consumed_at integer);
    create table if not exists watches (
      id integer primary key, sender text not null, space_id text not null, platform text not null, url text not null, condition text not null,
      interval_min integer not null, any_time integer not null default 0, created_at integer not null, expires_at integer not null,
      last_check_at integer, last_hash text, last_value text, notified_at integer, notify_count integer not null default 0,
      error_count integer not null default 0, pending_notice text, deliver_after integer, active integer not null default 1, mode text not null default 'fetch');
    create table if not exists agent_runs (id integer primary key, sender text not null, ts integer not null, steps integer);
  `);
  // ponytail: the one migration so far; replace with a versioned list if more arrive
  const cols = (db.query("pragma table_info(watches)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("mode")) db.exec("alter table watches add column mode text not null default 'fetch'");

  const pendingConfirm = (sender: string, now: number) =>
    db.query("select * from confirms where sender = ? and confirmed_at is null and consumed_at is null and created_at > ? order by id desc limit 1")
      .get(sender, now - CONFIRM_TTL_MS) as Confirm | null;

  return {
    /** True if this message id was already handled; records it otherwise. */
    isDuplicate(messageId: string): boolean {
      return db.run("insert or ignore into seen (message_id, ts) values (?, ?)", [messageId, Date.now()]).changes === 0;
    },
    notes(address: string): string {
      const row = db.query("select notes from users where address = ?").get(address) as { notes: string } | null;
      return row?.notes ?? "";
    },
    remember(address: string, note: string): void {
      db.run("insert into users (address, notes) values (?, ?) on conflict(address) do update set notes = notes || char(10) || excluded.notes", [address, note]);
    },
    /** True the first time a person is replied to; marks them greeted. */
    firstContact(address: string, now = Date.now()): boolean {
      const row = db.query("select greeted_at from users where address = ?").get(address) as { greeted_at: number | null } | null;
      if (row?.greeted_at) return false;
      db.run("insert into users (address, greeted_at) values (?, ?) on conflict(address) do update set greeted_at = excluded.greeted_at", [address, now]);
      return true;
    },
    history(spaceId: string, limit = 20): { role: Role; content: string }[] {
      const rows = db.query("select role, content from history where space_id = ? order by id desc limit ?").all(spaceId, limit) as { role: Role; content: string }[];
      return rows.reverse();
    },
    append(spaceId: string, role: Role, content: string): void {
      db.run("insert into history (space_id, role, content, ts) values (?, ?, ?, ?)", [spaceId, role, content, Date.now()]);
    },

    // Confirmation gate: ask -> user says yes -> one run may consume it, within CONFIRM_TTL_MS.
    /** Stores the exact action awaiting a yes; a later "act" run executes this stored request, not a new one. */
    requestConfirm(sender: string, summary: string, input: { url: string; goal: string } | null = null, now = Date.now()): void {
      db.run("update confirms set consumed_at = ? where sender = ? and consumed_at is null", [now, sender]);
      db.run("insert into confirms (sender, summary, url, goal, created_at) values (?, ?, ?, ?, ?)", [sender, summary, input?.url ?? null, input?.goal ?? null, now]);
    },
    pendingConfirm(sender: string, now = Date.now()): Confirm | null {
      return pendingConfirm(sender, now);
    },
    confirm(sender: string, now = Date.now()): boolean {
      const p = pendingConfirm(sender, now);
      if (!p) return false;
      db.run("update confirms set confirmed_at = ? where id = ?", [now, p.id]);
      return true;
    },
    takeConfirmed(sender: string, now = Date.now()): Confirm | null {
      const c = db.query("select * from confirms where sender = ? and confirmed_at is not null and consumed_at is null and confirmed_at > ? order by id desc limit 1")
        .get(sender, now - CONFIRM_TTL_MS) as Confirm | null;
      if (c) db.run("update confirms set consumed_at = ? where id = ?", [now, c.id]);
      return c;
    },
    clearConfirms(sender: string, now = Date.now()): void {
      db.run("update confirms set consumed_at = ? where sender = ? and consumed_at is null", [now, sender]);
    },

    // Watches
    addWatch(w: { sender: string; space_id: string; platform: string; url: string; condition: string; interval_min: number; any_time: boolean; days: number; mode?: "fetch" | "agent" }, now = Date.now()): number {
      return Number(
        db.run(
          "insert into watches (sender, space_id, platform, url, condition, interval_min, any_time, created_at, expires_at, mode) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [w.sender, w.space_id, w.platform, w.url, w.condition, w.interval_min, w.any_time ? 1 : 0, now, now + w.days * DAY_MS, w.mode ?? "fetch"],
        ).lastInsertRowid,
      );
    },
    activeWatches(sender?: string): Watch[] {
      return sender
        ? (db.query("select * from watches where active = 1 and sender = ? order by id").all(sender) as Watch[])
        : (db.query("select * from watches where active = 1 order by id").all() as Watch[]);
    },
    watch(id: number): Watch | null {
      return db.query("select * from watches where id = ?").get(id) as Watch | null;
    },
    /** What the scheduler visits: live watches plus any with a notice waiting for morning. */
    watchesToVisit(): Watch[] {
      return db.query("select * from watches where active = 1 or pending_notice is not null order by id").all() as Watch[];
    },
    updateWatch(id: number, patch: Partial<Watch>): void {
      const keys = Object.keys(patch) as (keyof Watch)[];
      if (!keys.length) return;
      db.run(`update watches set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`, [...keys.map((k) => patch[k] as string | number | null), id]);
    },
    cancelWatch(id: number): void {
      db.run("update watches set active = 0, pending_notice = null, deliver_after = null where id = ?", [id]);
    },

    // Agent run budget (rolling 24 h per person)
    agentRunsToday(sender: string, now = Date.now()): number {
      return (db.query("select count(*) as n from agent_runs where sender = ? and ts > ?").get(sender, now - DAY_MS) as { n: number }).n;
    },
    recordAgentRun(sender: string, steps: number | null, now = Date.now()): void {
      db.run("insert into agent_runs (sender, ts, steps) values (?, ?, ?)", [sender, now, steps]);
    },
  };
}

export type Db = ReturnType<typeof openDb>;
