import type { Context } from "hono";
import type { Env } from "../env";
import { saveSession, type Cookie } from "../kv";
import { processPendingRequests } from "../claudeBookingAgent";
import { Bukeala } from "../bukeala";

/**
 * Prueba unas cookies CANDIDATAS contra Bukeala sin guardarlas.
 * Devuelve true solo si el endpoint autenticado responde 200 con JSON.
 */
async function candidateWorks(env: Env, cookies: Cookie[]): Promise<boolean> {
  // Solo las de Bukeala: es a appoint.tuscitasmedicas.com a donde vamos.
  const header = cookies
    .filter((c) => (c.domain || "").toLowerCase().includes("tuscitasmedicas"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  if (!header) return false;

  const url =
    `${env.BUKEALA_BASE}/findAvailability/loadComponents` +
    `?branchIdStr=${env.BRANCH_ID}&attentionType=P&areaCode=&authorizationCode=&_=${Date.now()}`;
  try {
    const res = await fetch(url, {
      headers: {
        Cookie: header,
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: `${env.BUKEALA_BASE}/findAvailability`,
      },
      redirect: "manual", // un 302 al login es fallo, no algo que seguir
    });
    if (res.status !== 200) {
      console.log(`[capture] candidata NO sirve: status ${res.status}`);
      return false;
    }
    const body = (await res.text().catch(() => "")).trim();
    const okJson = body.startsWith("[") || body.startsWith("{");
    if (!okJson) console.log(`[capture] candidata NO sirve: respuesta no-JSON`);
    return okJson;
  } catch (e) {
    // Error de red: no podemos concluir que sea mala.
    console.log(`[capture] probe de candidata falló (inconcluso): ${(e as Error).message}`);
    return true;
  }
}

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

  // GUARDIA ANTI-ENVENENAMIENTO (30/jul/2026).
  //
  // Cualquiera con el CAPTURE_TOKEN puede empujar cookies, y antes se
  // reemplazaba la sesión SIN mirar si servían. La extensión de Chrome del PC
  // del Dr. auto-empuja cada 5 min (background.js PERIOD_MIN=5); si ese Chrome
  // tiene una sesión de Bukeala caducada, pisaba la sesión BUENA de la VM y
  // tumbaba /agenda hasta el siguiente rescate. Medido ese día: disponibilidad
  // ~20-30% mientras el PC estuvo encendido.
  //
  // Regla: si YA hay una sesión que funciona y la candidata NO, se rechaza
  // (409) y se conserva la buena. Si no hay sesión viva, se acepta igual
  // (algo es mejor que nada y evita bloquear la recuperación).
  const current = new Bukeala(c.env);
  let currentAlive = false;
  try {
    const r = await current.findCustomerPage();
    await r.text();
    currentAlive = true;
  } catch { /* sin sesión o caída → aceptamos la candidata */ }

  if (currentAlive) {
    const ok = await candidateWorks(c.env, cleaned);
    if (!ok) {
      console.log("[capture] RECHAZADO: la sesión actual sirve y la candidata no");
      return c.json(
        {
          error: "rejected_stale_session",
          detail:
            "La sesión actual funciona y la que enviaste no. No se reemplazó. " +
            "Si es la extensión del navegador: vuelve a loguearte en Bukeala o apaga el envío automático.",
        },
        409,
      );
    }
  }

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
