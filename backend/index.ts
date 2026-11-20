// AdTwin Studio backend on Neon Functions (Node 24). Moved from Supabase Edge Functions on 20 Nov 2026.
// Keys (HEYGEN_API_KEY, ANTHROPIC_API_KEY, META_APP_ID, META_APP_SECRET) are function environment variables, never in the browser.
// Sign-up/sign-in go through authAction; every other call needs a valid Neon login token in x-adtwin-token.
// Actions: looks | voices | generate | status | copy | fetch {url} | twin_list | twin_consent | twin_delete | meta_* (meta.ts),
// plus ?action=twin_upload (raw video body).
import { readProduct } from "./fetch";
import { authAction, verifyUser } from "./auth";
import { allLooks, tagged, createTwin, consentLink, deleteTwin, MAX_BYTES } from "./twin";
import { metaAction } from "./meta";

const HG = "https://api.heygen.com";
const ENGINES = new Set(["avatar_iii", "avatar_iv", "avatar_v"]);
const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];
const DATA_API = "https://ep-curly-smoke-a1bezxvs.apirest.ap-southeast-1.aws.neon.tech/neondb/rest/v1";

// Twins assigned to this user (row-level security means the token only sees its own rows),
// plus twins the user created in AdTwin that have finished training and have consent.
const READY = /^(accepted|approved|completed)$/i;
async function userTwins(jwt: string, uid: string): Promise<{ look_id: string; voice_id: string; name: string }[]> {
  const r = await fetch(DATA_API + "/twins?select=look_id,voice_id,name", { headers: { Authorization: "Bearer " + jwt } });
  const rows = r.ok ? await r.json() : [];
  const made = (await tagged(uid).catch(() => [])).filter((t) => t.training === "completed" && READY.test(t.consent) && t.voice_id);
  return [...rows, ...made.filter((t) => !rows.some((x: { look_id: string }) => x.look_id === t.look_id))];
}
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-adtwin-token, x-twin-name",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function hg(path: string, init: RequestInit = {}) {
  const key = process.env.HEYGEN_API_KEY;
  if (!key) throw new Error("HEYGEN_API_KEY is not set on the AdTwin backend");
  const r = await fetch(HG + path, { ...init, headers: { "x-api-key": key, "Content-Type": "application/json", ...((init.headers as Record<string, string>) || {}) } });
  const text = await r.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);

// Smaller models sometimes return nested objects as JSON text; turn them back into objects.
function unwrap(v: unknown): unknown {
  if (typeof v === "string") { const t = v.trim(); if (t.startsWith("{") || t.startsWith("[")) { try { return JSON.parse(t); } catch { /* keep text */ } } }
  return v;
}
function fixShape(input: unknown) {
  const c = unwrap(input) as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return null;
  const ads = unwrap(c.ads);
  const script = unwrap(c.video_script);
  return {
    ads: Array.isArray(ads) ? ads : undefined,
    video: { headline: c.video_headline, caption: c.video_caption, script: Array.isArray(script) ? script : undefined, spoken: c.video_spoken },
    audience: c.audience, budget: c.budget,
    _types: `ads:${Array.isArray(ads) ? "list" : typeof ads}, script:${Array.isArray(script) ? "list" : typeof script}`,
  } as { ads?: unknown[]; video: { script?: unknown[] }; _types: string };
}

async function writeCopy(body: Record<string, unknown>) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: "ANTHROPIC_API_KEY is not set yet, using template copy" }, 503);
  const p = (body.product || {}) as Record<string, unknown>;
  const presenter = body.useTwin ? `${clip(body.name, 40) || "the presenter"}, speaking to camera as themselves` : "an AI presenter";
  const prompt = `You are a direct-response ad copywriter for Facebook and Instagram.
Write ads for this product. Use the business's local context. Only make claims the details support; do not invent discounts, awards or guarantees.
Product: ${clip(p.name, 120)}
Business: ${clip(p.brand, 120)}
Price: ${clip(p.price, 40)}
Details: ${clip(p.desc, 1200)}
Tone: ${clip(p.tone, 20)}
Audience: ${clip(p.audience, 120) || "not given. Suggest the most likely buyers, including country or region"}
${body.image ? "A product photo is attached; use what you see in it." : ""}
Video presenter: ${presenter}.

Rules for the video:
- The presenter is an AI avatar filmed head and shoulders against a plain background. It can only speak to camera. It cannot hold, wear, touch, demonstrate or point at anything, and it cannot move around.
- Each script line is the exact words the presenter says aloud, in first person, never a description of an action.
- Put anything the viewer should see (product photo, close-up image, price, offer, link) in "visual" as an on-screen overlay that an editor adds. Keep visuals to still images and text.
- Do not claim the presenter made, tested or personally uses the product, or that they own or work for the business, unless the details say so. They can introduce themselves by first name only.

Budget: give the daily budget in the same currency as the price. If there is no price, use US dollars.

Use the ad_copy tool to return your answer: three ads with distinct angles, and a video of four timed lines running to about 24 seconds.`;
  const content: unknown[] = [];
  const m = typeof body.image === "string" && (body.image as string).match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
  if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  content.push({ type: "text", text: prompt });
  const tool = {
    name: "ad_copy",
    description: "Return the finished ad copy for the product.",
    input_schema: {
      type: "object",
      properties: {
        ads: { type: "array", minItems: 3, maxItems: 3, items: { type: "object", properties: {
          headline: { type: "string", description: "max 6 words" },
          text: { type: "string", description: "primary text, 1-2 sentences, max 220 characters" },
          cta: { type: "string", enum: ["Shop now", "Learn more", "Send message", "Get offer"] } }, required: ["headline", "text", "cta"] } },
        video_headline: { type: "string", description: "max 6 words" },
        video_caption: { type: "string", description: "on-screen caption, max 12 words" },
        video_script: { type: "array", minItems: 3, maxItems: 5, items: { type: "object", properties: {
          t: { type: "string", description: "time range, e.g. 0–3s" },
          line: { type: "string", description: "exact words the presenter speaks" },
          visual: { type: "string", description: "on-screen overlay: still image or text only" } }, required: ["t", "line", "visual"] } },
        video_spoken: { type: "string", description: "all the spoken lines joined, 45-60 words, first person" },
        audience: { type: "string", description: "who to target in Meta Ads Manager, one short line" },
        budget: { type: "string", description: "daily budget and duration, one sentence, in the price's currency" },
      },
      required: ["ads", "video_headline", "video_caption", "video_script", "video_spoken", "audience", "budget"],
    },
  };
  const errors: string[] = [];
  const ask = async (model: string, forced: boolean) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 2500, tools: [tool], tool_choice: forced ? { type: "tool", name: "ad_copy" } : { type: "auto" }, messages: [{ role: "user", content }] }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { err: String(d?.error?.message || `HTTP ${r.status}`) };
    const use = (d.content || []).find((c: { type: string }) => c.type === "tool_use");
    let c = fixShape(use?.input);
    if (!c) {
      const text = (d.content || []).filter((x: { type: string }) => x.type === "text").map((x: { text: string }) => x.text).join("");
      const i = text.indexOf("{"), j = text.lastIndexOf("}");
      if (i >= 0 && j > i) c = fixShape(text.slice(i, j + 1));
    }
    if (c?.ads?.length === 3 && c.video.script?.length) { const { _types, ...copy } = c; return { copy }; }
    return { err: "reply was missing parts of the ad copy (" + (c?._types || "no answer") + ")" };
  };
  for (const model of MODELS) {
    let res = await ask(model, true);
    if (res.err && /tool_choice/i.test(res.err)) res = await ask(model, false);
    if (res.err && /missing parts/.test(res.err)) res = await ask(model, false);
    if (res.copy) return json({ copy: res.copy, model });
    errors.push(`${model}: ${res.err}`);
  }
  return json({ error: errors.join("; ") }, 502);
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  // Footage upload: the video itself is the request body, so handle it before reading JSON.
  if (new URL(req.url).searchParams.get("action") === "twin_upload") {
    const user = await verifyUser(req.headers.get("x-adtwin-token") || "");
    if (!user) return json({ error: "Please log in again." }, 401);
    if (Number(req.headers.get("content-length") || 0) > MAX_BYTES) return json({ error: "That video is over 48 MB. Record at a lower quality or trim it." }, 413);
    try {
      const type = (req.headers.get("content-type") || "video/webm").split(";")[0];
      if (!/^video\/(mp4|webm|quicktime)$/.test(type)) return json({ error: "Use an MP4 or WebM video." }, 400);
      const blob = new Blob([await req.arrayBuffer()], { type });
      const name = decodeURIComponent(req.headers.get("x-twin-name") || "").slice(0, 40);
      const r = await createTwin(user.id, name, blob, type === "video/mp4" ? "twin.mp4" : type === "video/quicktime" ? "twin.mov" : "twin.webm");
      return json(r.body, r.status);
    } catch (e) { return json({ error: (e as Error).message }, 500); }
  }
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  if (body.action === "ping") return json({ ok: true, heygen: !!process.env.HEYGEN_API_KEY, anthropic: !!process.env.ANTHROPIC_API_KEY, meta: !!(process.env.META_APP_ID && process.env.META_APP_SECRET) });
  const a = await authAction(String(body.action || ""), body);
  if (a) return json(a.body, a.status);
  const jwt = req.headers.get("x-adtwin-token") || "";
  const user = await verifyUser(jwt);
  if (!user) return json({ error: "Please log in again." }, 401);
  // Meta launch. A twin video can only be launched by the user whose saved ad holds it.
  const meta = await metaAction(String(body.action || ""), body, jwt, user.id, async (id) => {
    const own = await fetch(DATA_API + "/ads?select=id&video_id=eq." + encodeURIComponent(id), { headers: { Authorization: "Bearer " + jwt } });
    if (!own.ok || !(await own.json()).length) return "";
    const r = await hg("/v3/videos/" + encodeURIComponent(id));
    const d = (r.data as { data?: { status?: string; video_url?: string } })?.data;
    return d?.status === "completed" ? String(d.video_url || "") : "";
  });
  if (meta) return json(meta.body, meta.status);
  try {
    switch (body.action) {
      case "looks": {
        const mine = await userTwins(jwt, user.id);
        if (!mine.length) return json({ data: [] });
        const ids = new Set(mine.map((t) => t.look_id));
        const all = await allLooks();
        return json({ data: all.filter((l) => ids.has(String(l.id))).map((l) => ({ ...l, name: mine.find((t) => t.look_id === l.id)?.name || l.name, default_voice_id: mine.find((t) => t.look_id === l.id)?.voice_id || l.default_voice_id })) });
      }
      case "voices": {
        const mine = await userTwins(jwt, user.id);
        if (!mine.length) return json({ data: [] });
        const r = await hg("/v3/models/audio/voices");
        const ids = new Set(mine.map((t) => t.voice_id));
        const all = ((r.data as { data?: Record<string, unknown>[] })?.data || []);
        const found = all.filter((v) => ids.has(String(v.voice_id)));
        for (const t of mine) if (!found.some((v) => String(v.voice_id) === t.voice_id)) found.push({ voice_id: t.voice_id, name: t.name + " (cloned voice)" });
        return json({ data: found });
      }
      case "generate": {
        const script = String(body.script || "").trim();
        if (!body.avatar_id || !body.voice_id) return json({ error: "avatar_id and voice_id are required" }, 400);
        const mine = await userTwins(jwt, user.id);
        if (!mine.some((t) => t.look_id === String(body.avatar_id) && t.voice_id === String(body.voice_id)))
          return json({ error: "That twin isn't set up on your account." }, 403);
        if (!script) return json({ error: "script is required" }, 400);
        if (script.length > 1500) return json({ error: "script is too long for an ad (max 1500 characters)" }, 400);
        const payload: Record<string, unknown> = {
          type: "avatar", avatar_id: String(body.avatar_id), voice_id: String(body.voice_id), script,
          title: String(body.title || "AdTwin ad").slice(0, 100), resolution: "1080p", aspect_ratio: String(body.aspect_ratio || "9:16"),
        };
        const engine = String(body.engine || "");
        if (ENGINES.has(engine) && engine !== "avatar_iv") payload.engine = { type: engine };
        const r = await hg("/v3/videos", { method: "POST", body: JSON.stringify(payload) });
        return json(r.data, r.ok ? 200 : r.status);
      }
      case "status": {
        if (!body.video_id) return json({ error: "video_id is required" }, 400);
        const r = await hg("/v3/videos/" + encodeURIComponent(String(body.video_id)));
        return json(r.data, r.ok ? 200 : r.status);
      }
      case "twin_list": return json({ data: await tagged(user.id) });
      case "twin_consent": { const r = await consentLink(user.id, String(body.group_id || "")); return json(r.body, r.status); }
      case "twin_delete": { const r = await deleteTwin(user.id, String(body.group_id || "")); return json(r.body, r.status); }
      case "copy": return await writeCopy(body);
      case "fetch": {
        const r = await readProduct(String(body.url || ""));
        return json(r, "error" in r ? 422 : 200);
      }
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (e) { return json({ error: (e as Error).message }, 500); }
}

const handler = { fetch: handle };
export default handler;
