import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Empaqueta el comando real y sustituye SOLO las tres puertas de salida
// (Bukeala, WhatsApp, directorio de contactos) por stubs controlados desde
// `globalThis.__fake`. Así ningún test puede tocar Bukeala ni Meta.
const bundle = (await build({
  entryPoints: [fileURLToPath(new URL("../src/commands/cancelarAgenda.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
  plugins: [{ name: "stub-io", setup(b) {
    b.onResolve({ filter: /^\.\.\/(bukeala|whatsapp|pacientesContacto)$/ }, (a) => ({ path: a.path.replace("../", ""), namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => {
      const stubs = {
        bukeala: `
          export class SessionExpiredError extends Error { constructor() { super("Bukeala session expired or missing"); this.name = "SessionExpiredError"; } }
          globalThis.__StubSessionExpiredError = SessionExpiredError; // misma clase que ve el comando (instanceof)
          export class Bukeala {
            constructor(env) { this.env = env; }
            selectBookingComponent(id) { return globalThis.__fake.selectBookingComponent(id); }
            getAgenda(d, area, inc) { return globalThis.__fake.getAgenda(d, area, inc); }
            cancelBooking(args) { return globalThis.__fake.cancelBooking(args); }
            deleteBookingCalendar(ids) { return globalThis.__fake.deleteBookingCalendar(ids); }
          }`,
        whatsapp: `export async function sendText(env, to, body) { return globalThis.__fake.sendText(env, to, body); }`,
        pacientesContacto: `export async function getContacto(env, cedula) { return globalThis.__fake.getContacto(env, cedula); }`,
      };
      return { contents: stubs[a.path], loader: "js" };
    });
  } }],
})).outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
const {
  handleCancelarAgenda, perteneceAlCalendario, evaluarPertenencia, filtrarCitasDelCalendario,
  horaInicioSegundos, leerHoraInicio, evaluarRespuestaBukeala, debeBorrarCalendario, nuevoResultado, resumirResultado,
  enumerateDays, leerDiasSemana, ventanaValida, clasificarEstado, calendarioCubreDia, hermanosDelDia,
  planificarDias, hoyBogota,
} = mod;

// --- Fixtures (todo ficticio: nombres, cédulas, teléfonos, códigos) ---------
const NINOS = { componentCode: "890239-1", startSec: 8 * 3600, endSec: 12 * 3600 };   // 08:00-12:00
const ADULTOS = { componentCode: "890239", startSec: 14 * 3600, endSec: 17 * 3600 }; // 14:00-17:00

function cita(over = {}) {
  return {
    id: 1, name: "Paciente Prueba", identification: "FICT-0001", isCanceled: false, isBusyTime: false, stateCode: "PENDING",
    bookingComponentCode: "890239-1", startHourFormatted: "08:20 AM", reservationCode: "RC-FICT-1",
    ...over,
  };
}

function calInfo(over = {}) {
  return {
    id: 500, desc: "", startFmt: "20/10/26", endFmt: "20/10/26", startSec: NINOS.startSec, endSec: NINOS.endSec,
    state: "Activa", profile: "Niños/adolescentes", profileId: "1222", componentCode: "890239-1", dias: null,
    ...over,
  };
}

// --- (1) y (2): perfil + ventana ------------------------------------------
test("una cita de adultos por la tarde NO pertenece a un calendario de niños de la mañana", () => {
  const adultoTarde = cita({ bookingComponentCode: "890239", startHourFormatted: "03:00 PM", startHours: 15, startMinutes: 0 });
  assert.equal(perteneceAlCalendario(adultoTarde, NINOS), false);
  // y tampoco es "no evaluable": es simplemente otro perfil
  assert.deepEqual(evaluarPertenencia(adultoTarde, NINOS), { pertenece: false });
  // perfil correcto pero fuera de la ventana: tampoco
  const ninoTarde = cita({ startHourFormatted: "03:00 PM" });
  assert.equal(perteneceAlCalendario(ninoTarde, NINOS), false);
  // ventana correcta pero perfil de adultos: tampoco (prefijo "890239" ≠ "890239-1")
  const adultoManana = cita({ bookingComponentCode: "890239", startHourFormatted: "09:00 AM" });
  assert.equal(perteneceAlCalendario(adultoManana, NINOS), false);
});

test("una cita del perfil y hora correctos SÍ pertenece (con startHours o con startHourFormatted)", () => {
  assert.equal(perteneceAlCalendario(cita({ startHours: 8, startMinutes: 20 }), NINOS), true);
  assert.equal(perteneceAlCalendario(cita({ startHourFormatted: "08:20 AM" }), NINOS), true);
  assert.equal(perteneceAlCalendario(cita({ startHourFormatted: "11:40 a.m." }), NINOS), true);
  assert.equal(perteneceAlCalendario(cita({ bookingComponentCode: "890239", startHourFormatted: "02:00 PM" }), ADULTOS), true);
  // el código de niños NO cae en el calendario de adultos aunque "890239" sea su prefijo
  assert.equal(perteneceAlCalendario(cita({ bookingComponentCode: "890239-1", startHourFormatted: "02:00 PM" }), ADULTOS), false);
});

// --- (3): tercer perfil ----------------------------------------------------
test("código de perfil desconocido (890239-2) no pertenece a ninguno y no cuenta como error", () => {
  const otro = cita({ bookingComponentCode: "890239-2", startHourFormatted: "09:00 AM" });
  assert.deepEqual(evaluarPertenencia(otro, NINOS), { pertenece: false });
  assert.deepEqual(evaluarPertenencia({ ...otro, startHourFormatted: "03:00 PM" }, ADULTOS), { pertenece: false });
});

test("sin código de perfil o sin hora legible → no pertenece y se marca noEvaluable", () => {
  const sinCodigo = evaluarPertenencia(cita({ bookingComponentCode: undefined }), NINOS);
  assert.equal(sinCodigo.pertenece, false);
  assert.match(sinCodigo.noEvaluable, /código de perfil/);
  const sinHora = evaluarPertenencia(cita({ startHourFormatted: "mañana" }), NINOS);
  assert.equal(sinHora.pertenece, false);
  assert.match(sinHora.noEvaluable, /hora/);
  // el nombre del componente NO sustituye al código
  assert.equal(evaluarPertenencia(cita({ bookingComponentCode: "", bookingComponentName: "CIRUGIA PLASTICA NIÑOS" }), NINOS).pertenece, false);
});

// --- (4): bordes de la ventana horaria -------------------------------------
test("ventana horaria inclusiva en ambos extremos (inicio y fin incluidos)", () => {
  assert.equal(perteneceAlCalendario(cita({ startHourFormatted: "08:00 AM" }), NINOS), true);   // == startSec
  assert.equal(perteneceAlCalendario(cita({ startHourFormatted: "07:59 AM" }), NINOS), false);  // 1 min antes
  assert.equal(perteneceAlCalendario(cita({ startHourFormatted: "12:00 PM" }), NINOS), true);   // == endSec (inclusivo, documentado)
  assert.equal(perteneceAlCalendario(cita({ startHourFormatted: "12:01 PM" }), NINOS), false);  // 1 min después
  assert.equal(perteneceAlCalendario(cita({ startHourFormatted: "12:20 PM" }), NINOS), false);
  // mismos bordes con la fuente numérica sola
  assert.equal(perteneceAlCalendario(cita({ startHourFormatted: undefined, startHours: 8, startMinutes: 0 }), NINOS), true);
  assert.equal(perteneceAlCalendario(cita({ startHourFormatted: undefined, startHours: 12, startMinutes: 1 }), NINOS), false);
});

test("horaInicioSegundos: 12 h, 24 h, 12:xx AM/PM, y valores ilegibles", () => {
  assert.equal(horaInicioSegundos({ startHourFormatted: "12:00 AM" }), 0);
  assert.equal(horaInicioSegundos({ startHourFormatted: "12:30 PM" }), 12 * 3600 + 30 * 60);
  assert.equal(horaInicioSegundos({ startHourFormatted: "08:20" }), 8 * 3600 + 20 * 60);
  assert.equal(horaInicioSegundos({ startHours: "9", startMinutes: "5" }), 9 * 3600 + 5 * 60);
  assert.equal(horaInicioSegundos({ startHours: null, startMinutes: null, startHourFormatted: "" }), null);
  assert.equal(horaInicioSegundos({ startHours: 25, startMinutes: 0 }), null);
  assert.equal(horaInicioSegundos({}), null);
});

// --- hallazgo: startHours vs startHourFormatted se cruzan, no se prefiere la numérica
test("leerHoraInicio cruza las dos fuentes: si existen ambas y no coinciden → null con motivo (noEvaluable)", () => {
  assert.equal(horaInicioSegundos({ startHours: 15, startMinutes: 0, startHourFormatted: "03:00 PM" }), 15 * 3600);
  // startHours en base 12 (3 para "03:00 PM") NO se acepta en silencio
  const contradictoria = leerHoraInicio({ startHours: 3, startMinutes: 0, startHourFormatted: "03:00 PM" });
  assert.equal(contradictoria.seg, null);
  assert.match(contradictoria.motivo, /no coincide/);
  // con una sola fuente se usa esa
  assert.equal(horaInicioSegundos({ startHourFormatted: "03:00 PM" }), 15 * 3600);
  assert.equal(horaInicioSegundos({ startHours: 15, startMinutes: 0 }), 15 * 3600);
  // y en evaluarPertenencia la contradicción bloquea (noEvaluable), no excluye en silencio
  const p = evaluarPertenencia(cita({ bookingComponentCode: "890239", startHours: 3, startMinutes: 0, startHourFormatted: "03:00 PM" }), ADULTOS);
  assert.equal(p.pertenece, false);
  assert.match(p.noEvaluable, /no coincide/);
});

// --- hallazgo: estados no cancelables y estados desconocidos -----------------
test("clasificarEstado: solo PENDING*/CONFIRMED/OVER_BOOKING se cancelan; atendidas/en curso se descartan; raros → desconocido", () => {
  for (const st of ["PENDING", "PENDING_CONFIRMATION", "PENDING_DATA", "PENDING_PAYMENT", "CONFIRMED", "OVER_BOOKING"]) {
    assert.equal(clasificarEstado(cita({ stateCode: st })), "cancelable", st);
  }
  for (const st of ["CANCELED", "ENDED", "NOT_ASSISTED", "ADMITTED", "STARTED", "PAUSE"]) {
    assert.equal(clasificarEstado(cita({ stateCode: st })), "descartar", st);
  }
  assert.equal(clasificarEstado(cita({ isCanceled: true })), "descartar");
  assert.equal(clasificarEstado(cita({ isBusyTime: true })), "descartar");
  assert.equal(clasificarEstado(cita({ stateCode: "FOO" })), "desconocido");
  assert.equal(clasificarEstado(cita({ stateCode: undefined })), "desconocido");
});

test("filtrarCitasDelCalendario separa propias, no evaluables y descarta canceladas/bloqueos/atendidas y otras agendas", () => {
  const dia = [
    cita({ id: 1, name: "Nino Uno" }),                                                      // propia
    cita({ id: 2, name: "Nino Cancelado", isCanceled: true }),                              // descartada
    cita({ id: 3, name: "Bloqueo", isBusyTime: true }),                                      // descartada
    cita({ id: 4, name: "Adulto Tarde", bookingComponentCode: "890239", startHourFormatted: "03:00 PM" }), // otra agenda
    cita({ id: 5, name: "Sin Codigo", bookingComponentCode: null }),                        // noEvaluable
    cita({ id: 6, name: "Nino Dos", startHourFormatted: "11:00 AM" }),                      // propia
    cita({ id: 7, name: "Nino Atendido", stateCode: "ENDED", startHourFormatted: "09:00 AM" }),        // descartada
    cita({ id: 8, name: "Nino No Asistio", stateCode: "NOT_ASSISTED", startHourFormatted: "09:20 AM" }), // descartada
    cita({ id: 9, name: "Nino Raro", stateCode: "FOO", startHourFormatted: "09:40 AM" }),   // noEvaluable (estado)
    cita({ id: 10, name: "Adulto Raro", stateCode: "FOO", bookingComponentCode: "890239", startHourFormatted: "03:00 PM" }), // otra agenda: no molesta
  ];
  const { propias, noEvaluables } = filtrarCitasDelCalendario(dia, NINOS);
  assert.deepEqual(propias.map((b) => b.id), [1, 6]);
  assert.deepEqual(noEvaluables.map((n) => n.bk.id), [5, 9]);
  assert.match(noEvaluables[1].motivo, /estado "FOO" no reconocido/);
});

test("filtrarCitasDelCalendario con despuesDe (hoy): las citas que ya empezaron no se tocan", () => {
  const dia = [cita({ id: 1, startHourFormatted: "08:20 AM" }), cita({ id: 2, startHourFormatted: "09:00 AM" }), cita({ id: 3, startHourFormatted: "11:00 AM" })];
  const { propias } = filtrarCitasDelCalendario(dia, NINOS, { despuesDe: 9 * 3600 });
  assert.deepEqual(propias.map((b) => b.id), [3]); // 08:20 y 09:00 (== ahora) ya empezaron
});

// --- hallazgo: agendas hermanas ---------------------------------------------
test("evaluarPertenencia con hermanas: una cita que también cabe en otra agenda del mismo perfil es noEvaluable", () => {
  const hermanaContigua = { id: 502, etiqueta: "Niños 12:00-16:00", startSec: 12 * 3600, endSec: 16 * 3600 };
  const p12 = evaluarPertenencia(cita({ startHourFormatted: "12:00 PM" }), NINOS, [hermanaContigua]);
  assert.equal(p12.pertenece, false);
  assert.match(p12.noEvaluable, /también cabe en la agenda 502/);
  // la de las 09:00 sigue siendo propia: no cae en la hermana
  assert.deepEqual(evaluarPertenencia(cita({ startHourFormatted: "09:00 AM" }), NINOS, [hermanaContigua]), { pertenece: true });
  // hermana sin ventana legible = solape total
  const hermanaRota = { id: 503, etiqueta: "Niños ??", startSec: null, endSec: null };
  assert.match(evaluarPertenencia(cita({ startHourFormatted: "09:00 AM" }), NINOS, [hermanaRota]).noEvaluable, /503/);
});

test("ventanaValida: exige ambos extremos numéricos, max > 0 y min <= max", () => {
  assert.equal(ventanaValida({ startSec: 28800, endSec: 43200 }), true);
  assert.equal(ventanaValida({ startSec: 28800, endSec: 28800 }), true);
  assert.equal(ventanaValida({ startSec: 28800, endSec: null }), false);
  assert.equal(ventanaValida({ startSec: null, endSec: 43200 }), false);
  assert.equal(ventanaValida({ startSec: 0, endSec: 0 }), false);
  assert.equal(ventanaValida({ startSec: 43200, endSec: 28800 }), false);
  assert.equal(ventanaValida({ startSec: 28800, endSec: 90000 }), false);
  // y con ventana inválida NINGUNA cita se atribuye en silencio a "otra agenda"
  const p = evaluarPertenencia(cita(), { componentCode: "890239-1", startSec: 28800, endSec: null });
  assert.equal(p.pertenece, false);
  assert.match(p.noEvaluable, /ventana horaria/);
});

test("leerDiasSemana: dayOfWeeks es el campo REAL de selectBookingComponent (verificado 25-oct-2026: miércoles = [4])", () => {
  assert.deepEqual(leerDiasSemana({ dayOfWeeks: [4] }), [4]);
  assert.deepEqual(leerDiasSemana({ dayOfWeeks: [2, 5] }), [2, 5]);
  assert.deepEqual(leerDiasSemana({ dayOfWeeks: [] }), null);
  assert.deepEqual(leerDiasSemana({ dayOfWeeks: null }), null);
  // el objeto real trae muchos más campos; ninguno debe contaminar el resultado
  assert.deepEqual(leerDiasSemana({ dayOfWeeks: [4], description: "Jueves 08:00", intervalSeconds: 1200, startDate: 1776567600000 }), [4]);
});

test("leerDiasSemana: números solo en daysSelected* (mapeo Bukeala Dom=1), nombres en español en campos de texto, null si no hay nada", () => {
  assert.deepEqual(leerDiasSemana({ daysSelected: ["5"] }), [5]);
  assert.deepEqual(leerDiasSemana({ daysSelected: [2, 5] }), [2, 5]);
  assert.deepEqual(leerDiasSemana({ daysSelected: "5-2-" }), [2, 5]);
  assert.deepEqual(leerDiasSemana({ daysSelectedStr: "4-" }), [4]);
  assert.deepEqual(leerDiasSemana({ dayDescription: "Jueves" }), [5]);
  assert.deepEqual(leerDiasSemana({ dayOfWeekInLetters: "Miércoles" }), [4]);
  assert.deepEqual(leerDiasSemana({ daysDescription: "Lunes y jueves" }), [2, 5]);
  assert.equal(leerDiasSemana({ dayDescription: "08:00-12:00" }), null); // dígitos en campos de texto se ignoran
  assert.equal(leerDiasSemana({ description: "Jueves 08:00" }), null);   // description NO se interpreta
  assert.equal(leerDiasSemana({ daysSelected: "9" }), null);
  assert.equal(leerDiasSemana({}), null);
  assert.equal(leerDiasSemana(null), null);
});

test("calendarioCubreDia y hermanosDelDia: rango de fechas, día de la semana y solape de ventana", () => {
  const d = (dd, mm, yyyy) => ({ dd, mm, yyyy });
  const base = { startFmt: "22/10/26", endFmt: "05/11/26", dias: null };
  assert.equal(calendarioCubreDia(base, d("26", "10", "2026")), true);
  assert.equal(calendarioCubreDia(base, d("21", "10", "2026")), false);
  assert.equal(calendarioCubreDia(base, d("06", "11", "2026")), false);
  assert.equal(calendarioCubreDia({ ...base, dias: [5] }, d("29", "10", "2026")), true);  // jueves
  assert.equal(calendarioCubreDia({ ...base, dias: [5] }, d("26", "10", "2026")), false); // lunes
  assert.equal(calendarioCubreDia({ ...base, startFmt: "" }, d("26", "10", "2026")), true); // ilegible → conservador

  const cal = calInfo({ id: 500, startFmt: "22/10/26", endFmt: "05/11/26" });
  const todos = [
    cal,
    calInfo({ id: 501, startFmt: "22/10/26", endFmt: "05/11/26" }),                                    // gemela sin weekday
    calInfo({ id: 502, startFmt: "22/10/26", endFmt: "05/11/26", startSec: 14 * 3600, endSec: 17 * 3600 }), // no solapa en hora
    calInfo({ id: 503, startFmt: "22/10/26", endFmt: "05/11/26", dias: [2] }),                         // solo lunes
    calInfo({ id: 504, startFmt: "22/10/26", endFmt: "05/11/26", endSec: null }),                      // ventana rota → solape total
    calInfo({ id: 600, startFmt: "22/10/26", endFmt: "05/11/26", profile: "Adultos", profileId: "1218", componentCode: "890239" }), // otro perfil
    calInfo({ id: 700, startFmt: "01/09/26", endFmt: "30/09/26" }),                                    // vencida
  ];
  assert.deepEqual(hermanosDelDia(cal, todos, d("29", "10", "2026")).map((h) => h.id), [501, 504]);      // jueves
  assert.deepEqual(hermanosDelDia(cal, todos, d("26", "10", "2026")).map((h) => h.id), [501, 503, 504]); // lunes
});

test("planificarDias: recorta los días pasados, respeta el weekday y rechaza fechas ilegibles", () => {
  const hoy = hoyBogota(new Date("2026-10-25T15:00:00Z")); // 10:00 Bogotá, domingo 25/10/26
  assert.equal(hoy.segundos, 10 * 3600);
  const p = planificarDias({ startFmt: "13/10/26", endFmt: "27/10/26", dias: null }, hoy.medianoche);
  assert.equal(p.ok, true);
  assert.deepEqual(p.dias.map((x) => x.dd), ["25", "26", "27"]);
  assert.equal(p.pasados, 12);
  const j = planificarDias({ startFmt: "22/10/26", endFmt: "05/11/26", dias: [5] }, hoyBogota(new Date("2026-10-22T11:00:00Z")).medianoche);
  assert.deepEqual(j.dias.map((x) => `${x.dd}/${x.mm}`), ["22/10", "29/10", "05/11"]);
  assert.equal(j.pasados, 0);
  const malFin = planificarDias({ startFmt: "22/10/26", endFmt: "", dias: null }, hoy.medianoche);
  assert.equal(malFin.ok, false);
  assert.match(malFin.motivo, /fecha de fin/);
  const malInicio = planificarDias({ startFmt: "2026-10-22", endFmt: "05/11/26", dias: null }, hoy.medianoche);
  assert.equal(malInicio.ok, false);
  assert.match(malInicio.motivo, /fecha de inicio/);
});

// --- convención Bukeala y decisión de borrado (puras) ----------------------
test("evaluarRespuestaBukeala sigue la convención result.code === SUCCESS", () => {
  assert.equal(evaluarRespuestaBukeala({ result: { code: "SUCCESS" } }).ok, true);
  const fallo = evaluarRespuestaBukeala({ result: { code: "ERROR", description: "<b>No se pudo</b> cancelar" } });
  assert.equal(fallo.ok, false);
  assert.equal(fallo.msg, "No se pudo cancelar");
  assert.equal(evaluarRespuestaBukeala({ messages: [{ description: "Reserva inexistente" }] }).msg, "Reserva inexistente");
  assert.equal(evaluarRespuestaBukeala(null).ok, false);
  assert.equal(evaluarRespuestaBukeala({ status: 200 }).ok, false); // HTTP 200 sin SUCCESS no es éxito
});

test("debeBorrarCalendario: solo con recorrido completo y sin pendientes", () => {
  const limpio = nuevoResultado();
  limpio.canceladas.push({ nombre: "A", fecha: "20/10/26", hora: "08:00 AM" });
  assert.deepEqual(debeBorrarCalendario(limpio), { borrar: true, motivos: [] });
  assert.equal(debeBorrarCalendario(nuevoResultado()).borrar, true); // sin citas también se borra

  const conFallo = nuevoResultado();
  conFallo.cancelFallidas.push({ nombre: "B", fecha: "20/10/26", hora: "08:20 AM", detalle: "x" });
  assert.equal(debeBorrarCalendario(conFallo).borrar, false);
  const truncado = { ...nuevoResultado(), truncado: true, motivoTruncado: "tope de 40 pacientes por ejecución" };
  assert.equal(debeBorrarCalendario(truncado).borrar, false);
  const sinCodigo = nuevoResultado(); sinCodigo.sinCodigo.push({ nombre: "C", fecha: "20/10/26", hora: "" });
  assert.equal(debeBorrarCalendario(sinCodigo).borrar, false);
  const noEval = nuevoResultado(); noEval.noEvaluables.push({ nombre: "D", fecha: "20/10/26", hora: "" });
  assert.equal(debeBorrarCalendario(noEval).borrar, false);
  assert.equal(debeBorrarCalendario({ ...nuevoResultado(), sesionCaida: true }).borrar, false);
  assert.equal(debeBorrarCalendario({ ...nuevoResultado(), errorRecorrido: "boom" }).borrar, false);
});

test("resumirResultado no cuenta como avisado un aviso fallido y explica por qué no borró", () => {
  const cal = calInfo();
  const r = nuevoResultado();
  r.diasRecorridos = 1;
  r.canceladas.push({ nombre: "Nino Uno", fecha: "20/10/26", hora: "08:20 AM" });
  r.avisosFallidos.push({ nombre: "Nino Uno", fecha: "20/10/26", hora: "08:20 AM", detalle: "(#131030) Recipient not in allowed list" });
  r.cancelFallidas.push({ nombre: "Nino Dos", fecha: "20/10/26", hora: "09:00 AM", detalle: "Reserva inexistente" });
  const texto = resumirResultado(cal, "500", r, { hecho: false, motivos: debeBorrarCalendario(r).motivos });
  assert.match(texto, /Agenda NO borrada/);
  assert.match(texto, /Avisos aceptados por WhatsApp: 0/);
  assert.match(texto, /Avisos fallidos: 1/);
  assert.match(texto, /Canceladas: 1/);
  assert.match(texto, /No canceladas: 1/);
  assert.match(texto, /Canceladas SIN aviso.*\n• Nino Uno 20\/10\/26 08:20 AM — \(#131030\)/);
  assert.match(texto, /No canceladas.*\n• Nino Dos 20\/10\/26 09:00 AM — Reserva inexistente/);
  assert.match(texto, /sigue existiendo.*1 cita\(s\) no se pudieron cancelar/);
  assert.match(texto, /cancelar_agenda confirmar 500/);
  assert.doesNotMatch(texto, /Agenda borrada/);
});

// --- hallazgo: el resumen debe caber en un mensaje de Telegram ---------------
test("resumirResultado cabe en Telegram (≤ 3900) con 40 ítems de detalle largo en cada bloque, sin perder ningún bloque", () => {
  const cal = calInfo();
  const r = nuevoResultado();
  r.diasRecorridos = 1;
  const nombre = "Paciente Con Nombre Muy Largo Apellido Uno Apellido Dos";
  const detalle = "x".repeat(150);
  const lote = (det) => Array.from({ length: 40 }, (_, i) => ({ nombre: `${nombre} ${i + 1}`, fecha: "20/10/26", hora: "08:20 AM", detalle: det }));
  r.cancelFallidas = lote(detalle);
  r.sinCodigo = lote(undefined);
  r.noEvaluables = lote(detalle);
  r.avisosFallidos = lote(detalle);
  r.canceladas = [...r.cancelFallidas];
  r.avisados = lote(undefined);
  r.hermanosSolapados = ["501 (Niños/adolescentes 08:00-12:00 20/10/26→20/10/26)"];
  const texto = resumirResultado(cal, "500", r, { hecho: false, motivos: debeBorrarCalendario(r).motivos });
  assert.ok(texto.length <= 3900, `longitud ${texto.length}`);
  assert.match(texto, /Canceladas SIN aviso[^\n]*\n• Paciente Con Nombre/); // lo accionable va primero y con ítems
  assert.match(texto, /No canceladas/);
  assert.match(texto, /Sin código de reserva/);
  assert.match(texto, /No evaluables/);
  assert.match(texto, /Canceladas y avisadas/);
  assert.match(texto, /… y \d+ más/);
  assert.match(texto, /La agenda sigue existiendo/); // el pie no se recorta
});

test("enumerateDays: rango inclusivo, tope y cualquier fecha ilegible → []", () => {
  assert.equal(enumerateDays("30/10/26", "02/11/26", 31).length, 4);
  assert.equal(enumerateDays("01/10/26", "31/12/26", 32).length, 32);
  assert.deepEqual(enumerateDays("x", "20/10/26", 31), []);
  assert.deepEqual(enumerateDays("20/10/26", "", 31), []);          // antes colapsaba a un día
  assert.deepEqual(enumerateDays("20/10/26", "2026-11-03", 31), []);
  assert.deepEqual(enumerateDays("20/10/26", "20/10/26", 31), [{ dd: "20", mm: "10", yyyy: "2026" }]);
});

// --- (5) orquestación completa con stubs -----------------------------------
const CAL_NINOS_500 = { id: 500, description: "Niños 20/10", startDateFormatted: "20/10/26", endDateFormatted: "20/10/26", minStartBookingSeconds: 8 * 3600, maxStartBookingSeconds: 12 * 3600, stateDescription: "Activa" };
// 06:00 Bogotá del martes 20/10/26: todas las citas de la mañana son futuras.
const NOW = new Date("2026-10-20T11:00:00Z");

function fake(over = {}) {
  const calls = { getAgenda: [], cancel: [], sendText: [], delete: [], getContacto: [] };
  const f = {
    calls,
    agendaDelDia: [],
    agendaPorDia: {},               // { "DD-MM-YYYY": [...] } tiene prioridad sobre agendaDelDia
    calendarios: { "1222": [CAL_NINOS_500], "1218": [] },
    cancelResponse: () => Response.json({ result: { code: "SUCCESS" } }),
    waResponse: () => ({ ok: true, status: 200, data: { messages: [{ id: "wamid.fict" }] } }),
    contacto: () => ({ cedula: "FICT-0001", telefono: "570000000000", fuente: "manual", actualizado: "2026-10-20T00:00:00Z" }),
    async selectBookingComponent(id) {
      return Response.json({ bookingComponent: { bookingCalendars: f.calendarios[id] ?? [] } });
    },
    async getAgenda(d) { calls.getAgenda.push(d); return Response.json({ areas: [{ bookings: f.agendaPorDia[d] ?? f.agendaDelDia }] }); },
    async cancelBooking(args) { calls.cancel.push(args); return f.cancelResponse(args); },
    async deleteBookingCalendar(ids) { calls.delete.push(ids); return Response.json({ result: { code: "SUCCESS" } }); },
    async sendText(env, to, body) { calls.sendText.push({ to, body }); return f.waResponse(); },
    async getContacto(env, ced) { calls.getContacto.push(ced); return f.contacto(ced); },
    ...over,
  };
  globalThis.__fake = f;
  return f;
}
const env = { BRANCH_ID: "456" };
const run = (args, now = NOW) => handleCancelarAgenda(env, args, { now });

test("confirmar: solo toca las citas del calendario; un aviso ok:false no cuenta como avisado; borra si todo quedó cancelado", async () => {
  const f = fake();
  f.agendaDelDia = [
    cita({ id: 1, name: "Nino Uno", reservationCode: "RC-NINO-1" }),
    cita({ id: 2, name: "Adulto Tarde", identification: "FICT-0002", bookingComponentCode: "890239", startHourFormatted: "03:00 PM", reservationCode: "RC-ADULTO-1" }),
  ];
  f.waResponse = () => ({ ok: false, status: 400, data: { error: { message: "(#131030) Recipient phone number not in allowed list" } } });
  const r = await run("confirmar 500");
  assert.equal(r.needsRenew, undefined);
  assert.deepEqual(f.calls.getAgenda, ["20-10-2026"]);
  assert.deepEqual(f.calls.cancel.map((c) => c.reservationCode), ["RC-NINO-1"]); // nunca el adulto
  assert.equal(f.calls.sendText.length, 1);
  assert.match(f.calls.sendText[0].body, /Hola Nino, .*20\/10\/26 a las 08:20 AM/);
  assert.match(r.reply, /Citas de esta agenda: 1/);
  assert.match(r.reply, /Canceladas: 1/);
  assert.match(r.reply, /Avisos aceptados por WhatsApp: 0/);
  assert.match(r.reply, /Avisos fallidos: 1/);
  assert.match(r.reply, /Canceladas SIN aviso[^\n]*\n• Nino Uno 20\/10\/26 08:20 AM — \(#131030\)/);
  assert.doesNotMatch(r.reply, /Adulto Tarde/);
  assert.deepEqual(f.calls.delete, [["500"]]);
  assert.match(r.reply, /Agenda cancelada/);
  assert.match(r.reply, /Agenda borrada en Bukeala/);
});

test("confirmar: cancelación rechazada por Bukeala (HTTP 200 sin SUCCESS) → no se avisa y NO se borra el calendario", async () => {
  const f = fake();
  f.agendaDelDia = [
    cita({ id: 1, name: "Nino Uno", reservationCode: "RC-NINO-1" }),
    cita({ id: 2, name: "Nino Dos", identification: "FICT-0003", reservationCode: "RC-NINO-2", startHourFormatted: "09:00 AM" }),
  ];
  f.cancelResponse = (args) => args.reservationCode === "RC-NINO-2"
    ? Response.json({ result: { code: "ERROR", description: "<b>Reserva</b> inexistente" } })
    : Response.json({ result: { code: "SUCCESS" } });
  const r = await run("confirmar 500");
  assert.equal(f.calls.cancel.length, 2);
  assert.equal(f.calls.sendText.length, 1); // solo el que sí se canceló
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /Agenda NO borrada/);
  assert.match(r.reply, /Canceladas: 1/);
  assert.match(r.reply, /No canceladas: 1/);
  assert.match(r.reply, /Avisos aceptados por WhatsApp: 1/);
  assert.match(r.reply, /• Nino Dos 20\/10\/26 09:00 AM — Reserva inexistente/);
  assert.match(r.reply, /sigue existiendo/);
  assert.match(r.reply, /cancelar_agenda confirmar 500/);
});

test("confirmar: sin citas propias (solo de otra agenda) → no cancela ni avisa a nadie y sí borra el molde", async () => {
  const f = fake();
  f.agendaDelDia = [cita({ id: 2, name: "Adulto Tarde", bookingComponentCode: "890239", startHourFormatted: "03:00 PM", reservationCode: "RC-ADULTO-1" })];
  const r = await run("confirmar 500");
  assert.equal(f.calls.cancel.length, 0);
  assert.equal(f.calls.sendText.length, 0);
  assert.deepEqual(f.calls.delete, [["500"]]);
  assert.match(r.reply, /Citas de esta agenda: 0/);
  assert.match(r.reply, /Agenda borrada/);
});

test("confirmar: cita propia sin reservationCode → se reporta y NO se borra el calendario", async () => {
  const f = fake();
  f.agendaDelDia = [cita({ id: 1, name: "Nino Sin Codigo", reservationCode: undefined, bookingCode: "ABC-FICT" })];
  const r = await run("confirmar 500");
  assert.equal(f.calls.cancel.length, 0);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /Sin código de reserva: 1/);
  assert.match(r.reply, /Nino Sin Codigo/);
  assert.match(r.reply, /Agenda NO borrada/);
});

test("confirmar: sesión caída a mitad → needsRenew, molde intacto y el resumen lista lo ya cancelado", async () => {
  const f = fake();
  f.agendaDelDia = [
    cita({ id: 1, name: "Nino Uno", reservationCode: "RC-NINO-1" }),
    cita({ id: 2, name: "Nino Dos", reservationCode: "RC-NINO-2", startHourFormatted: "09:00 AM" }),
  ];
  const SessionExpiredError = globalThis.__StubSessionExpiredError;
  f.cancelResponse = (args) => { if (args.reservationCode === "RC-NINO-2") throw new SessionExpiredError(); return Response.json({ result: { code: "SUCCESS" } }); };
  const r = await run("confirmar 500");
  assert.equal(r.needsRenew, true);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /Canceladas: 1/);
  assert.match(r.reply, /Canceladas y avisadas[^\n]*\n• Nino Uno/);
  assert.match(r.reply, /sesión de Bukeala se cayó/);
  assert.doesNotMatch(r.reply, /Nino Dos/); // no se llegó a procesar: ni cancelada ni fallida
});

test("confirmar: tope de pacientes (41) → recorrido incompleto, NO se borra y se explica cómo seguir", async () => {
  const f = fake();
  f.agendaDelDia = Array.from({ length: 41 }, (_, i) => cita({ id: i + 1, name: `Nino ${i + 1}`, identification: `FICT-${i}`, reservationCode: `RC-${i + 1}`, startHourFormatted: "08:00 AM" }));
  const r = await run("confirmar 500");
  assert.equal(f.calls.cancel.length, 40);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /recorrido INCOMPLETO/);
  assert.match(r.reply, /tope de 40 pacientes/);
  assert.match(r.reply, /Agenda NO borrada/);
  assert.match(r.reply, /repite <code>\/cancelar_agenda confirmar 500/i);
});

// --- hallazgo: 40 exactas no deben truncar -----------------------------------
test("confirmar: 40 citas exactas y un día siguiente vacío → recorrido completo y molde borrado", async () => {
  const f = fake();
  f.calendarios["1222"] = [{ ...CAL_NINOS_500, endDateFormatted: "21/10/26" }];
  f.agendaPorDia["20-10-2026"] = Array.from({ length: 40 }, (_, i) => cita({ id: i + 1, name: `Nino ${i + 1}`, identification: `FICT-${i}`, reservationCode: `RC-${i + 1}`, startHourFormatted: "08:00 AM" }));
  const r = await run("confirmar 500");
  assert.deepEqual(f.calls.getAgenda, ["20-10-2026", "21-10-2026"]);
  assert.equal(f.calls.cancel.length, 40);
  assert.equal(f.calls.sendText.length, 40);
  assert.deepEqual(f.calls.delete, [["500"]]);
  assert.match(r.reply, /Días revisados: 2/);
  assert.doesNotMatch(r.reply, /INCOMPLETO/);
  assert.match(r.reply, /Agenda cancelada/);
});

// --- hallazgo: ventana inválida con solo un campo ausente o min > max ---------
test("confirmar: calendario sin ventana horaria (ambos ausentes) → aborta sin consultar agenda ni borrar", async () => {
  const f = fake();
  f.calendarios["1222"] = [{ ...CAL_NINOS_500, minStartBookingSeconds: undefined, maxStartBookingSeconds: undefined }];
  const r = await run("confirmar 500");
  assert.equal(f.calls.getAgenda.length, 0);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /ventana horaria válida/);
  assert.match(r.reply, /No cancelé ni borré nada/);
});

test("confirmar: solo falta maxStartBookingSeconds → aborta (antes borraba el molde con citas vivas y decía '0 citas')", async () => {
  const f = fake();
  f.calendarios["1222"] = [{ ...CAL_NINOS_500, maxStartBookingSeconds: undefined }];
  f.agendaDelDia = [cita({ id: 1, name: "Nino Vivo", reservationCode: "RC-VIVO", startHourFormatted: "09:00 AM" })];
  const r = await run("confirmar 500");
  assert.equal(f.calls.getAgenda.length, 0);
  assert.equal(f.calls.cancel.length, 0);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /maxStartBookingSeconds=ausente/);
  assert.match(r.reply, /No cancelé ni borré nada/);
  assert.doesNotMatch(r.reply, /Agenda cancelada/);
});

test("confirmar: min > max (dato corrupto) → aborta sin tocar nada", async () => {
  const f = fake();
  f.calendarios["1222"] = [{ ...CAL_NINOS_500, minStartBookingSeconds: 12 * 3600, maxStartBookingSeconds: 8 * 3600 }];
  f.agendaDelDia = [cita({ id: 1, name: "Nino Vivo", reservationCode: "RC-VIVO" })];
  const r = await run("confirmar 500");
  assert.equal(f.calls.getAgenda.length, 0);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /ventana horaria válida/);
});

// --- hallazgo: fechas ilegibles ---------------------------------------------
test("confirmar: fecha de inicio ilegible → aborta en vez de borrar 'con 0 pacientes'", async () => {
  const f = fake();
  f.calendarios["1222"] = [{ ...CAL_NINOS_500, startDateFormatted: "2026-10-20" }];
  const r = await run("confirmar 500");
  assert.equal(f.calls.getAgenda.length, 0);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /No pude interpretar la fecha de inicio/);
});

test("confirmar: fecha de fin vacía o ilegible → aborta (antes colapsaba a un día y borraba el molde dejando citas huérfanas)", async () => {
  for (const endDateFormatted of ["", "2026-11-03"]) {
    const f = fake();
    f.calendarios["1222"] = [{ ...CAL_NINOS_500, endDateFormatted }];
    f.agendaPorDia["21-10-2026"] = [cita({ id: 1, name: "Nino Huerfano", reservationCode: "RC-H" })];
    const r = await run("confirmar 500");
    assert.equal(f.calls.getAgenda.length, 0, `endDateFormatted=${JSON.stringify(endDateFormatted)}`);
    assert.equal(f.calls.cancel.length, 0);
    assert.equal(f.calls.delete.length, 0);
    assert.match(r.reply, /No pude interpretar la fecha de fin/);
    assert.match(r.reply, /No cancelé ni borré nada/);
  }
});

test("confirmar: Bukeala rechaza el borrado del molde → se dice y no se afirma 'Agenda cancelada'", async () => {
  const f = fake({ async deleteBookingCalendar(ids) { f.calls.delete.push(ids); return Response.json({ result: { code: "ERROR" }, messages: [{ description: "Calendario en uso" }] }); } });
  f.agendaDelDia = [];
  const r = await run("confirmar 500");
  assert.equal(f.calls.delete.length, 1);
  assert.match(r.reply, /Bukeala rechazó el borrado/);
  assert.match(r.reply, /Calendario en uso/);
  assert.doesNotMatch(r.reply, /Agenda cancelada/);
});

// --- hallazgo (alta): agendas hermanas del mismo perfil (lunes 8-12 vs jueves 8-12)
const CAL_JUEVES_500 = { ...CAL_NINOS_500, id: 500, description: "Niños jueves", startDateFormatted: "22/10/26", endDateFormatted: "05/11/26" };
const CAL_LUNES_501 = { ...CAL_NINOS_500, id: 501, description: "Niños lunes", startDateFormatted: "22/10/26", endDateFormatted: "05/11/26" };
const NOW_JUEVES = new Date("2026-10-22T11:00:00Z"); // 06:00 Bogotá del jueves 22/10/26

test("confirmar: agenda hermana del mismo perfil sin weekday conocido → la cita del lunes NO se cancela ni se avisa, el molde se conserva y se explica", async () => {
  const f = fake();
  f.calendarios["1222"] = [CAL_JUEVES_500, CAL_LUNES_501];
  f.agendaPorDia["26-10-2026"] = [cita({ id: 1, name: "Nino Lunes", reservationCode: "RC-LUNES", startHourFormatted: "09:00 AM" })];
  const r = await run("confirmar 500", NOW_JUEVES);
  assert.equal(f.calls.getAgenda.length, 15); // 22/10 → 05/11, todos los días (weekday desconocido)
  assert.equal(f.calls.cancel.length, 0);
  assert.equal(f.calls.sendText.length, 0);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /Agenda NO borrada/);
  assert.match(r.reply, /No pude decidir si son de esta agenda: 1/);
  assert.match(r.reply, /• Nino Lunes 26\/10\/26 09:00 AM — también cabe en la agenda 501/);
  assert.match(r.reply, /Agendas hermanas del mismo perfil con horario solapado: 501/);
  assert.match(r.reply, /Cancela esas citas con \/cancelar/);
  assert.doesNotMatch(r.reply, /Agenda cancelada/);
});

test("confirmar: con weekday en el objeto (daysSelected) solo se recorren los jueves; la cita del lunes nunca se toca y el molde del jueves sí se borra", async () => {
  const f = fake();
  f.calendarios["1222"] = [{ ...CAL_JUEVES_500, daysSelected: ["5"] }, { ...CAL_LUNES_501, daysSelected: ["2"] }];
  f.agendaPorDia["26-10-2026"] = [cita({ id: 1, name: "Nino Lunes", reservationCode: "RC-LUNES", startHourFormatted: "09:00 AM" })];
  f.agendaPorDia["29-10-2026"] = [cita({ id: 2, name: "Nino Jueves", identification: "FICT-0009", reservationCode: "RC-JUEVES", startHourFormatted: "09:00 AM" })];
  const r = await run("confirmar 500", NOW_JUEVES);
  assert.deepEqual(f.calls.getAgenda, ["22-10-2026", "29-10-2026", "05-11-2026"]);
  assert.deepEqual(f.calls.cancel.map((c) => c.reservationCode), ["RC-JUEVES"]);
  assert.equal(f.calls.sendText.length, 1);
  assert.deepEqual(f.calls.delete, [["500"]]);
  assert.match(r.reply, /Agenda cancelada/);
  assert.match(r.reply, /Jueves/);
  assert.doesNotMatch(r.reply, /hermanas/);
  assert.doesNotMatch(r.reply, /Nino Lunes/);
});

// --- hallazgo (media): borde inclusivo entre calendarios contiguos del mismo perfil
test("confirmar: calendarios contiguos 8-12 y 12-16 del mismo perfil → la cita de las 12:00 es noEvaluable, la de las 09:00 se cancela, el molde se conserva", async () => {
  const f = fake();
  f.calendarios["1222"] = [CAL_NINOS_500, { ...CAL_NINOS_500, id: 502, description: "Niños tarde", minStartBookingSeconds: 12 * 3600, maxStartBookingSeconds: 16 * 3600 }];
  f.agendaDelDia = [
    cita({ id: 1, name: "Nino Nueve", reservationCode: "RC-9", startHourFormatted: "09:00 AM" }),
    cita({ id: 2, name: "Nino Doce", identification: "FICT-0012", reservationCode: "RC-12", startHourFormatted: "12:00 PM" }),
  ];
  const r = await run("confirmar 500");
  assert.deepEqual(f.calls.cancel.map((c) => c.reservationCode), ["RC-9"]);
  assert.equal(f.calls.sendText.length, 1);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /• Nino Doce 20\/10\/26 12:00 PM — también cabe en la agenda 502/);
  assert.match(r.reply, /Agenda NO borrada/);
});

// --- hallazgo (alta): días pasados y citas ya atendidas ------------------------
test("confirmar: rango que empezó hace días → no se consultan los días pasados; hoy se saltan ENDED/NOT_ASSISTED y las que ya empezaron", async () => {
  const f = fake();
  f.calendarios["1222"] = [{ ...CAL_NINOS_500, startDateFormatted: "13/10/26", endDateFormatted: "27/10/26" }];
  f.agendaPorDia["13-10-2026"] = [cita({ id: 1, name: "Nino Vieja", reservationCode: "RC-VIEJA" })];
  f.agendaPorDia["25-10-2026"] = [
    cita({ id: 2, name: "Nino Atendido", reservationCode: "RC-ENDED", stateCode: "ENDED", startHourFormatted: "08:00 AM" }),
    cita({ id: 3, name: "Nino Ya Empezo", reservationCode: "RC-PASADA", startHourFormatted: "09:00 AM" }),
    cita({ id: 4, name: "Nino Futuro", identification: "FICT-0004", reservationCode: "RC-FUTURA", startHourFormatted: "11:00 AM" }),
    cita({ id: 5, name: "Nino No Asistio", reservationCode: "RC-NA", stateCode: "NOT_ASSISTED", startHourFormatted: "11:20 AM" }),
  ];
  const r = await run("confirmar 500", new Date("2026-10-25T15:00:00Z")); // 10:00 Bogotá del 25/10
  assert.deepEqual(f.calls.getAgenda, ["25-10-2026", "26-10-2026", "27-10-2026"]);
  assert.deepEqual(f.calls.cancel.map((c) => c.reservationCode), ["RC-FUTURA"]);
  assert.equal(f.calls.sendText.length, 1);
  assert.match(f.calls.sendText[0].body, /Hola Nino, .*25\/10\/26 a las 11:00 AM/);
  assert.deepEqual(f.calls.delete, [["500"]]);
  assert.match(r.reply, /Días revisados: 3 · 12 día\(s\) ya pasados no se revisan/);
  assert.match(r.reply, /Agenda cancelada/);
  assert.doesNotMatch(r.reply, /Nino Atendido|Nino Ya Empezo|Nino No Asistio|Nino Vieja/);
});

test("confirmar: estado de cita no reconocido → noEvaluable, no se cancela y no se borra", async () => {
  const f = fake();
  f.agendaDelDia = [cita({ id: 1, name: "Nino Raro", reservationCode: "RC-RARO", stateCode: "FOO" })];
  const r = await run("confirmar 500");
  assert.equal(f.calls.cancel.length, 0);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /• Nino Raro 20\/10\/26 08:20 AM — estado "FOO" no reconocido/);
  assert.match(r.reply, /Agenda NO borrada/);
});

// --- hallazgo (baja): hora contradictoria no excluye en silencio ---------------
test("confirmar: startHours en base 12 contradice startHourFormatted → noEvaluable y el molde se conserva", async () => {
  const f = fake();
  f.agendaDelDia = [cita({ id: 1, name: "Nino Contradictorio", reservationCode: "RC-C", startHours: 20, startMinutes: 20, startHourFormatted: "08:20 AM" })];
  const r = await run("confirmar 500");
  assert.equal(f.calls.cancel.length, 0);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /Nino Contradictorio[^\n]*no coincide/);
  assert.match(r.reply, /Agenda NO borrada/);
});

// --- hallazgo (baja): rango > 31 días aborta ANTES de cualquier efecto -------
test("confirmar: más de 31 días por revisar → aborta antes de cancelar o avisar a nadie y no sugiere 'partir el rango'", async () => {
  const f = fake();
  f.calendarios["1222"] = [{ ...CAL_NINOS_500, startDateFormatted: "01/11/26", endDateFormatted: "31/12/26" }];
  f.agendaDelDia = [cita({ id: 1, name: "Nino Uno", reservationCode: "RC-1" })];
  const r = await run("confirmar 500");
  assert.equal(f.calls.getAgenda.length, 0);
  assert.equal(f.calls.cancel.length, 0);
  assert.equal(f.calls.sendText.length, 0);
  assert.equal(f.calls.delete.length, 0);
  assert.match(r.reply, /61 días por revisar/);
  assert.match(r.reply, /No cancelé ni borré nada/);
  assert.match(r.reply, /borra la agenda desde Bukeala/);
  assert.doesNotMatch(r.reply, /parte el rango/);
});

test("confirmar: con weekday conocido el tope de 31 cuenta solo los días consultados (un año de jueves sí supera; dos meses de jueves no)", async () => {
  const f = fake();
  f.calendarios["1222"] = [{ ...CAL_NINOS_500, startDateFormatted: "01/11/26", endDateFormatted: "31/12/26", daysSelected: ["5"] }];
  const r = await run("confirmar 500");
  assert.equal(f.calls.getAgenda.length, 9); // jueves entre 01/11 y 31/12 de 2026
  assert.deepEqual(f.calls.delete, [["500"]]);
  assert.match(r.reply, /Agenda cancelada/);
});

// --- paso 1: el listado muestra el weekday si se conoce y no afirma de más ----
test("listar: muestra días de la semana si el objeto los trae, '??:??' si falta la ventana, y el aviso dice 'solo las citas futuras de esa agenda'", async () => {
  const f = fake();
  f.calendarios["1222"] = [{ ...CAL_JUEVES_500, daysSelected: ["5"] }, { ...CAL_NINOS_500, id: 505, maxStartBookingSeconds: undefined }];
  const r = await run("");
  assert.match(r.reply, /<code>500<\/code> · Niños\/adolescentes · Jueves/);
  assert.match(r.reply, /<code>505<\/code>[^\n]*\n[^\n]*08:00-\?\?:\?\?/);
  assert.match(r.reply, /solo las citas futuras de esa agenda/);
});
