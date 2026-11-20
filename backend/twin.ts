// "Create your twin": the user's footage goes to HeyGen through this backend (the HeyGen key never reaches the browser).
// Ownership is recorded in the twin's HeyGen name as a tag "[adtwin:<user id>]", which only this backend sets.
const HG = "https://api.heygen.com";
const APP = "https://thecodecrafterslab.github.io/adtwin-studio/";
export const MAX_BYTES = 48 * 1024 * 1024;

const key = () => {
  const k = process.env.HEYGEN_API_KEY;
  if (!k) throw new Error("HEYGEN_API_KEY is not set on the AdTwin backend");
  return k;
};
async function call(path: string, init: RequestInit = {}) {
  const r = await fetch(HG + path, { ...init, headers: { "x-api-key": key(), ...((init.headers as Record<string, string>) || {}) } });
  const text = await r.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, data };
}
const errOf = (d: Record<string, unknown>, fallback: string) => {
  const e = d?.error as Record<string, unknown> | string | undefined;
  return String((typeof e === "object" ? e?.message : e) || d?.message || fallback);
};
export const tagFor = (uid: string) => `[adtwin:${uid}]`;
const displayName = (n: string) => n.replace(/\s*\[adtwin:[^\]]+\]\s*/g, "").trim() || "My twin";

export type Look = Record<string, unknown> & { id: string; name: string; group_id?: string; status?: string; default_voice_id?: string };

// Every private look on the HeyGen account (paged, 50 at a time).
export async function allLooks(): Promise<Look[]> {
  const out: Look[] = [];
  let token = "";
  for (let i = 0; i < 20; i++) {
    const r = await call(`/v3/avatars/looks?ownership=private&limit=50${token ? "&token=" + encodeURIComponent(token) : ""}`);
    if (!r.ok) break;
    out.push(...((r.data.data as Look[]) || []));
    if (!r.data.has_more || !r.data.next_token) break;
    token = String(r.data.next_token);
  }
  return out;
}

// Twins this user made in AdTwin, with training and consent state.
export async function tagged(uid: string) {
  const tag = tagFor(uid);
  const looks = (await allLooks()).filter((l) => String(l.name || "").includes(tag));
  const groups = new Map<string, Record<string, unknown>>();
  for (const gid of new Set(looks.map((l) => String(l.group_id || "")).filter(Boolean))) {
    const g = await call("/v3/avatars/" + encodeURIComponent(gid));
    if (g.ok) groups.set(gid, (g.data.data as Record<string, unknown>) || {});
  }
  return looks.map((l) => {
    const g = groups.get(String(l.group_id || "")) || {};
    return {
      look_id: l.id, voice_id: String(l.default_voice_id || g.default_voice_id || ""), name: displayName(String(l.name)),
      group_id: String(l.group_id || ""), preview: l.preview_image_url || null,
      training: String(l.status || "processing"), consent: String(g.consent_status || "pending"),
      error: (l.error as Record<string, unknown>)?.message || null,
    };
  });
}

// Upload footage, then start training a digital twin tagged to this user.
export async function createTwin(uid: string, name: string, file: Blob, filename: string) {
  if (file.size < 200_000) return { status: 400, body: { error: "That video is too short or empty. Record about 2 minutes." } };
  if (file.size > MAX_BYTES) return { status: 413, body: { error: "That video is over 48 MB. Record at a lower quality or trim it." } };
  const mine = await tagged(uid);
  if (mine.filter((t) => t.training !== "failed").length >= 3) return { status: 409, body: { error: "You already have 3 twins. Delete one in My twin first." } };
  const form = new FormData();
  form.append("file", file, filename);
  const up = await call("/v3/assets", { method: "POST", body: form });
  const asset = String((up.data.data as Record<string, unknown>)?.asset_id || "");
  if (!up.ok || !asset) return { status: 502, body: { error: "Upload to the twin service failed: " + errOf(up.data, `HTTP ${up.status}`) } };
  const full = `${name.replace(/[\[\]]/g, "").slice(0, 40) || "My twin"} ${tagFor(uid)}`;
  const mk = await call("/v3/avatars", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ type: "digital_twin", name: full, file: { type: "asset_id", asset_id: asset } }),
  });
  const d = (mk.data.data as Record<string, Record<string, unknown>>) || {};
  if (!mk.ok || !d.avatar_item?.id) return { status: 502, body: { error: "The twin couldn't be started: " + errOf(mk.data, `HTTP ${mk.status}`) } };
  return { status: 200, body: { look_id: d.avatar_item.id, group_id: d.avatar_group?.id || d.avatar_item.group_id, training: d.avatar_item.status || "processing" } };
}

// A HeyGen-hosted page (valid 24 hours) where the person records their consent on webcam.
export async function consentLink(uid: string, groupId: string) {
  const mine = await tagged(uid);
  if (!mine.some((t) => t.group_id === groupId)) return { status: 403, body: { error: "That twin isn't on your account." } };
  const r = await call(`/v3/avatars/${encodeURIComponent(groupId)}/consent`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ reroute_url: APP + "?twin=consented" }),
  });
  const url = String((r.data.data as Record<string, unknown>)?.url || "");
  if (!r.ok || !url) return { status: 502, body: { error: "Couldn't get the consent page: " + errOf(r.data, `HTTP ${r.status}`) } };
  return { status: 200, body: { url } };
}

export async function deleteTwin(uid: string, groupId: string) {
  const mine = await tagged(uid);
  if (!mine.some((t) => t.group_id === groupId)) return { status: 403, body: { error: "That twin isn't on your account." } };
  const r = await call("/v3/avatars/" + encodeURIComponent(groupId), { method: "DELETE" });
  return r.ok ? { status: 200, body: { ok: true } } : { status: 502, body: { error: errOf(r.data, `HTTP ${r.status}`) } };
}
