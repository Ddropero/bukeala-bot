import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Empaqueta el comando real y sustituye SOLO el cliente de Bukeala por un doble
// que registra cada createSchedule. Ningún test toca el portal.
const bundle = (await build({
  entryPoints: [fileURLToPath(new URL("../src/commands/abrirAgenda.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
  plugins: [{ name: "stub-bukeala", setup(b) {
    b.onResolve({ filter: /^\.\.\/bukeala$/ }, () => ({ path: "bukeala", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", contents: `
      export class SessionExpiredError extends Error {}
      export class Bukeala {
        constructor(env) { this.env = env; }
        async createSchedule(args) {
          globalThis.__calls.push(args);
          return new Response(JSON.stringify({ result: { code: "SUCCESS" } }));
        }
      }` }));
  } }],
})).outputFiles[0].text;
const { handleAbrirAgenda, parseFechaUsuario } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);

// 10:00 Bogotá del martes 20/10/2026 (el reloj de la reproducción del ESTADO).
const NOW = new Date("2026-10-20T15:00:00Z");
const env = { BRANCH_ID: "456" };
async function correr(args) {
  globalThis.__calls = [];
  const r = await handleAbrirAgenda(env, args, { now: NOW });
  return { r, calls: globalThis.__calls };
}
const rangos = (calls) => calls.map((c) => `${c.startDate}→${c.endDate}`);

test("REPRODUCCIÓN: «jueves 8:00-12:00 22-10-2026» abre SOLO el 22/10, no dos semanas", async () => {
  const { r, calls } = await correr("jueves 8:00-12:00 22-10-2026");
  assert.deepEqual(rangos(calls), ["22/10/2026→22/10/2026", "22/10/2026→22/10/2026"]); // ambos perfiles
  assert.match(r.reply, /Agenda abierta/);
  assert.match(r.reply, /Jueves 22\/10\/2026/);
});

test("fecha que no es fecha, mes 13, 31 de febrero o año corto → se rechaza y NO se crea nada", async () => {
  for (const [arg, motivo] of [
    ["mañana", /no es una fecha/],
    ["22/13/2026", /no existe en el calendario/],
    ["31/02/2026", /no existe en el calendario/],
    ["22/10/26", /año completo/],
    ["2026-10-22", /no es una fecha/],
  ]) {
    const { r, calls } = await correr(`jueves 8:00-12:00 ${arg}`);
    assert.equal(calls.length, 0, `${arg} no debe crear nada`);
    assert.match(r.reply, motivo, arg);
    assert.match(r.reply, /No abrí nada/, arg);
  }
});

test("separadores y un dígito se normalizan: 5/11/2026, 05.11.2026 y 05-11-2026 → 05/11/2026", async () => {
  for (const arg of ["5/11/2026", "05.11.2026", "05-11-2026"]) {
    const { calls } = await correr(`jueves 8:00-12:00 ${arg}`);
    assert.deepEqual(rangos(calls), ["05/11/2026→05/11/2026", "05/11/2026→05/11/2026"], arg);
  }
});

test("una fecha pasada o que no cae en ese día de la semana → no se crea nada", async () => {
  let x = await correr("jueves 8:00-12:00 15/10/2026");
  assert.equal(x.calls.length, 0);
  assert.match(x.r.reply, /ya pasó/);
  x = await correr("jueves 8:00-12:00 23/10/2026"); // viernes
  assert.equal(x.calls.length, 0);
  assert.match(x.r.reply, /no es jueves/);
  x = await correr("martes 8:00-12:00 20/10/2026"); // hoy sí se permite
  assert.equal(x.calls.length, 2);
});

test("rango: fin antes del inicio, inicio pasado, sin ese día de la semana o de más de un año → no se crea nada", async () => {
  for (const [arg, motivo] of [
    ["jueves 8:00-12:00 05/11/2026 22/10/2026", /anterior a la inicial/],
    ["jueves 8:00-12:00 08/10/2026 05/11/2026", /ya pasó/],
    ["lunes 8:00-12:00 21/10/2026 23/10/2026", /no hay ningún lunes/],
    ["jueves 8:00-12:00 22/10/2026 22/10/2028", /máximo es 366/],
    ["jueves 8:00-12:00 22/10/2026 31/02/2027", /no existe en el calendario/],
  ]) {
    const { r, calls } = await correr(arg);
    assert.equal(calls.length, 0, arg);
    assert.match(r.reply, motivo, arg);
  }
});

test("rango válido se pasa normalizado a Bukeala", async () => {
  const { r, calls } = await correr("jueves 8:00-12:00 22-10-2026 5/11/2026");
  assert.deepEqual(rangos(calls), ["22/10/2026→05/11/2026", "22/10/2026→05/11/2026"]);
  assert.match(r.reply, /📅 Jueves ·/);           // plural sin "s" doble
  assert.doesNotMatch(r.reply, /Juevess|Miércoless/);
});

test("texto de más después de las fechas → se rechaza (antes se ignoraba)", async () => {
  const { r, calls } = await correr("jueves 8:00-12:00 22/10/2026 05/11/2026 basura");
  assert.equal(calls.length, 0);
  assert.match(r.reply, /Sobra texto.*basura/);
});

test("sin fechas sigue abriendo las próximas 2 semanas, y el perfil opcional sigue funcionando", async () => {
  let x = await correr("jueves 8:00-12:00");
  assert.deepEqual(rangos(x.calls), ["20/10/2026→03/11/2026", "20/10/2026→03/11/2026"]);
  x = await correr("adultos jueves 8:00-12:00 22/10/2026");
  assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].componentCode, "890239");
});

test("plural de los días en el resumen: Sábados, Miércoles (no «Miércoless»)", async () => {
  let x = await correr("sabado 8:00-12:00 24/10/2026 07/11/2026");
  assert.match(x.r.reply, /📅 Sábados ·/);
  x = await correr("miércoles 8:00-12:00 21/10/2026 04/11/2026");
  assert.match(x.r.reply, /📅 Miércoles ·/);
  assert.doesNotMatch(x.r.reply, /Miércoless/);
});

test("parseFechaUsuario devuelve la fecha normalizada o un motivo", () => {
  assert.deepEqual({ ...parseFechaUsuario("1/2/2027"), utc: undefined }, { ok: true, fecha: "01/02/2027", utc: undefined });
  assert.equal(parseFechaUsuario("29/02/2028").ok, true);  // bisiesto
  assert.equal(parseFechaUsuario("29/02/2027").ok, false);
  assert.equal(parseFechaUsuario("").ok, false);
});
