import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spectrum, markdown, richlink, type Message, type Space } from "spectrum-ts";
import { imessage, nativeContactCard } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { firstUrl, runTurn, type ImageBlock } from "./agent";
import { openDb, type Watch } from "./db";
import { hostOf } from "./tinyfish";
import { startWatcher } from "./watches";
const ts = () => new Date().toLocaleTimeString("en-SG", { hour12: false, timeZone: process.env.KAYPOH_TZ ?? "Asia/Singapore" });

/** Collects a burst of items per key and flushes them as one batch after `ms` of quiet. `onFirst` fires when a burst starts. */
export function createDebouncer<T>(ms: number, flush: (key: string, items: T[]) => unknown, onFirst?: (key: string, item: T) => unknown) {
  const pending = new Map<string, { items: T[]; timer?: ReturnType<typeof setTimeout> }>();
  return (key: string, item: T) => {
    const p = pending.get(key) ?? { items: [] };
    if (!p.items.length) onFirst?.(key, item);
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
const EXT: Record<string, string> = { "image/heic": "heic", "image/heif": "heif", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
const RAW_LIMIT = 4_500_000; // the API rejects ~5 MB images

/** Base64 image block for Claude. Every photo is resampled to ≤1600 px JPEG with macOS sips (also converts HEIC). Null if unusable. */
export async function toImageBlock(bytes: Uint8Array, mime: string): Promise<ImageBlock | null> {
  const type = mime.toLowerCase();
  if (!(type in EXT)) return null;
  const dir = await mkdtemp(join(tmpdir(), "kaypoh-"));
  try {
    const src = join(dir, `in.${EXT[type]}`);
    const out = join(dir, "out.jpg");
    await Bun.write(src, bytes);
    const proc = Bun.spawn(["sips", "-s", "format", "jpeg", "-Z", "1600", src, "--out", out], { stdout: "ignore", stderr: "ignore" });
    if ((await proc.exited) === 0) {
      return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(await Bun.file(out).arrayBuffer()).toString("base64") } };
    }
  } catch {
    // fall through to the raw bytes
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (!IMAGE_TYPES.has(type) || bytes.byteLength > RAW_LIMIT) return null;
  return { type: "image", source: { type: "base64", media_type: type as ImageBlock["source"]["media_type"], data: Buffer.from(bytes).toString("base64") } };
}

/** On iMessage the first URL leaves the bubble and becomes one rich-link preview; elsewhere the text stands alone. */
export function splitForPlatform(text: string, platform: string, primaryUrl?: string): { text: string; url?: string } {
  const url = firstUrl(text) ?? primaryUrl;
  if (platform !== "imessage" || !url) return { text };
  return { text: text.replace(url, hostOf(url)).replace(/[ \t]*\n{2,}/g, "\n\n").trim(), url };
}

type Inbound = { space: Space; message: Message; sender: string; platform: string; text: string; image?: ImageBlock };

if (import.meta.main) {
  const db = openDb();
  const withTerminal = process.env.KAYPOH_TERMINAL !== "0"; // KAYPOH_TERMINAL=0 for a headless service
  const withIMessage = Boolean(process.env.SPECTRUM_PROJECT_ID);
  const providers = [...(withTerminal ? [terminal.config()] : []), ...(withIMessage ? [imessage.config()] : [])];
  if (!providers.length) throw new Error("nothing to run: enable the terminal or set SPECTRUM_PROJECT_ID/SECRET");
  const app = await Spectrum({ providers }); // project id/secret come from SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET
  console.log(`Kaypoh up: ${[withTerminal && "terminal", withIMessage && "iMessage"].filter(Boolean).join(" + ")}`);

  const spaces = new Map<string, Space>();
  const chains = new Map<string, Promise<unknown>>();
  // ponytail: one turn at a time per conversation instead of Photon's cancellable job pipeline
  const serialize = (key: string, job: () => Promise<unknown>) => {
    const next = (chains.get(key) ?? Promise.resolve()).then(job, job).catch((e) => console.error(e));
    chains.set(key, next);
    return next;
  };
  const sendText = async (space: Space, platform: string, text: string, primaryUrl?: string) => {
    const parts = splitForPlatform(text, platform, primaryUrl);
    await space.send(markdown(parts.text));
    if (parts.url) await space.send(richlink(parts.url)).catch(() => {});
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
      await sendText(space, w.platform, text);
      console.log(`${ts()} [alert] watch #${w.id} -> ${w.platform} ${w.sender}: ${text.slice(0, 160).replace(/\n/g, " / ")}`);
    },
  });

  const handle = async (spaceId: string, items: Inbound[]) => {
    const { space, sender, platform } = items[0]!;
    const last = items[items.length - 1]!.message;
    const text = items.map((i) => i.text).join("\n");
    const images = items.flatMap((i) => (i.image ? [i.image] : []));
    console.log(`${ts()} [in] ${platform} ${sender}: ${text.slice(0, 120).replace(/\n/g, " / ")}${images.length ? ` (+${images.length} photo)` : ""}`);
    const started = Date.now();
    let toldLongJob = false;
    const onLongJob = () => {
      if (toldLongJob) return;
      toldLongJob = true;
      void last.react("👀").catch(() => {});
      console.log(`${ts()} [notice] ${platform} ${sender}: on-it sent`);
      void space.send("On it. That page needs a real browser, give me a couple of minutes.").catch(() => {}); // typing dots time out long before a browser run ends
    };
    await space.responding(async () => {
      try {
        const turn = await runTurn(db, { spaceId, sender, platform, text, images, onLongJob });
        await sendText(space, platform, turn.reply, turn.primaryUrl);
        turn.commit(); // history records only what was actually delivered
        console.log(`${ts()} [out] ${platform} ${sender} (${Math.round((Date.now() - started) / 1000)} s): ${turn.reply.slice(0, 160).replace(/\n/g, " / ")}`);
      } catch (err) {
        console.error(err);
        await space.send("Something broke on my side. Try again in a bit.");
      }
      // Contact card on the second exchange: the first reply stays plain text.
      if (platform === "imessage" && db.history(spaceId).length >= 4 && db.firstContact(sender)) await space.send(nativeContactCard()).catch(() => {});
    });
  };
  const debounce = createDebouncer<Inbound>(
    Number(process.env.KAYPOH_DEBOUNCE_MS ?? 2000),
    (spaceId, items) => serialize(spaceId, () => handle(spaceId, items)),
    (_spaceId, first) => {
      if (first.platform === "imessage") void first.message.read().catch(() => {}); // read receipt the moment the burst starts
      void first.space.startTyping().catch(() => {}); // typing dots too; responding() takes over at flush
    },
  );

  // `bun run src/index.ts --knock=+6591234567` sends a text-only opener so the thread exists on that phone (registered users only).
  const knock = process.argv.find((a) => a.startsWith("--knock="))?.slice("--knock=".length);
  if (knock && withIMessage) {
    try {
      const im = imessage(app);
      const space = await im.space.create(await im.user(knock));
      await space.send("Hey, Kaypoh here. Text me a link or a question and I'll check it on the web for you.");
      console.log(`${ts()} [knock] opener sent to ${knock}`);
    } catch (err) {
      // Free/Pro shared lines cannot start a conversation: the person must text the line first (Photon's redirect link does this).
      console.error(`${ts()} [knock] could not send to ${knock}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      stopWatcher();
      await app.stop();
      process.exit(0);
    });
  }

  // iMessage delivers a photo with a caption as one "group" of inner messages; unpack it so text and image land in the same batch.
  const ingest = async (space: Space, base: Omit<Inbound, "text" | "image">, c: Message["content"]): Promise<void> => {
    if (c.type === "text") debounce(space.id, { ...base, text: c.text });
    else if (c.type === "richlink") debounce(space.id, { ...base, text: c.url });
    else if (c.type === "attachment") {
      const image = await toImageBlock(await c.read(), c.mimeType).catch(() => null);
      if (image) debounce(space.id, { ...base, text: "(photo attached)", image });
      else void serialize(space.id, () => space.send(`I can't read ${c.name} yet. Photos and text work; other files don't.`));
    } else if (c.type === "voice") void serialize(space.id, () => space.send("Can't listen to voice notes yet. Type it out and I'm on it."));
    else if (c.type === "group") for (const item of c.items) await ingest(space, base, item.content);
    else if (c.type !== "reaction" && c.type !== "read" && c.type !== "typing") console.log(`${ts()} [skip] ${base.platform} ${base.sender}: ${c.type}`);
  };

  for await (const [space, message] of app.messages) {
    if (message.direction === "outbound" || db.isDuplicate(message.id)) continue;
    spaces.set(space.id, space);
    await ingest(space, { space, message, sender: message.sender?.id ?? space.id, platform: message.platform }, message.content);
  }
}
