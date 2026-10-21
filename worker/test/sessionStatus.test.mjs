import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/sessionStatus.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
}).outputFiles[0].text;
const { formatSessionStatus, probeSessionStatus, readRenewalCounts } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
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
  for (const response of rejected) {
    assert.equal((await probeSessionStatus(async () => response)).alive, false);
  }
  const valid = await probeSessionStatus(async () => Response.json([{ id: 1, code: "ABC", description: "Specialty" }]));
  assert.equal(valid.alive, true);
  assert.match(valid.note, /autenticado comprobado/);
  const network = await probeSessionStatus(async () => { throw new Error("synthetic network failure"); });
  assert.equal(network.alive, false);
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
