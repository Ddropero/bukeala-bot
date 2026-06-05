import type { Context } from "hono";
import type { Env } from "../env";
import { saveSession, type Cookie } from "../kv";
import { processPendingRequests } from "../claudeBookingAgent";

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
  const relevant = body.cookies
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

  // DEDUP por nombre: Bukeala/Reblaze emiten la MISMA cookie (XB-TRANSACTION,
  // rdwr_s_*, etc.) con distintos path/domain, y guardar todas las copias
  // infla la sesión y rompe el routing. Para JSESSIONID preferimos el ligado
  // a /keraltyadscritos. Para el resto, la última gana (la más reciente).
  const byName = new Map<string, typeof relevant[number]>();
  for (const ck of relevant) {
    const ex = byName.get(ck.name);
    if (!ex) { byName.set(ck.name, ck); continue; }
    if (ck.name === "JSESSIONID") {
      const ckK = (ck.path || "").includes("keraltyadscritos");
      const exK = (ex.path || "").includes("keraltyadscritos");
      if (ckK && !exK) byName.set(ck.name, ck);
    } else {
      byName.set(ck.name, ck); // última gana
    }
  }
  const cleaned = [...byName.values()];

  if (cleaned.length === 0) {
    return c.json({ error: "no relevant cookies" }, 400);
  }
  console.log(`[capture] ${relevant.length} cookies → ${cleaned.length} tras dedup`);

  await saveSession(c.env, {
    cookies: cleaned,
    capturedAt: body.capturedAt ?? new Date().toISOString(),
  });

  // Session is fresh now → auto-process any pending WhatsApp requests
  // (the patient's request that got "queued" while Bukeala was down).
  c.executionCtx.waitUntil(
    processPendingRequests(c.env).catch((err) => {
      console.log("[capture] processPendingRequests failed:", err.message);
    }),
  );

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
