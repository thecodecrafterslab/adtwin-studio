// Meta (Facebook/Instagram) one-click launch for AdTwin.
// Each customer connects their OWN Meta ad account with Facebook Login; AdTwin never spends its own money.
// Settings (function environment variables): META_APP_ID, META_APP_SECRET, optional META_CONFIG_ID (Facebook Login for Business
// configuration) and META_GRAPH_VERSION. The customer's token is stored AES-GCM encrypted in Neon (meta_connections, row-level security),
// so the browser only ever sees ciphertext.
const DATA_API = "https://ep-curly-smoke-a1bezxvs.apirest.ap-southeast-1.aws.neon.tech/neondb/rest/v1";
export const APP_URL = "https://thecodecrafterslab.github.io/adtwin-studio/";
const SCOPES = "ads_management,ads_read,business_management,pages_show_list,pages_read_engagement";
const ver = () => process.env.META_GRAPH_VERSION || "v24.0";
const GRAPH = () => `https://graph.facebook.com/${ver()}`;

function cfg() {
  const id = process.env.META_APP_ID, secret = process.env.META_APP_SECRET;
  if (!id || !secret) throw new Error("Meta isn't set up yet (META_APP_ID / META_APP_SECRET missing in the AdTwin backend settings).");
  return { id, secret, config: process.env.META_CONFIG_ID || "" };
}
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
async function aesKey() {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(cfg().secret + "|adtwin-meta-token"));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(text)));
  return b64(iv) + "." + b64(ct);
}
async function unseal(s: string) {
  const [iv, ct] = s.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(), unb64(ct)));
}

// Graph API call with appsecret_proof. Throws a readable error.
async function graph(token: string, path: string, method = "GET", params: Record<string, unknown> = {}) {
  const u = new URL(GRAPH() + path);
  const form = new URLSearchParams();
  const all: Record<string, unknown> = { ...params, access_token: token, appsecret_proof: await hmac(cfg().secret, token) };
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined || v === null) continue;
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (method === "GET" || method === "DELETE") u.searchParams.set(k, s); else form.set(k, s);
  }
  const r = await fetch(u, { method, body: method === "GET" || method === "DELETE" ? undefined : form });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    const e = d.error || {};
    throw new Error(e.error_user_msg || e.message || `Meta error ${r.status}`);
  }
  return d;
}

// Neon rows through the Data API with the user's own login token (row-level security).
async function row(jwt: string) {
  const r = await fetch(DATA_API + "/meta_connections?select=*", { headers: { Authorization: "Bearer " + jwt } });
  const d = r.ok ? await r.json() : [];
  return (d[0] || null) as Record<string, string> | null;
}
async function upsert(jwt: string, v: Record<string, unknown>) {
  const r = await fetch(DATA_API + "/meta_connections?on_conflict=user_id", {
    method: "POST",
    headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ ...v, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error("Couldn't save the Meta connection (" + r.status + ")");
}
async function patch(jwt: string, v: Record<string, unknown>) {
  const r = await fetch(DATA_API + "/meta_connections", {
    method: "PATCH", headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ ...v, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error("Couldn't save your choice (" + r.status + ")");
}
async function tokenFor(jwt: string) {
  const c = await row(jwt);
  if (!c) throw Object.assign(new Error("Connect Facebook first."), { code: 409 });
  return { c, token: await unseal(c.token_enc) };
}

const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "COP", "CRC", "HUF", "ISK", "IDR", "PYG", "TWD", "VND"]);
const minor = (amount: number, cur: string) => Math.round(amount * (ZERO_DECIMAL.has(cur) ? 1 : 100));
const CTA: Record<string, string> = { "Shop now": "SHOP_NOW", "Learn more": "LEARN_MORE", "Send message": "CONTACT_US", "Get offer": "GET_OFFER" };

export async function metaAction(action: string, body: Record<string, unknown>, jwt: string, uid: string,
  videoUrl: (id: string) => Promise<string>): Promise<{ status: number; body: unknown } | null> {
  if (!action.startsWith("meta_")) return null;
  try {
    switch (action) {
      // Is Meta configured on the server, and is this user connected?
      case "meta_status": {
        const ready = !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
        const c = ready ? await row(jwt) : null;
        if (!c) return { status: 200, body: { ready, connected: false } };
        const { token_enc: _t, ...safe } = c;
        let accounts: unknown[] = [], pages: unknown[] = [];
        try {
          const token = await unseal(c.token_enc);
          accounts = (await graph(token, "/me/adaccounts", "GET", { fields: "id,name,currency,account_status", limit: 50 })).data || [];
          pages = (await graph(token, "/me/accounts", "GET", { fields: "id,name", limit: 50 })).data || [];
        } catch (e) { return { status: 200, body: { ready, connected: true, expired: true, error: (e as Error).message, ...safe } }; }
        return { status: 200, body: { ready, connected: true, ...safe, accounts, pages } };
      }
      // Facebook Login dialog URL. State is signed so the code can only be redeemed by the user who started it.
      case "meta_login_url": {
        const { id, secret, config } = cfg();
        const ts = Date.now().toString(36);
        const state = `${ts}.${(await hmac(secret, uid + "|" + ts)).slice(0, 32)}`;
        const u = new URL(`https://www.facebook.com/${ver()}/dialog/oauth`);
        u.searchParams.set("client_id", id);
        u.searchParams.set("redirect_uri", APP_URL);
        u.searchParams.set("state", state);
        u.searchParams.set("response_type", "code");
        if (config) u.searchParams.set("config_id", config); else u.searchParams.set("scope", SCOPES);
        return { status: 200, body: { url: u.toString() } };
      }
      // Swap the login code for a long-lived token, store it encrypted, pick defaults.
      case "meta_connect": {
        const { id, secret } = cfg();
        const [ts, sig] = String(body.state || "").split(".");
        if (!ts || !sig || sig !== (await hmac(secret, uid + "|" + ts)).slice(0, 32) || Date.now() - parseInt(ts, 36) > 15 * 60e3)
          return { status: 400, body: { error: "That Facebook login expired or wasn't started here. Click Connect Facebook again." } };
        const q = (p: Record<string, string>) => fetch(`${GRAPH()}/oauth/access_token?` + new URLSearchParams(p)).then((r) => r.json());
        const short = await q({ client_id: id, client_secret: secret, redirect_uri: APP_URL, code: String(body.code || "") });
        if (!short.access_token) return { status: 400, body: { error: short.error?.message || "Facebook didn't return a login token." } };
        const long = await q({ grant_type: "fb_exchange_token", client_id: id, client_secret: secret, fb_exchange_token: short.access_token });
        const token = long.access_token || short.access_token;
        const me = await graph(token, "/me", "GET", { fields: "id,name" });
        const accounts = (await graph(token, "/me/adaccounts", "GET", { fields: "id,name,currency,account_status", limit: 50 })).data || [];
        const pages = (await graph(token, "/me/accounts", "GET", { fields: "id,name", limit: 50 })).data || [];
        const acct = accounts.find((a: { account_status: number }) => a.account_status === 1) || accounts[0];
        await upsert(jwt, {
          user_id: uid, fb_user_id: me.id, fb_name: me.name || "", token_enc: await seal(token),
          token_expires_at: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null,
          ad_account_id: acct?.id || null, ad_account_name: acct?.name || null, currency: acct?.currency || null,
          page_id: pages[0]?.id || null, page_name: pages[0]?.name || null,
        });
        return { status: 200, body: { ok: true, name: me.name, accounts: accounts.length, pages: pages.length } };
      }
      case "meta_select": {
        const { token } = await tokenFor(jwt);
        const v: Record<string, unknown> = {};
        if (body.ad_account_id) {
          const a = await graph(token, "/" + String(body.ad_account_id), "GET", { fields: "id,name,currency" });
          Object.assign(v, { ad_account_id: a.id, ad_account_name: a.name, currency: a.currency });
        }
        if (body.page_id) {
          const pages = (await graph(token, "/me/accounts", "GET", { fields: "id,name", limit: 100 })).data || [];
          const p = pages.find((x: { id: string }) => x.id === String(body.page_id));
          if (!p) return { status: 403, body: { error: "That Page isn't one you manage." } };
          Object.assign(v, { page_id: p.id, page_name: p.name });
        }
        await patch(jwt, v);
        return { status: 200, body: { ok: true } };
      }
      // One-click launch: image or twin video -> campaign -> ad set -> creative -> ad.
      case "meta_launch": {
        const { c, token } = await tokenFor(jwt);
        if (!c.ad_account_id || !c.page_id) return { status: 400, body: { error: "Choose an ad account and a Facebook Page first." } };
        const link = String(body.link || "");
        if (!/^https?:\/\//.test(link)) return { status: 400, body: { error: "Add the product link the ad should open." } };
        const budget = Number(body.daily_budget || 0);
        if (!(budget >= 1 && budget <= 10000)) return { status: 400, body: { error: "Set a daily budget between 1 and 10,000." } };
        const countries = (Array.isArray(body.countries) ? body.countries : ["US"]).map((x) => String(x).toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)).slice(0, 25);
        const ageMin = Math.max(18, Math.min(65, Number(body.age_min || 18))), ageMax = Math.max(ageMin, Math.min(65, Number(body.age_max || 65)));
        const status = body.start_now ? "ACTIVE" : "PAUSED";
        const name = `AdTwin · ${String(body.name || "Ad").slice(0, 60)} · ${new Date().toISOString().slice(0, 10)}`;
        const act = "/" + c.ad_account_id;
        const cta = { type: CTA[String(body.cta)] || "LEARN_MORE", value: { link } };
        const message = String(body.text || "").slice(0, 2000), title = String(body.headline || "").slice(0, 255);

        let story: Record<string, unknown>;
        if (body.video_id) {
          const file_url = await videoUrl(String(body.video_id));
          if (!file_url) return { status: 400, body: { error: "That twin video isn't finished yet." } };
          const v = await graph(token, act + "/advideos", "POST", { file_url, name });
          let ready = false;
          for (let i = 0; i < 30 && !ready; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            const s = await graph(token, "/" + v.id, "GET", { fields: "status" });
            if (s.status?.video_status === "error") return { status: 502, body: { error: "Meta couldn't process the video." } };
            ready = s.status?.video_status === "ready";
          }
          if (!ready) return { status: 504, body: { error: "Meta is still processing the video. Try Launch again in a minute." } };
          const th = (await graph(token, "/" + v.id + "/thumbnails", "GET", {})).data || [];
          const thumb = (th.find((t: { is_preferred: boolean }) => t.is_preferred) || th[0])?.uri;
          story = { page_id: c.page_id, video_data: { video_id: v.id, image_url: thumb, message, title, call_to_action: cta } };
        } else {
          const m = String(body.image || "").match(/^data:image\/(?:png|jpeg);base64,(.+)$/);
          if (!m) return { status: 400, body: { error: "No ad image to upload." } };
          const up = await graph(token, act + "/adimages", "POST", { bytes: m[1] });
          const hash = (Object.values(up.images || {})[0] as { hash?: string })?.hash;
          if (!hash) return { status: 502, body: { error: "Meta didn't accept the image." } };
          story = { page_id: c.page_id, link_data: { image_hash: hash, link, message, name: title, call_to_action: cta } };
        }
        const camp = await graph(token, act + "/campaigns", "POST", {
          name, objective: "OUTCOME_TRAFFIC", status, special_ad_categories: [], is_adset_budget_sharing_enabled: false,
        });
        const set = await graph(token, act + "/adsets", "POST", {
          name, campaign_id: camp.id, status, daily_budget: minor(budget, c.currency || "USD"),
          billing_event: "IMPRESSIONS", optimization_goal: "LINK_CLICKS", bid_strategy: "LOWEST_COST_WITHOUT_CAP", destination_type: "WEBSITE",
          targeting: { geo_locations: { countries }, age_min: ageMin, age_max: ageMax, targeting_automation: { advantage_audience: 0 } },
        });
        const creative = await graph(token, act + "/adcreatives", "POST", { name, object_story_spec: story });
        const ad = await graph(token, act + "/ads", "POST", { name, adset_id: set.id, creative: { creative_id: creative.id }, status });
        return { status: 200, body: { ok: true, campaign_id: camp.id, adset_id: set.id, ad_id: ad.id, status, name,
          manage_url: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${c.ad_account_id.replace("act_", "")}&selected_campaign_ids=${camp.id}` } };
      }
      // AdTwin campaigns on the chosen account, with last-7-day results.
      case "meta_campaigns": {
        const { c, token } = await tokenFor(jwt);
        if (!c.ad_account_id) return { status: 200, body: { data: [] } };
        const d = await graph(token, "/" + c.ad_account_id + "/campaigns", "GET", {
          fields: "id,name,status,effective_status,adsets.limit(1){daily_budget},insights.date_preset(last_7d){spend,clicks,ctr,cpc,impressions}",
          filtering: [{ field: "name", operator: "CONTAIN", value: "AdTwin" }], limit: 25,
        });
        return { status: 200, body: { currency: c.currency, data: d.data || [] } };
      }
      case "meta_set_status": {
        const { c, token } = await tokenFor(jwt);
        const id = String(body.campaign_id || ""), st = body.status === "ACTIVE" ? "ACTIVE" : "PAUSED";
        const camp = await graph(token, "/" + id, "GET", { fields: "account_id,name" });
        if ("act_" + camp.account_id !== c.ad_account_id || !String(camp.name).includes("AdTwin")) return { status: 403, body: { error: "That campaign wasn't made in AdTwin." } };
        await graph(token, "/" + id, "POST", { status: st });
        const sets = (await graph(token, "/" + id + "/adsets", "GET", { fields: "id" })).data || [];
        for (const s of sets) await graph(token, "/" + s.id, "POST", { status: st });
        return { status: 200, body: { ok: true, status: st } };
      }
      case "meta_disconnect": {
        const c = await row(jwt);
        if (c) { try { await graph(await unseal(c.token_enc), "/me/permissions", "DELETE"); } catch { /* token may already be dead */ } }
        await fetch(DATA_API + "/meta_connections", { method: "DELETE", headers: { Authorization: "Bearer " + jwt } });
        return { status: 200, body: { ok: true } };
      }
      default: return { status: 400, body: { error: "Unknown Meta action." } };
    }
  } catch (e) {
    return { status: (e as { code?: number }).code || 502, body: { error: (e as Error).message } };
  }
}
