// Sign-in proxy for Neon Auth, so logins work in every browser (no third-party cookies),
// plus verification of the Neon login token on every app request.
import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH = "https://ep-curly-smoke-a1bezxvs.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth";
const ORIGIN = "https://thecodecrafterslab.github.io";
const COOKIE = "__Secure-neon-auth.session_token";
const jwks = createRemoteJWKSet(new URL(AUTH + "/.well-known/jwks.json"));

export async function verifyUser(token: string): Promise<{ id: string; email: string } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks);
    return { id: String(payload.sub), email: String(payload.email || "") };
  } catch { return null; }
}

function sessionFrom(res: Response): string {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie().join(", ") : (res.headers.get("set-cookie") || "");
  const m = all.match(new RegExp(COOKIE.replace(/[.]/g, "\\.") + "=([^;]+)"));
  return m ? m[1] : "";
}

async function jwtFor(session: string): Promise<string> {
  const r = await fetch(AUTH + "/token", { headers: { Cookie: `${COOKIE}=${session}`, Origin: ORIGIN } });
  if (!r.ok) return "";
  const d = await r.json().catch(() => ({}));
  return d.token || "";
}

const errText = (d: Record<string, unknown>, fallback: string) =>
  String((d?.message as string) || (d?.error as Record<string, string>)?.message || d?.code || fallback);

export async function authAction(action: string, body: Record<string, unknown>) {
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  const password = String(body.password || "");
  if (action === "signup" || action === "signin") {
    if (!email || !password) return { status: 400, body: { error: "Enter your email and password." } };
    if (action === "signup" && password.length < 8) return { status: 400, body: { error: "Use a password of at least 8 characters." } };
    const path = action === "signup" ? "/sign-up/email" : "/sign-in/email";
    const payload = action === "signup" ? { email, password, name: String(body.name || email.split("@")[0]).slice(0, 80) } : { email, password };
    const r = await fetch(AUTH + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = errText(d, "Sign-in failed.");
      const friendly = /invalid email or password/i.test(msg) ? "That email and password don't match." :
        /already exists/i.test(msg) ? "An account with that email already exists. Log in instead." : msg;
      return { status: r.status === 422 || r.status === 400 ? 400 : 401, body: { error: friendly } };
    }
    const session = sessionFrom(r);
    const jwt = session ? await jwtFor(session) : "";
    if (!jwt) return { status: 502, body: { error: "Signed in, but couldn't start your session. Try again." } };
    return { status: 200, body: { session, jwt, user: { id: d.user?.id, email: d.user?.email, name: d.user?.name } } };
  }
  if (action === "refresh") {
    const session = String(body.session || "");
    const jwt = session ? await jwtFor(session) : "";
    if (!jwt) return { status: 401, body: { error: "Your session has ended. Please log in again." } };
    return { status: 200, body: { jwt } };
  }
  if (action === "signout") {
    const session = String(body.session || "");
    if (session) await fetch(AUTH + "/sign-out", { method: "POST", headers: { Cookie: `${COOKIE}=${session}`, Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    return { status: 200, body: { ok: true } };
  }
  return null;
}
