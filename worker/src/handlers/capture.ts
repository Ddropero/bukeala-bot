import type { Context } from "hono";
import type { Env } from "../env";
import { saveSession, type Cookie } from "../kv";

export async function handleCapture(c: Context<{ Bindings: Env }>) {
  const token = c.req.header("X-Capture-Token");
  if (!token || token !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { cookies: Cookie[]; capturedAt?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  if (!Array.isArray(body.cookies) || body.cookies.length === 0) {
    return c.json({ error: "no cookies" }, 400);
  }

  // Sanity: keep only relevant cookies and trim absurd values.
  const cleaned = body.cookies
    .filter((c) => typeof c.name === "string" && typeof c.value === "string")
    .filter((c) =>
      c.domain.includes("tuscitasmedicas.com") ||
      c.domain.includes("colsanitas.com"),
    )
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? "/",
      expires: c.expires,
      httpOnly: c.httpOnly,
    }));

  if (cleaned.length === 0) {
    return c.json({ error: "no relevant cookies" }, 400);
  }

  await saveSession(c.env, {
    cookies: cleaned,
    capturedAt: body.capturedAt ?? new Date().toISOString(),
  });

  const expirations = cleaned.map((c) => c.expires).filter((x): x is number => typeof x === "number");
  const minExp = expirations.length ? Math.min(...expirations) : null;
  const expiresAt = minExp ? new Date(minExp * 1000).toISOString() : "session-only";

  return c.json({
    ok: true,
    cookieCount: cleaned.length,
    cookieNames: cleaned.map((c) => c.name),
    expiresAt,
  });
}
