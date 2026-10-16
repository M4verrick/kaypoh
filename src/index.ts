import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spectrum, markdown, richlink, type Message, type Space } from "spectrum-ts";
import { imessage, nativeContactCard } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { runTurn, type ImageBlock } from "./agent";
import { openDb, type Watch } from "./db";
import { startWatcher } from "./watches";

/** Collects a burst of items per key and flushes them as one batch after `ms` of quiet. */
export function createDebouncer<T>(ms: number, flush: (key: string, items: T[]) => unknown) {
  const pending = new Map<string, { items: T[]; timer?: ReturnType<typeof setTimeout> }>();
  return (key: string, item: T) => {
    const p = pending.get(key) ?? { items: [] };
    clearTimeout(p.timer);
    p.items.push(item);
    p.timer = setTimeout(() => {
      pending.delete(key);
      flush(key, p.items);
    }, ms);
    pending.set(key, p);
  };
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Base64 image block for Claude. HEIC/HEIF (iPhone photos) are converted with macOS sips. Null if unusable. */
export async function toImageBlock(bytes: Uint8Array, mime: string): Promise<ImageBlock | null> {
  let data = bytes;
  let type = mime.toLowerCase();
  if (type === "image/heic" || type === "image/heif") {
    const dir = await mkdtemp(join(tmpdir(), "kaypoh-"));
    const src = join(dir, "in.heic");
    const out = join(dir, "out.jpg");
    await Bun.write(src, bytes);
    const proc = Bun.spawn(["sips", "-s", "format", "jpeg", src, "--out", out], { stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    if (code === 0) data = new Uint8Array(await Bun.file(out).arrayBuffer());
    await rm(dir, { recursive: true, force: true });
    if (code !== 0) return null;
    type = "image/jpeg";
  }
  if (!IMAGE_TYPES.has(type)) return null;
  return { type: "image", source: { type: "base64", media_type: type as ImageBlock["source"]["media_type"], data: Buffer.from(data).toString("base64") } };
}

export const firstUrl = (s: string): string | undefined => s.match(/https?:\/\/[^\s)>\]]+/)?.[0];

type Inbound = { space: Space; message: Message; sender: string; platform: string; text: string; image?: ImageBlock };

if (import.meta.main) {
  const db = openDb();
  const providers = [terminal.config(), ...(process.env.SPECTRUM_PROJECT_ID ? [imessage.config()] : [])];
  const app = await Spectrum({ providers }); // project id/secret come from SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET
  console.log(`Kaypoh up: ${providers.length === 2 ? "terminal + iMessage" : "terminal only (set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET for iMessage)"}`);

  const spaces = new Map<string, Space>();
  const chains = new Map<string, Promise<unknown>>();
  // ponytail: one turn at a time per conversation instead of Photon's cancellable job pipeline
  const serialize = (key: string, job: () => Promise<unknown>) => {
    const next = (chains.get(key) ?? Promise.resolve()).then(job, job).catch((e) => console.error(e));
    chains.set(key, next);
    return next;
  };

  const resolveSpace = async (w: Watch): Promise<Space | undefined> => {
    const cached = spaces.get(w.space_id);
    if (cached) return cached;
    if (w.platform === "imessage") {
      const im = imessage(app);
      return im.space.create(await im.user(w.sender));
    }
    if (w.platform === "terminal") return terminal(app).space.get(w.space_id);
    return undefined;
  };
  const stopWatcher = startWatcher(db, {
    send: async (w, text) => {
      const space = await resolveSpace(w);
      if (!space) throw new Error(`no space for watch #${w.id}`);
      await space.send(markdown(text));
    },
  });

  const handle = async (spaceId: string, items: Inbound[]) => {
    const { space, sender, platform } = items[0]!;
    const last = items[items.length - 1]!.message;
    const text = items.map((i) => i.text).join("\n");
    const images = items.flatMap((i) => (i.image ? [i.image] : []));
    await space.responding(async () => {
      let reply: string;
      try {
        reply = await runTurn(db, { spaceId, sender, platform, text, images, onLongJob: () => void last.react("👀").catch(() => {}) });
      } catch (err) {
        console.error(err);
        reply = "Something broke on my side. Try again in a bit.";
      }
      await space.send(markdown(reply));
      const url = firstUrl(reply);
      if (url && platform === "imessage") await space.send(richlink(url)).catch(() => {});
      if (platform === "imessage" && db.firstContact(sender)) await space.send(nativeContactCard()).catch(() => {});
    });
  };
  const debounce = createDebouncer<Inbound>(Number(process.env.KAYPOH_DEBOUNCE_MS ?? 3000), (spaceId, items) => serialize(spaceId, () => handle(spaceId, items)));

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      stopWatcher();
      await app.stop();
      process.exit(0);
    });
  }

  for await (const [space, message] of app.messages) {
    if (message.direction === "outbound" || db.isDuplicate(message.id)) continue;
    spaces.set(space.id, space);
    const base = { space, message, sender: message.sender?.id ?? space.id, platform: message.platform };
    const c = message.content;
    if (c.type === "text") debounce(space.id, { ...base, text: c.text });
    else if (c.type === "richlink") debounce(space.id, { ...base, text: c.url });
    else if (c.type === "attachment") {
      const image = await toImageBlock(await c.read(), c.mimeType).catch(() => null);
      if (image) debounce(space.id, { ...base, text: "(photo attached)", image });
      else void serialize(space.id, () => space.send(`I can't read ${c.name} yet. Photos and text work; other files don't.`));
    } else if (c.type === "voice") void serialize(space.id, () => space.send("Can't listen to voice notes yet. Type it out and I'm on it."));
    // reactions, read receipts, typing signals, edits: nothing to do
  }
}
