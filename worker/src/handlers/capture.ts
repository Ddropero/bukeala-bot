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
    // CAUSA RAÍZ del bug histórico: a veces llegan DOS cookies "JSESSIONID" —
    // la de Bukeala (appoint.tuscitasmedicas.com, la útil) y la del CAS
    // (app01.colsanitas.com, inútil para el Worker). Si se guarda la del CAS,
    // cookieHeader no la envía a appoint (filtra por dominio) → 302 al login.
    // Descartamos SIEMPRE el JSESSIONID de colsanitas: el Worker nunca lo usa.
    .filter((c) => !(c.name === "JSESSIONID" && c.domain.toLowerCase().includes("colsanitas")))
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
      // Preferir SIEMPRE el de dominio Bukeala (tuscitasmedicas); el del CAS ya
      // se filtró arriba, pero por si acaso. Empate de dominio → preferir path
      // /keraltyadscritos (el servlet de las consultas).
      const ckBuk = (ck.domain || "").toLowerCase().includes("tuscitasmedicas");
      const exBuk = (ex.domain || "").toLowerCase().includes("tuscitasmedicas");
      if (ckBuk && !exBuk) { byName.set(ck.name, ck); }
      else if (ckBuk === exBuk) {
        const ckK = (ck.path || "").includes("keraltyadscritos");
        const exK = (ex.path || "").includes("keraltyadscritos");
        if (ckK && !exK) byName.set(ck.name, ck);
      }
    } else {
      byName.set(ck.name, ck); // última gana
    }
  }
  const cleaned = [...byName.values()];

  if (cleaned.length === 0) {
    return c.json({ error: "no relevant cookies" }, 400);
  }
  const jsList = cleaned.filter((c) => c.name === "JSESSIONID").map((c) => `${c.domain}${c.path}`);
  console.log(
    `[capture] ${relevant.length} cookies → ${cleaned.length} tras dedup | ` +
    `JSESSIONID: ${jsList.length ? jsList.join(" , ") : "NONE"} | ` +
    `names: ${cleaned.map((c) => c.name).join(",").slice(0, 350)}`,
  );

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
