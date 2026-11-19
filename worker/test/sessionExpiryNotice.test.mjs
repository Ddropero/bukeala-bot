import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Módulo real; Telegram y WhatsApp (graph.facebook.com) interceptados: estas
// pruebas no pueden escribirle a nadie.
const bundle = (await build({
  entryPoints: [fileURLToPath(new URL("../src/cron/sessionExpiryNotice.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
})).outputFiles[0].text;
const m = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);

const MIN = 60000;
const T = (iso) => Date.parse(iso);
const LOGIN = T("2026-11-19T16:50:00Z"); // 11:50 a. m. Bogotá
const cookies = (tgc) => [{ name: "JSESSIONID", value: "j" }, { name: "TGC", value: tgc }];
const iso = (ms) => new Date(ms).toISOString();

function fixture(t, { whatsapp = true } = {}) {
  const data = new Map([["users:list", JSON.stringify([{ chatId: "101", role: "doctor", name: "Dr" }])]]);
  const sent = [];
  const env = {
    ALLOWED_CHAT_ID: "101", TELEGRAM_BOT_TOKEN: "synthetic", WA_TOKEN: "synthetic", WA_PHONE_ID: "1",
    ...(whatsapp ? { DOCTOR_WHATSAPP_NUMBER: "573000000000" } : {}),
    STATE: {
      async get(k) { return data.get(k) ?? null; },
      async put(k, v) { data.set(k, v); },
      async delete(k) { data.delete(k); },
      async list() { return { keys: [], list_complete: true }; },
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    sent.push({ channel: u.includes("telegram") ? "tg" : u.includes("facebook") ? "wa" : "otro", body: JSON.parse(init?.body ?? "{}") });
    return Response.json({ ok: true, messages: [{ id: "x" }] });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  // El login vigente (el más reciente) y la lista completa.
  const logins = () => JSON.parse(data.get("session:loginWatch") ?? '{"logins":[]}').logins;
  const watch = () => logins().reduce((best, w) => (!best || w.loginAt > best.loginAt ? w : best), null);
  return { env, data, sent, watch, logins };
}
const alive = (env, tgc, at) => m.recordAliveSession(env, { cookies: cookies(tgc), capturedAt: iso(at) }, at);
const dead = (env, tgc, at) => m.recordSessionDeath(env, { cookies: cookies(tgc) }, at);
/** Texto que recibe WhatsApp: parámetros de la plantilla recordatorio_personal. */
const waParams = (msg) => msg.body.template.components[0].parameters.map((p) => p.text);

test("vida estimada: conservadora; una caída a mitad de vida no cuenta", () => {
  assert.equal(m.estimateLifeMin([]), 316);
  assert.equal(m.estimateLifeMin([358]), 316);
  assert.equal(m.estimateLifeMin([300]), 300);
  assert.equal(m.estimateLifeMin([150]), 316); // caída, no vencimiento
  assert.equal(m.estimateLifeMin([358, 360, 355]), 355);
  assert.equal(m.estimateLifeMin([358, 150, 360, 355]), 355);
  assert.equal(m.estimateLifeMin([5, 9999, NaN]), 316);
});

test("decisión: nada antes de tiempo, pre 30 min antes, overdue después, una sola vez", () => {
  const w = { fp: "a", loginAt: LOGIN, exact: true };
  assert.equal(m.decideExpiryNotice(null, 316, LOGIN), null);
  assert.equal(m.decideExpiryNotice(w, 316, LOGIN + 285 * MIN), null);
  assert.deepEqual(m.decideExpiryNotice(w, 316, LOGIN + 286 * MIN), { kind: "pre", at: LOGIN + 316 * MIN });
  assert.equal(m.decideExpiryNotice(w, 316, LOGIN + 320 * MIN).kind, "overdue");
  assert.equal(m.decideExpiryNotice({ ...w, notifiedAt: 1 }, 316, LOGIN + 300 * MIN), null);
});

test("decisión: muerte cerca del vencimiento se confirma a los 10 min; a mitad de vida, a los 30", () => {
  const tarde = { fp: "a", loginAt: LOGIN, exact: true, diedAt: LOGIN + 300 * MIN };
  assert.equal(m.decideExpiryNotice(tarde, 316, tarde.diedAt + 9 * MIN), null);
  assert.deepEqual(m.decideExpiryNotice(tarde, 316, tarde.diedAt + 10 * MIN), { kind: "dead", at: tarde.diedAt });
  const temprano = { fp: "a", loginAt: LOGIN, exact: true, diedAt: LOGIN + 150 * MIN };
  assert.equal(m.decideExpiryNotice(temprano, 316, temprano.diedAt + 29 * MIN), null);
  assert.equal(m.decideExpiryNotice(temprano, 316, temprano.diedAt + 30 * MIN).kind, "dead");
});

test("decisión: de noche no se avisa nada; a las 6 a. m. sale lo pendiente", () => {
  const noche = { fp: "a", loginAt: T("2026-11-19T22:00:00Z"), exact: true }; // login 5 p. m.
  assert.equal(m.decideExpiryNotice(noche, 316, noche.loginAt + 290 * MIN), null); // 9:50 p. m.
  assert.equal(m.decideExpiryNotice(noche, 316, T("2026-11-20T10:59:00Z")), null);
  assert.equal(m.decideExpiryNotice(noche, 316, T("2026-11-20T11:00:00Z")).kind, "overdue"); // 6 a. m.
});

test("texto de 'venció': hoy / esta madrugada / anoche / ayer según el día de Bogotá", () => {
  const titulo = (at, now) => m.noticeText({ kind: "dead", at: T(at) }, T(now)).titulo;
  assert.match(titulo("2026-11-19T20:00:00Z", "2026-11-19T20:30:00Z"), /venció hoy a las 3:00 p\. m\./);
  assert.match(titulo("2026-11-20T01:52:00Z", "2026-11-20T11:00:00Z"), /venció anoche a las 8:52 p\. m\./);
  assert.match(titulo("2026-11-20T03:28:00Z", "2026-11-20T11:00:00Z"), /venció anoche a las 10:28 p\. m\./);
  assert.match(titulo("2026-11-20T08:10:00Z", "2026-11-20T11:00:00Z"), /venció esta madrugada a las 3:10 a\. m\./);
  assert.match(titulo("2026-11-19T19:00:00Z", "2026-11-20T11:00:00Z"), /venció ayer a las 2:00 p\. m\./);
});

test("flujo: login nuevo, aviso previo por Telegram y plantilla de WhatsApp, una sola vez", async (t) => {
  const { env, sent, watch } = fixture(t);
  await alive(env, "viejo", LOGIN - 400 * MIN);
  assert.equal(watch().exact, false); // primer registro: hora de login no fiable
  await m.recordAliveSession(env, { cookies: cookies("nuevo"), capturedAt: iso(LOGIN) }, LOGIN + 2 * MIN);
  assert.equal(watch().loginAt, LOGIN);
  assert.equal(watch().exact, true);
  // La VM republica el mismo TGC con capturedAt nuevo: el reloj NO se reinicia.
  await alive(env, "nuevo", LOGIN + 100 * MIN);
  assert.equal(watch().loginAt, LOGIN);

  assert.equal(await m.sessionExpiryNotice(env, LOGIN + 200 * MIN), null);
  assert.equal(sent.length, 0);
  assert.equal((await m.sessionExpiryNotice(env, LOGIN + 287 * MIN)).kind, "pre");
  assert.deepEqual(sent.map((s) => s.channel), ["tg", "wa"]);
  assert.match(sent[0].body.text, /vence hacia las 5:06 p\. m\./);
  assert.equal(sent[1].body.type, "template"); // nunca texto libre: fuera de 24 h se pierde
  assert.equal(sent[1].body.template.name, "recordatorio_personal");
  assert.match(waParams(sent[1])[0], /vence hacia las 5:06 p\. m\./);
  assert.ok(waParams(sent[1]).every((p) => !/[\n\r\t]/.test(p) && p.length <= 600));
  assert.equal(await m.sessionExpiryNotice(env, LOGIN + 290 * MIN), null);
  assert.equal(sent.length, 2);
  // Login nuevo: se rearma.
  await alive(env, "otro", LOGIN + 300 * MIN);
  assert.equal(watch().notifiedAt, undefined);
});

// Hallazgo de revisión (alto): tras un relogueo anticipado, la VM sigue
// publicando el TGC viejo y la extensión el nuevo; la sesión guardada alterna.
test("flujo: dos logins vivos alternándose NO reinician el reloj del nuevo", async (t) => {
  const { env, data, sent, watch, logins } = fixture(t);
  const A = T("2026-11-19T13:00:00Z"); // 8:00 a. m.
  const B = T("2026-11-19T15:00:00Z"); // 10:00 a. m.
  await alive(env, "previo", A - 60 * MIN);
  await alive(env, "A", A);
  await alive(env, "B", B);
  for (let at = B + 3 * MIN; at < A + 316 * MIN; at += 3 * MIN) {
    await alive(env, (at / (3 * MIN)) % 2 ? "A" : "B", at);
    await m.sessionExpiryNotice(env, at);
  }
  assert.equal(watch().fp, logins().find((w) => w.loginAt === B).fp);
  assert.equal(watch().loginAt, B);
  // Muere A (login viejo): no toca el reloj de B ni genera aviso.
  await dead(env, "A", A + 316 * MIN);
  assert.equal(watch().diedAt, undefined);
  assert.equal(await m.sessionExpiryNotice(env, A + 330 * MIN), null);
  assert.equal(sent.length, 0);
  // El aviso previo de B sale a su hora real: 10:00 + 286 min = 2:46 p. m.
  assert.equal(await m.sessionExpiryNotice(env, B + 285 * MIN), null);
  assert.equal((await m.sessionExpiryNotice(env, B + 286 * MIN)).kind, "pre");
  assert.match(sent[0].body.text, /vence hacia las 3:16 p\. m\./);
  assert.equal(data.get("stats:loginLifetimes"), undefined);
});

test("flujo: vence de noche, silencio; a las 6 a. m. avisa que venció anoche y guarda la vida", async (t) => {
  const { env, data, sent } = fixture(t);
  const login = T("2026-11-19T21:30:00Z"); // 4:30 p. m.
  await alive(env, "a", login - MIN);
  await alive(env, "b", login);
  assert.equal(await m.sessionExpiryNotice(env, login + 290 * MIN), null); // 9:20 p. m.
  const died = login + 358 * MIN; // 10:28 p. m.
  await dead(env, "b", died);
  await dead(env, "b", died + 3 * MIN); // no pisa la primera
  assert.equal(await m.sessionExpiryNotice(env, died + 30 * MIN), null);
  assert.equal(sent.length, 0);
  assert.deepEqual(JSON.parse(data.get("stats:loginLifetimes")), [358]);
  assert.equal((await m.sessionExpiryNotice(env, T("2026-11-20T11:01:00Z"))).kind, "dead");
  assert.match(sent[0].body.text, /venció anoche a las 10:28 p\. m\./);
  assert.equal(await m.sessionExpiryNotice(env, T("2026-11-20T11:04:00Z")), null);
});

// Hallazgos de revisión (medios): caída a mitad de vida que la VM repone con
// el mismo TGC no es un vencimiento: ni "venció" precipitado ni medida falsa.
test("flujo: caída a mitad de vida que revive con el mismo TGC; sin aviso falso ni medida", async (t) => {
  const { env, data, sent, watch } = fixture(t);
  await alive(env, "a", LOGIN - MIN);
  await alive(env, "b", LOGIN);
  await dead(env, "b", LOGIN + 150 * MIN);
  assert.equal(await m.sessionExpiryNotice(env, LOGIN + 165 * MIN), null); // 15 min caída: aún no
  await alive(env, "b", LOGIN + 168 * MIN); // la VM la repuso
  assert.equal(watch().diedAt, undefined);
  assert.equal(watch().loginAt, LOGIN);
  assert.equal(sent.length, 0);
  assert.equal((await m.sessionExpiryNotice(env, LOGIN + 290 * MIN)).kind, "pre");

  // Si la caída dura 30+ min sí se avisa, pero no se guarda como vida del login…
  const f2 = fixture(t);
  await alive(f2.env, "a", LOGIN - MIN);
  await alive(f2.env, "b", LOGIN);
  await dead(f2.env, "b", LOGIN + 150 * MIN);
  assert.equal((await m.sessionExpiryNotice(f2.env, LOGIN + 181 * MIN)).kind, "dead");
  assert.equal(f2.data.get("stats:loginLifetimes"), undefined);
  // …y si revive (aun con cookies sin TGC) el aviso previo vuelve a estar disponible.
  await m.recordAliveSession(f2.env, { cookies: [{ name: "JSESSIONID", value: "j" }], capturedAt: iso(LOGIN + 190 * MIN) }, LOGIN + 190 * MIN);
  assert.equal(f2.watch().diedAt, undefined);
  f2.sent.length = 0;
  assert.equal((await m.sessionExpiryNotice(f2.env, LOGIN + 290 * MIN)).kind, "pre");
  assert.equal(f2.sent.length, 2);
  assert.equal(data.get("stats:loginLifetimes"), undefined);
});

test("flujo: una muerte medida y luego revivida deshace la medida", async (t) => {
  const { env, data } = fixture(t);
  await alive(env, "a", LOGIN - MIN);
  await alive(env, "b", LOGIN);
  await dead(env, "b", LOGIN + 300 * MIN);
  await m.sessionExpiryNotice(env, LOGIN + 331 * MIN);
  assert.deepEqual(JSON.parse(data.get("stats:loginLifetimes")), [300]);
  await alive(env, "b", LOGIN + 335 * MIN);
  assert.deepEqual(JSON.parse(data.get("stats:loginLifetimes")), []);
});

test("sin TGC, sesión de login desconocido o sin número de WhatsApp: no rompe", async (t) => {
  const { env, sent, watch } = fixture(t, { whatsapp: false });
  await m.recordAliveSession(env, { cookies: [{ name: "JSESSIONID", value: "j" }], capturedAt: iso(LOGIN) }, LOGIN);
  assert.equal(watch(), null);
  assert.equal(await m.sessionExpiryNotice(env, LOGIN + 400 * MIN), null);
  await alive(env, "a", LOGIN);
  await dead(env, "nunca-visto", LOGIN + 10 * MIN); // sesión ajena: no mata el login vigente
  assert.equal(watch().diedAt, undefined);
  await m.recordSessionDeath(env, null, LOGIN + 20 * MIN); // sin sesión en KV: sí cuenta para el vigente
  assert.equal(watch().diedAt, LOGIN + 20 * MIN);
  await alive(env, "a", LOGIN + 23 * MIN);
  assert.equal((await m.sessionExpiryNotice(env, LOGIN + 290 * MIN)).kind, "pre");
  assert.deepEqual(sent.map((s) => s.channel), ["tg"]);
});

test("horario de silencio: 9 p. m. a 6 a. m. Bogotá", () => {
  assert.equal(m.isQuietHour(T("2026-11-20T01:59:00Z")), false); // 8:59 p. m.
  assert.equal(m.isQuietHour(T("2026-11-20T02:00:00Z")), true);  // 9:00 p. m.
  assert.equal(m.isQuietHour(T("2026-11-20T10:59:00Z")), true);  // 5:59 a. m.
  assert.equal(m.isQuietHour(T("2026-11-20T11:00:00Z")), false); // 6:00 a. m.
});

test("formato de hora Bogotá", () => {
  assert.equal(m.formatBogotaTime(T("2026-11-19T22:50:00Z")), "5:50 p. m.");
  assert.equal(m.formatBogotaTime(T("2026-11-19T05:05:00Z")), "12:05 a. m.");
  assert.equal(m.formatBogotaTime(T("2026-11-19T17:00:00Z")), "12:00 p. m.");
});

