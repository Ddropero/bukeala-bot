import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const bundle = buildSync({
  // Entrada virtual: exporta también SessionExpiredError del MISMO bundle, para
  // que el instanceof de checkSessionUsable reconozca el error que lanzan las pruebas.
  stdin: {
    contents: 'export * from "./sessionStatus.ts"; export { SessionExpiredError } from "./bukeala.ts";',
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)),
    loader: "ts",
  },
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
}).outputFiles[0].text;
const { formatSessionStatus, probeSessionStatus, readRenewalCounts, checkSessionUsable, todayBogotaDashed, SessionExpiredError } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
const NOW = Date.parse("2026-10-21T01:37:00Z"); // 20:37 in Bogotá on October 20.
function status(overrides = {}) {
  return {
    alive: false,
    pingNote: "sesión rechazada por Bukeala",
    capturedAt: new Date(NOW).toISOString(),
    cookieCount: 24,
    events: [
      { at: "2026-10-21T00:51:00Z", type: "ok", via: "persistent" },
      { at: "2026-10-21T01:24:00Z", type: "error", via: "persistent" },
    ],
    recovery: { pending: true, needsHumanAttention: true, pickedUp: false, nextAttemptAt: Date.parse("2026-10-21T02:24:00Z") },
    isDoctor: true,
    counts: { utcDay: "2026-10-21", reusedSession: 4, fullLogin: 0, legacyCaptcha: 0, errors: 2 },
    pendingWhatsApp: 0,
    pendingTelegram: 0,
    now: NOW,
    ...overrides,
  };
}

test("fresh capture plus rejected session reports the actual failure and human-attention deadline", () => {
  const text = formatSessionStatus(status());
  assert.match(text, /sin acceso confirmado/);
  assert.match(text, /Último éxito de la VM: hace 46 min/);
  assert.match(text, /Última captura recibida: hace 0 min · 24 cookies \(no confirma acceso\)/);
  assert.match(text, /Último intento VM: ❌ falló hace 13 min/);
  assert.match(text, /requiere atención en el navegador de la VM/);
  assert.match(text, /21:24 \(Bogotá\), dentro de 47 min/);
  assert.doesNotMatch(text, /ya la estoy renovando|Última renovación: hace 0|sesion_renew/);
  assert.match(text, /2026-10-21 \(UTC\)/);
});

test("pending, picked-up and missing status never imply completed renewal", () => {
  const pending = formatSessionStatus(status({ recovery: { pending: true, pickedUp: false } }));
  assert.match(pending, /solicitada y pendiente/);
  assert.match(pending, /aún no hay un nuevo intento confirmado/);
  const pickedUp = formatSessionStatus(status({ recovery: { pending: true, pickedUp: true } }));
  assert.match(pickedUp, /recogió la solicitud; el resultado sigue pendiente/);
  const missing = formatSessionStatus(status({ recovery: null, events: [], capturedAt: undefined }));
  assert.match(missing, /No pude comprobar el estado/);
  assert.match(missing, /no consta en el registro disponible/);
  assert.match(missing, /Sin captura de sesión guardada/);
});

test("non-doctor sees human action and retry time; healthy API cannot hide a blocked VM", () => {
  const patient = formatSessionStatus(status({ isDoctor: false }));
  assert.match(patient, /requiere atención/);
  assert.match(patient, /21:24/);
  assert.doesNotMatch(patient, /cookies|Detalle técnico|Contadores/);
  const recovered = formatSessionStatus(status({ alive: true }));
  assert.match(recovered, /Bukeala: en línea ✅/);
  assert.match(recovered, /Renovación automática de la VM: requiere atención/);
  assert.match(recovered, /Próximo intento/);
  const resolved = formatSessionStatus(status({ alive: true, recovery: { pending: false } }));
  assert.doesNotMatch(resolved, /requiere atención|Próximo intento/);
});

test("HTTP 200 with login HTML, error JSON or empty components does not report online", async () => {
  const rejected = [
    new Response("<html>Login</html>", { headers: { "content-type": "text/html" } }),
    Response.json({ error: "unauthorized" }),
    Response.json([]),
    Response.json([{ id: 1, code: "ABC", description: "Specialty" }], { status: 503 }),
  ];
  // La agenda tampoco confirma (302 al login): el [] debe seguir siendo "no viva".
  const deadAgenda = async () => new Response(null, { status: 302, headers: { location: "/cas/login" } });
  for (const response of rejected) {
    assert.equal((await probeSessionStatus(async () => response, deadAgenda)).alive, false);
  }
  const valid = await probeSessionStatus(async () => Response.json([{ id: 1, code: "ABC", description: "Specialty" }]), deadAgenda);
  assert.equal(valid.alive, true);
  assert.match(valid.note, /autenticado comprobado/);
  const network = await probeSessionStatus(async () => { throw new Error("synthetic network failure"); }, deadAgenda);
  assert.equal(network.alive, false);
});

// 17-nov-2026: con la sesión VIVA, loadComponents devolvió [] (sin paciente
// seleccionado). La regla única confirma ese [] con la agenda del día.
const COMPONENTS_OK = () => Response.json([{ id: 1, code: "ABC", description: "Specialty" }]);
const EMPTY = () => Response.json([]);
const AGENDA_OK = () => Response.json({ areas: [{ bookings: [] }], defaultDateFormatted: "17/11/2026" });

test("checkSessionUsable: [] + agenda viva => viva", async () => {
  const r = await checkSessionUsable(async () => EMPTY(), async () => AGENDA_OK());
  assert.equal(r.alive, true);
  assert.match(r.note, /agenda/);
  assert.equal((await probeSessionStatus(async () => EMPTY(), async () => AGENDA_OK())).alive, true);
});

test("checkSessionUsable: [] + agenda 302, HTML, JSON sin areas, 401/403 o SessionExpired => no viva", async () => {
  const agendas = [
    () => new Response(null, { status: 302, headers: { location: "/cas/login" } }),
    () => new Response("<html>Login</html>", { status: 200, headers: { "content-type": "text/html" } }),
    () => Response.json({ error: "unauthorized" }),
    () => Response.json({ areas: "no-array" }),
    () => Response.json({ areas: [] }, { status: 401 }),
    () => Response.json({ areas: [] }, { status: 403 }),
  ];
  for (const agenda of agendas) {
    assert.equal((await checkSessionUsable(async () => EMPTY(), async () => agenda())).alive, false);
  }
  const expired = await checkSessionUsable(async () => EMPTY(), async () => { throw new SessionExpiredError(); });
  assert.equal(expired.alive, false);
  assert.ok(expired.error instanceof SessionExpiredError);
});

test("checkSessionUsable: lista no vacía => viva sin pedir la agenda", async () => {
  let agendaCalls = 0;
  const r = await checkSessionUsable(async () => COMPONENTS_OK(), async () => { agendaCalls++; return AGENDA_OK(); });
  assert.equal(r.alive, true);
  assert.equal(agendaCalls, 0);
});

test("checkSessionUsable: 302/HTML/JSON no-array en loadComponents => no viva y no consulta la agenda", async () => {
  let agendaCalls = 0;
  const loadAgenda = async () => { agendaCalls++; return AGENDA_OK(); };
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: "/cas/login" } }),
    () => new Response("<html>Login</html>", { headers: { "content-type": "text/html" } }),
    () => Response.json({ error: "unauthorized" }),
    () => Response.json([], { status: 401 }),
    () => Response.json([], { status: 403 }),
  ]) {
    assert.equal((await checkSessionUsable(async () => response(), loadAgenda)).alive, false);
  }
  // Bukeala.req convierte el 302 en SessionExpiredError: también "no viva".
  const thrown = await checkSessionUsable(async () => { throw new SessionExpiredError(); }, loadAgenda);
  assert.equal(thrown.alive, false);
  assert.match(thrown.note, /rechazada/);
  assert.equal(agendaCalls, 0);
});

// Hallazgo de revisión (17-nov-2026): un 5xx o un error de red no es un
// veredicto. Debe marcarse inconclusive para que /debug/session-check responda
// 503 (ambiguo en la VM, con reintento) y no 200 {alive:false} ("malo").
test("checkSessionUsable: 5xx en componentes o agenda, o error de red => no viva e inconclusive", async () => {
  for (const status of [500, 502, 503]) {
    const comp = await checkSessionUsable(async () => new Response("err", { status }), async () => AGENDA_OK());
    assert.equal(comp.alive, false);
    assert.equal(comp.inconclusive, true);
    const agenda = await checkSessionUsable(async () => EMPTY(), async () => new Response("err", { status }));
    assert.equal(agenda.alive, false);
    assert.equal(agenda.inconclusive, true);
  }
  const net = await checkSessionUsable(async () => { throw new Error("synthetic proxy failure"); }, async () => AGENDA_OK());
  assert.equal(net.alive, false);
  assert.equal(net.inconclusive, true);
  const netAgenda = await checkSessionUsable(async () => EMPTY(), async () => { throw new TypeError("fetch failed"); });
  assert.equal(netAgenda.alive, false);
  assert.equal(netAgenda.inconclusive, true);
});

test("checkSessionUsable: los rechazos reales NO son inconclusive (protección 29-jul)", async () => {
  const rejections = [
    [() => new Response(null, { status: 302, headers: { location: "/cas/login" } }), AGENDA_OK],
    [() => new Response("<html>Login</html>", { headers: { "content-type": "text/html" } }), AGENDA_OK],
    [() => Response.json({ error: "unauthorized" }), AGENDA_OK],
    [() => Response.json([], { status: 401 }), AGENDA_OK],
    [() => Response.json([], { status: 403 }), AGENDA_OK],
    [EMPTY, () => new Response(null, { status: 302, headers: { location: "/cas/login" } })],
    [EMPTY, () => new Response("<html>Login</html>", { status: 200, headers: { "content-type": "text/html" } })],
    [EMPTY, () => Response.json({ areas: "no-array" })],
  ];
  for (const [components, agenda] of rejections) {
    const r = await checkSessionUsable(async () => components(), async () => agenda());
    assert.equal(r.alive, false);
    assert.notEqual(r.inconclusive, true);
  }
  const expired = await checkSessionUsable(async () => { throw new SessionExpiredError(); }, async () => AGENDA_OK());
  assert.equal(expired.alive, false);
  assert.notEqual(expired.inconclusive, true);
});

test("todayBogotaDashed usa UTC-5 (las 03:00 UTC aún son el día anterior en Bogotá)", () => {
  assert.equal(todayBogotaDashed(Date.parse("2026-11-17T03:00:00Z")), "16-11-2026");
  assert.equal(todayBogotaDashed(Date.parse("2026-11-17T16:36:00Z")), "17-11-2026");
});

test("counts include all persistent renewal paths and identify the actual UTC day", async () => {
  const data = new Map([
    ["stats:renew:2026-10-21:ok:alive", "2"],
    ["stats:renew:2026-10-21:ok:tgc", "3"],
    ["stats:renew:2026-10-21:ok:persistent", "41"],
    ["stats:renew:2026-10-21:ok:persistent-login", "1"],
    ["stats:renew:2026-10-21:ok:persistent-adopted", "4"],
    ["stats:renew:2026-10-21:ok:captcha", "5"],
    ["stats:renew:2026-10-21:ok:captcha-fallback", "6"],
    ["stats:renew:2026-10-21:error", "2"],
    ["stats:renew:2026-10-20:ok:persistent", "999"],
  ]);
  const counts = await readRenewalCounts({ STATE: { get: async (key) => data.get(key) ?? null } }, NOW);
  assert.deepEqual(counts, { utcDay: "2026-10-21", reusedSession: 50, fullLogin: 1, legacyCaptcha: 11, errors: 2 });
});
