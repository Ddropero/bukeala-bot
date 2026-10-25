import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Empaqueta el código REAL de la cadena de recordatorios (fuentes/gcal.ts ->
// agendaFuente.ts -> reminderCron / eveningReminder) y sustituye solo las
// puertas de salida (API de Calendar, Bukeala, envío de WhatsApp, KV de
// sesión, destinatarios de Telegram) por stubs controlados desde
// `globalThis.__fake`. El directorio de contactos y esNumeroDelEquipo son los
// reales: leen un KV falso en memoria.
//
// Los stubs se eligen por RUTA RESUELTA, no por nombre: "./bukeala" desde
// fuentes/index.ts es la fuente de agenda (se queda real) y desde
// agendaFuente.ts es el cliente del portal (se stubbea).
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const real = (p) => path.join(SRC, p);
const llave = (p) => path.normalize(p).toLowerCase();
const STUBS = {
  [llave(real("gcal"))]: `
    export async function listEvents(env, cal, desde, hasta) { return globalThis.__fake.listEvents(env, cal, desde, hasta); }`,
  [llave(real("bukeala"))]: `
    export class SessionExpiredError extends Error {}
    export class Bukeala {
      constructor(env) { this.env = env; }
      getAgenda(d, area, inc) { return globalThis.__fake.getAgenda(d, area, inc); }
    }`,
  [llave(real("kv"))]: `export async function loadSession() { return null; }`,
  [llave(real("users"))]: `export async function getAllRecipients() { return []; }`,
  // normalizeColombianPhone es el real; solo el ENVÍO se intercepta.
  [llave(real("whatsapp"))]: `
    export { normalizeColombianPhone } from ${JSON.stringify(real("whatsapp.ts"))};
    export async function sendAppointmentConfirmRequest(env, phone, name, date, time, place) {
      return globalThis.__fake.enviar({ phone, name, date, time, place });
    }`,
};
const entrada = `
  export * from ${JSON.stringify(real("agendaFuente.ts"))};
  export { fuenteGCal, textoPlanoDescripcion } from ${JSON.stringify(real("fuentes/gcal.ts"))};
  export { buildAgendaText } from ${JSON.stringify(real("agendaDoc.ts"))};
  export { reminderCron } from ${JSON.stringify(real("cron/reminderCron.ts"))};
  export { eveningReminderCron } from ${JSON.stringify(real("cron/eveningReminder.ts"))};
`;
const bundle = (await build({
  stdin: { contents: entrada, resolveDir: SRC, loader: "js" },
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
  plugins: [{ name: "stub-io", setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, (a) => {
      const k = llave(path.resolve(a.resolveDir, a.path));
      return STUBS[k] ? { path: k, namespace: "stub" } : undefined;
    });
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js", resolveDir: SRC }));
  } }],
})).outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
const {
  esCitaDePaciente, destinoDeRecordatorio, telefonoDeCita, citaABookingDoc, leerAgendaDelDia,
  cedulaDeCita, fuenteGCal, textoPlanoDescripcion, buildAgendaText, reminderCron, eveningReminderCron,
} = mod;

// Ningún test puede salir a la red: si algo intenta un fetch real, revienta.
globalThis.fetch = async (url) => { throw new Error(`red prohibida en tests: ${String(url).slice(0, 40)}`); };

// --- Fixtures (todo ficticio: nombres, cédulas, teléfonos, ids) -------------
const DOCTOR = "573000000001";
const SECRETARIA = "573000000002";
const TEL = "\u{1F4DE}";   // la línea del teléfono que escribe el espejo
const DOC = "\u{1FAAA}";   // la línea del documento
const MAIL = "✉️";
const SEGURO = "\u{1F3E5}";

function fakeEnv({ gcal = true, kv = {} } = {}) {
  const mapa = new Map(Object.entries(kv));
  return {
    ...(gcal ? { GCAL_SERVICE_ACCOUNT_JSON: "{}", GCAL_CALENDAR_ID: "cal-ficticio@test" } : {}),
    DOCTOR_WHATSAPP_NUMBER: DOCTOR,
    SECRETARY_WHATSAPP_NUMBERS: SECRETARIA,
    TELEGRAM_BOT_TOKEN: "token-ficticio",
    STATE: {
      get: async (k) => (mapa.has(k) ? mapa.get(k) : null),
      put: async (k, v) => { mapa.set(k, v); },
    },
  };
}

function evento({ id, titulo, desc = "", origen, hora = "09:00" }) {
  return {
    id, summary: titulo, description: desc, status: "confirmed",
    start: { dateTime: `2026-10-26T${hora}:00-05:00` },
    end: { dateTime: `2026-10-26T${hora.slice(0, 3)}50:00-05:00` },
    ...(origen ? { extendedProperties: { private: { origen, cedula: "x" } } } : {}),
  };
}

// Un día de Calendar con todo lo que se ha visto en la vida real.
const EVENTOS = [
  // Administrativos hechos a mano: el teléfono de una clínica suelto en la descripción.
  evento({ id: "ev-admin-1", titulo: "Agenda de consultas", desc: "Clinica ficticia, citas al 3000000999", hora: "07:00" }),
  evento({ id: "ev-admin-2", titulo: "CITAS EXTRAS CLÍNICA COLOMBIA", desc: "Llamar al +57 3000000998 para confirmar", hora: "07:30" }),
  // A mano, con la línea del teléfono etiquetada pero sin cédula.
  evento({ id: "ev-man-sincc", titulo: "Paciente Uno", desc: `${TEL} +573000000101`, hora: "08:00" }),
  // A mano, con cédula y "tel:".
  evento({ id: "ev-man-ok", titulo: "Paciente Dos - control", desc: "cc: 1000000002\ntel: 3000000102", hora: "08:20" }),
  // A mano, con cédula pero el número suelto (sin etiqueta).
  evento({ id: "ev-man-suelto", titulo: "Paciente Tres", desc: "cc: 1000000003\nsu numero es 3000000103", hora: "08:40" }),
  // Espejo de Bukeala.
  evento({ id: "ev-espejo", titulo: "Paciente Cuatro - Colsanitas", origen: "bukeala",
    desc: `${DOC} CC 1000000004\n${TEL} +573000000104\n${MAIL} p4@example.com`, hora: "09:00" }),
  // Flujo del equipo por WhatsApp.
  evento({ id: "ev-secre", titulo: "Paciente Cinco - Particular", origen: "secretaria",
    desc: `${DOC} CC 1000000005\n${SEGURO} Particular\n${TEL} +573000000105`, hora: "09:20" }),
  // Espejo, pero el teléfono es el del Dr. (pasa cuando el Dr. consulta desde su WhatsApp).
  evento({ id: "ev-espejo-equipo", titulo: "Paciente Seis", origen: "bukeala",
    desc: `${DOC} CC 1000000006\n${TEL} +${DOCTOR}`, hora: "09:40" }),
  // Espejo sin teléfono en la descripción (el directorio lo tuvo después):
  // solo el origen lo distingue de un evento a mano, así que si la marca se
  // pierde en el camino este paciente se queda sin recordatorio.
  evento({ id: "ev-espejo-dir", titulo: "Paciente Catorce - Colsanitas", origen: "bukeala",
    desc: `${DOC} CC 1000000014\n${TEL} sin teléfono en el directorio`, hora: "10:00" }),
];
// El directorio propio (KV) tiene el celular del paciente del espejo sin teléfono.
const DIRECTORIO = { "paciente:contacto:1000000014": JSON.stringify({ cedula: "1000000014", telefono: "573000000114" }) };

async function bookingsDelDia(env = fakeEnv()) {
  globalThis.__fake = { listEvents: async () => EVENTOS };
  const dia = await fuenteGCal.citasDelDia(env, "26-10-2026");
  return Object.fromEntries(dia.citas.map((c) => [c.id, citaABookingDoc(c)]));
}

// Ningún motivo puede llevar un teléfono o una cédula: van al log.
const sinNumeros = (m) => assert.doesNotMatch(m, /\d{5,}/, `el motivo filtra un número: ${m}`);

// --- La regla, pura ----------------------------------------------------------
test("esCitaDePaciente: origen bukeala / secretaria basta", () => {
  for (const origen of ["bukeala", "secretaria"]) {
    const d = esCitaDePaciente({ origen });
    assert.equal(d.ok, true, origen);
    sinNumeros(d.motivo);
  }
});

test("esCitaDePaciente: a mano exige cédula Y teléfono etiquetado (etiqueta o línea del teléfono)", () => {
  const casos = [
    [{ origen: "manual", cellPhone: "573000000999", telefonoFuente: "suelto" }, false, /sin cédula/],
    [{ origen: "manual", cellPhone: "573000000101", telefonoFuente: "emoji" }, false, /sin cédula/],
    [{ origen: "manual", identification: "1000000003", cellPhone: "573000000103", telefonoFuente: "suelto" }, false, /suelto/],
    [{ origen: "manual", identification: "1000000009" }, false, /sin teléfono etiquetado/],
    [{ origen: "manual", identification: "   ", telefonoFuente: "etiqueta" }, false, /sin cédula/],
    [{ origen: "manual", identification: "1000000002", telefonoFuente: "etiqueta" }, true, /cédula y teléfono etiquetado/],
    [{ origen: "manual", identification: "CC 1000000008", telefonoFuente: "emoji" }, true, /cédula y teléfono etiquetado/],
  ];
  for (const [bk, ok, motivo] of casos) {
    const d = esCitaDePaciente(bk);
    assert.equal(d.ok, ok, JSON.stringify(bk));
    assert.match(d.motivo, motivo);
    sinNumeros(d.motivo);
  }
});

test("esCitaDePaciente: sin origen o con un origen desconocido se trata como a mano (falla hacia NO enviar)", () => {
  assert.equal(esCitaDePaciente({ cellPhone: "573000000999" }).ok, false);
  assert.equal(esCitaDePaciente({ origen: "otro", identification: "1000000010", telefonoFuente: "suelto" }).ok, false);
  assert.match(esCitaDePaciente({}).motivo, /sin origen/);
  // ...pero si trae cédula y teléfono etiquetado, sí es identificable.
  assert.equal(esCitaDePaciente({ identification: "1000000011", telefonoFuente: "etiqueta" }).ok, true);
});

// --- Integración: el origen sobrevive Calendar -> Cita -> AgendaBookingDoc ----
test("citasDelDia -> citaABookingDoc conserva el origen y cómo salió el teléfono", async () => {
  const bk = await bookingsDelDia();
  assert.equal(bk["ev-espejo"].origen, "bukeala");
  assert.equal(bk["ev-espejo"].telefonoFuente, "emoji");
  assert.equal(bk["ev-secre"].origen, "secretaria");
  assert.equal(bk["ev-admin-1"].origen, "manual");
  assert.equal(bk["ev-admin-1"].telefonoFuente, "suelto");
  assert.equal(bk["ev-man-ok"].origen, "manual");
  assert.equal(bk["ev-man-ok"].telefonoFuente, "etiqueta");
  assert.equal(bk["ev-man-ok"].identification, "1000000002");
  assert.equal(bk["ev-man-sincc"].telefonoFuente, "emoji");
  assert.equal(bk["ev-man-sincc"].identification, undefined);
  assert.equal(bk["ev-man-suelto"].telefonoFuente, "suelto");
  assert.equal(bk["ev-espejo-dir"].origen, "bukeala");
  assert.equal(bk["ev-espejo-dir"].telefonoFuente, "");
  assert.equal(bk["ev-espejo-dir"].cellPhone, undefined);
});

test("lo que se MUESTRA no cambia: el número suelto sigue en la cita y en la agenda de Laura", async () => {
  const bk = await bookingsDelDia();
  assert.equal(bk["ev-admin-1"].cellPhone, "573000000999");
  assert.equal(bk["ev-man-suelto"].cellPhone, "573000000103");
  const texto = buildAgendaText(Object.values(bk), "26/10/26");
  assert.match(texto, /573000000999/);
  assert.match(texto, /573000000103/);
});

// --- La puerta de envío (regla + teléfono + equipo) -------------------------
test("destinoDeRecordatorio: decide caso por caso sobre eventos reales de Calendar", async () => {
  const env = fakeEnv({ kv: DIRECTORIO });
  const bk = await bookingsDelDia(env);
  const esperado = {
    "ev-admin-1": "",               // administrativo con celular suelto -> NO
    "ev-admin-2": "",               // administrativo con +57 suelto -> NO
    "ev-man-sincc": "",             // teléfono etiquetado pero sin cédula -> NO
    "ev-man-ok": "573000000102",    // cédula + "tel:" -> SÍ
    "ev-man-suelto": "",            // cédula pero número suelto -> NO
    "ev-espejo": "573000000104",    // espejo -> SÍ
    "ev-secre": "573000000105",     // secretaria -> SÍ
    "ev-espejo-equipo": "",         // paciente, pero el número es del Dr. -> NO
    "ev-espejo-dir": "573000000114", // espejo sin teléfono: sale del directorio -> SÍ
  };
  for (const [id, tel] of Object.entries(esperado)) {
    const d = await destinoDeRecordatorio(env, bk[id]);
    assert.equal(d.telefono, tel, `${id}: ${d.motivo}`);
    sinNumeros(d.motivo);
  }
  const equipo = await destinoDeRecordatorio(env, bk["ev-espejo-equipo"]);
  assert.match(equipo.motivo, /número del equipo \(\.\.\.0001\)/);
  assert.match((await destinoDeRecordatorio(env, bk["ev-admin-1"])).motivo, /^no es paciente: .*suelto/);
});

test("número del equipo -> NO aunque sea paciente (también la secretaria, y vía directorio)", async () => {
  const env = fakeEnv({ kv: { "paciente:contacto:1000000012": JSON.stringify({ cedula: "1000000012", telefono: SECRETARIA }) } });
  // Origen secretaria con el celular de la secretaria en la cita.
  const a = await destinoDeRecordatorio(env, { id: "x1", origen: "secretaria", identification: "1000000013", cellPhone: SECRETARIA });
  assert.equal(a.telefono, "");
  assert.match(a.motivo, /equipo/);
  // Espejo sin teléfono: sale del directorio por cédula... y es el de la secretaria.
  const b = await destinoDeRecordatorio(env, { id: "x2", origen: "bukeala", identification: "1000000012" });
  assert.equal(b.telefono, "");
  assert.match(b.motivo, /equipo/);
});

test("telefonoDeCita tampoco entrega el número de un evento que no es paciente", async () => {
  const env = fakeEnv();
  const bk = await bookingsDelDia(env);
  assert.equal(await telefonoDeCita(env, bk["ev-admin-1"]), "");
  assert.equal(await telefonoDeCita(env, bk["ev-espejo"]), "573000000104");
});

// --- Respaldo directo de Bukeala ---------------------------------------------
test("respaldo Bukeala (Calendar caído): las citas quedan con origen bukeala y SÍ reciben recordatorio", async () => {
  const env = fakeEnv({ kv: { "paciente:contacto:1000000007": JSON.stringify({ cedula: "1000000007", telefono: "573000000107" }) } });
  globalThis.__fake = {
    listEvents: async () => { throw new Error("Calendar caído (simulado)"); },
    getAgenda: async () => ({
      json: async () => ({ areas: [{ bookings: [
        { id: 77, name: "Paciente Siete", identification: "1000000007", stateCode: "PENDING", startHourFormatted: "10:00 AM" },
        { id: 78, name: "Paciente Ocho", identification: "1000000008", stateCode: "CANCELED", isCanceled: true },
      ] }] }),
    }),
  };
  const lectura = await leerAgendaDelDia(env, "26-10-2026");
  assert.equal(lectura.fuente, "bukeala");
  assert.equal(lectura.bookings.length, 1);
  assert.equal(lectura.bookings[0].origen, "bukeala");
  assert.equal(esCitaDePaciente(lectura.bookings[0]).ok, true);
  const d = await destinoDeRecordatorio(env, lectura.bookings[0]);
  assert.equal(d.telefono, "573000000107");
});

// --- Los dos crons, de punta a punta -----------------------------------------
async function correrCron(cron, envOpts) {
  const env = fakeEnv(envOpts);
  const enviados = [];
  const logs = [];
  globalThis.__fake = {
    ...(globalThis.__fake ?? {}),
    enviar: async (m) => { enviados.push(m); return { ok: true }; },
  };
  const original = console.log;
  console.log = (...a) => { logs.push(a.map(String).join(" ")); };
  try {
    await cron(env);
  } finally {
    console.log = original;
  }
  return { enviados, logs };
}

for (const [nombre, cron] of [["reminderCron", () => reminderCron], ["eveningReminderCron", () => eveningReminderCron]]) {
  test(`${nombre}: solo escribe a pacientes identificables, nunca al equipo ni a eventos administrativos`, async () => {
    globalThis.__fake = { listEvents: async () => EVENTOS };
    const { enviados, logs } = await correrCron(cron(), { kv: DIRECTORIO });
    assert.deepEqual(enviados.map((m) => m.phone).sort(), ["573000000102", "573000000104", "573000000105", "573000000114"]);
    assert.ok(!enviados.some((m) => /Agenda de consultas|CITAS EXTRAS/.test(m.name)));
    // Cada salto queda en el log con su motivo...
    for (const id of ["ev-admin-1", "ev-admin-2", "ev-man-sincc", "ev-man-suelto", "ev-espejo-equipo"]) {
      assert.ok(logs.some((l) => l.includes(`cita ${id}: no se envia`)), `falta el log de ${id}`);
    }
    // ...y ningún log imprime un teléfono completo.
    for (const l of logs) assert.doesNotMatch(l, /3000000\d{3}/, `log con teléfono completo: ${l}`);
  });

  test(`${nombre}: con Calendar caído usa el respaldo de Bukeala y SÍ le escribe al paciente`, async () => {
    globalThis.__fake = {
      listEvents: async () => { throw new Error("Calendar caído (simulado)"); },
      getAgenda: async () => ({ json: async () => ({ areas: [{ bookings: [
        { id: 79, name: "Paciente Nueve", identification: "1000000009", stateCode: "CONFIRMED", startHourFormatted: "11:00 AM" },
      ] }] }) }),
    };
    const { enviados } = await correrCron(cron(), {
      kv: { "paciente:contacto:1000000009": JSON.stringify({ cedula: "1000000009", telefono: "573000000109" }) },
    });
    assert.deepEqual(enviados.map((m) => m.phone), ["573000000109"]);
  });
}

// --- Hallazgos de la revisión (uno o más tests por hallazgo) -----------------
// Todos pasan por el código real de punta a punta: evento de Calendar ->
// citasDelDia -> citaABookingDoc -> destinoDeRecordatorio, y al final los dos
// crons sobre el mismo día.
const NOTA = "\u{1F4DD}";   // la línea de nota libre (comentario de Bukeala / nota de la secretaria)

const EVENTOS_REVISION = [
  // H1: "cédula" que no es un número.
  evento({ id: "r1-doc", titulo: "Agenda de consultas", desc: "Doc: Dra. Ficticia\nCel: 3000000888", hora: "07:00" }),
  evento({ id: "r1-pend", titulo: "Agenda de consultas", desc: "Cédula: pendiente\nWhatsApp: 3000000666", hora: "07:10" }),
  evento({ id: "r1-vacia", titulo: "CITAS EXTRAS CLÍNICA COLOMBIA", desc: "Cédula:\nCel: 3000000555", hora: "07:20" }),
  evento({ id: "r1-puntos", titulo: "Paciente Veinte", desc: "Cédula: 1.000.000.020\nCel: 3000000120", hora: "07:30" }),
  // H2: espejo / secretaria sin 📞 y con un número de tercero en la nota.
  evento({ id: "r2-espejo", titulo: "Paciente Veintiuno - Colsanitas", origen: "bukeala", hora: "07:40", desc: [
    `${DOC} CC 1000000021`, "📋 Plan: Plan ficticio", `${TEL} sin teléfono en el directorio`,
    `${MAIL} sin email en el directorio`, `${NOTA} Remitido por clinica ficticia, confirmar al 3000000777`,
  ].join("\n") }),
  evento({ id: "r2-espejo-cel", titulo: "Paciente Veintitrés - Colsanitas", origen: "bukeala", hora: "07:50", desc: [
    `${DOC} CC 1000000023`, `${TEL} sin teléfono en el directorio`, `${NOTA} Remitido por clinica ficticia, cel 3000000776`,
  ].join("\n") }),
  evento({ id: "r2-secre", titulo: "Paciente Veintidós - Particular", origen: "secretaria", hora: "08:00", desc: [
    `${DOC} CC 1000000022`, `${SEGURO} Particular`, `${NOTA} Llamar a la acudiente 3000000775`,
    `${NOTA} Registrada por Equipo Ficticio por WhatsApp`,
  ].join("\n") }),
  // H3: etiqueta del teléfono en medio de la línea o sin dos puntos.
  evento({ id: "r3-linea", titulo: "Paciente Treinta y uno", desc: "CC: 1000000031 - Tel: 3000000131", hora: "08:10" }),
  evento({ id: "r3-coma", titulo: "Paciente Treinta y dos", desc: "Paciente: Ana Ficticia, tel: 3000000132\ncc: 1000000032", hora: "08:20" }),
  evento({ id: "r3-punto", titulo: "Paciente Treinta y tres", desc: "cc: 1000000033\nTel. 3000000133", hora: "08:30" }),
  evento({ id: "r3-cel", titulo: "Paciente Treinta y cuatro", desc: "cc: 1000000034\nCel 3000000134", hora: "08:40" }),
  // ...pero una etiqueta que no va pegada al número, o que es el final de otra palabra, no cuenta.
  evento({ id: "r3-no-clinica", titulo: "Paciente Treinta y cinco", desc: "cc: 1000000035\nWhatsApp clínica: 3000000935", hora: "08:50" }),
  evento({ id: "r3-no-hotel", titulo: "Paciente Treinta y seis", desc: "cc: 1000000036\nHotel 3000000936", hora: "09:00" }),
  // Un número suelto ANTES del etiquetado: manda la etiqueta (igual que un "tel:" al inicio de línea).
  evento({ id: "r3-orden", titulo: "Paciente Treinta y siete", desc: "Remitida de clinica 3000000937 - tel: 3000000137\ncc: 1000000037", hora: "09:10" }),
  // H4: líneas 🪪 / 📞 con sangría.
  evento({ id: "r4-sangria", titulo: "Paciente Cuarenta y uno", desc: `  ${DOC} CC 1000000041\n\t${TEL} +573000000141`, hora: "09:20" }),
  // ...y una línea 🪪 vacía no se roba la línea de abajo como cédula.
  evento({ id: "r4-vacia", titulo: "Paciente Cuarenta y dos", desc: `${DOC}\n${TEL} +573000000142`, hora: "09:30" }),
  // H5: descripción en HTML (editor web de Calendar).
  evento({ id: "r5-br", titulo: "Paciente Cincuenta y uno", desc: "cc: 1000000051<br>tel: 3000000151", hora: "09:40" }),
  evento({ id: "r5-div", titulo: "Paciente Cincuenta y dos", desc: "<div>cc: 1000000052</div><div>tel: 3000000152</div>", hora: "09:50" }),
  evento({ id: "r5-b", titulo: "Paciente Cincuenta y tres", desc: "cc: 1000000053<br><b>tel:</b>&nbsp;3000000153", hora: "10:00" }),
  evento({ id: "r5-admin", titulo: "Agenda de consultas", desc: "<p>Clinica ficticia</p><p>Citas al 3000000959</p>", hora: "10:10" }),
  // Formato de popCuc.ts: HTML con <b>, la cédula del paciente y el número de
  // QUIEN lo registró ("Origen:"). Al leer el HTML la cédula ahora se
  // reconoce, pero ese número sigue siendo suelto: no se le escribe.
  evento({ id: "r5-popcuc", titulo: "POP CUC: Paciente Cincuenta y cuatro", hora: "10:20", desc: [
    "<b>POP CUC</b> (bot)", "<b>Paciente:</b> Paciente Cincuenta y cuatro", "<b>Cédula:</b> 1000000054", "",
    "<b>Registrado vía:</b> WhatsApp", "<b>Origen:</b> 573000000954", "<b>Fecha registro:</b> 2026-10-20T15:00:00.000Z",
  ].join("\n") }),
];
// Directorio: el paciente del espejo de H2 sí tiene celular propio.
const DIRECTORIO_REVISION = {
  "paciente:contacto:1000000021": JSON.stringify({ cedula: "1000000021", telefono: "573000000121" }),
};
// Lo que DEBE pasar con cada evento ("" = no se envía).
const ESPERADO_REVISION = {
  "r1-doc": "", "r1-pend": "", "r1-vacia": "", "r1-puntos": "573000000120",
  "r2-espejo": "573000000121", "r2-espejo-cel": "", "r2-secre": "",
  "r3-linea": "573000000131", "r3-coma": "573000000132", "r3-punto": "573000000133", "r3-cel": "573000000134",
  "r3-no-clinica": "", "r3-no-hotel": "", "r3-orden": "573000000137",
  "r4-sangria": "573000000141", "r4-vacia": "",
  "r5-br": "573000000151", "r5-div": "573000000152", "r5-b": "573000000153", "r5-admin": "", "r5-popcuc": "",
};

async function bookingsRevision(env) {
  globalThis.__fake = { listEvents: async () => EVENTOS_REVISION };
  const dia = await fuenteGCal.citasDelDia(env, "26-10-2026");
  return Object.fromEntries(dia.citas.map((c) => [c.id, citaABookingDoc(c)]));
}

async function destinoDe(env, bk, id) {
  const d = await destinoDeRecordatorio(env, bk[id]);
  sinNumeros(d.motivo);
  return d;
}

test("hallazgo 1: la cédula de un evento a mano tiene que ser un número (no «Doc: <nombre>» ni «pendiente»)", async () => {
  // La regla, pura.
  for (const identification of ["Dra. Ficticia", "pendiente", "N/A", "1234", "CC"]) {
    const d = esCitaDePaciente({ origen: "manual", identification, telefonoFuente: "etiqueta" });
    assert.equal(d.ok, false, identification);
    assert.match(d.motivo, /sin cédula válida/);
    sinNumeros(d.motivo);
  }
  assert.equal(esCitaDePaciente({ origen: "manual", identification: "1.000.000.020", telefonoFuente: "etiqueta" }).ok, true);
  assert.equal(cedulaDeCita("1.000.000.020"), "1000000020");
  assert.equal(cedulaDeCita("CC 1000000004"), "1000000004");
  // Una sola línea "CC: … - Tel: …": la cédula es el primer número, no cédula+teléfono pegados.
  assert.equal(cedulaDeCita("1000000031 - Tel: 3000000131"), "1000000031");
  assert.equal(cedulaDeCita("Dra. Ficticia"), "");
  assert.equal(cedulaDeCita(undefined), "");

  // De punta a punta, sobre eventos de Calendar.
  const env = fakeEnv();
  const bk = await bookingsRevision(env);
  assert.equal(bk["r1-doc"].identification, "Dra. Ficticia");   // lo que se muestra no cambia
  assert.equal(bk["r1-doc"].telefonoFuente, "etiqueta");
  assert.equal(bk["r1-vacia"].identification, undefined);         // "Cédula:" vacía no se traga la línea de abajo
  assert.equal(bk["r1-vacia"].cellPhone, "573000000555");
  for (const id of ["r1-doc", "r1-pend", "r1-vacia"]) {
    const d = await destinoDe(env, bk, id);
    assert.equal(d.telefono, "", `${id}: ${d.motivo}`);
    assert.match(d.motivo, /^no es paciente: .*sin cédula/);
  }
  assert.equal((await destinoDe(env, bk, "r1-puntos")).telefono, "573000000120");
});

test("hallazgo 2: con origen bukeala/secretaria un número suelto de la nota nunca es el destino", async () => {
  // Sin el paciente en el directorio: no se envía (y se dice por qué).
  const env = fakeEnv();
  const bk = await bookingsRevision(env);
  // Laura lo sigue viendo en la agenda...
  assert.equal(bk["r2-espejo"].cellPhone, "573000000777");
  assert.equal(bk["r2-espejo"].telefonoFuente, "suelto");
  assert.match(buildAgendaText([bk["r2-espejo"]], "26/10/26"), /573000000777/);
  // ...pero el bot no le escribe a ese número.
  for (const id of ["r2-espejo", "r2-espejo-cel", "r2-secre"]) {
    const d = await destinoDe(env, bk, id);
    assert.equal(d.telefono, "", `${id}: ${d.motivo}`);
    assert.match(d.motivo, /suelto/);
    assert.equal(await telefonoDeCita(env, bk[id]), "");
  }
  // Un "cel 300…" DENTRO de la nota 📝 tampoco cuenta como etiqueta.
  assert.equal(bk["r2-espejo-cel"].telefonoFuente, "suelto");

  // Con el paciente en el directorio: se le escribe a SU número, no al de la nota.
  const envDir = fakeEnv({ kv: DIRECTORIO_REVISION });
  const conDir = await bookingsRevision(envDir);
  assert.equal((await destinoDe(envDir, conDir, "r2-espejo")).telefono, "573000000121");
  // El respaldo de Bukeala (sin telefonoFuente) sigue usando el celular que trae el portal.
  const deBukeala = await destinoDeRecordatorio(fakeEnv(), {
    id: 90, origen: "bukeala", identification: "1000000090", cellPhone: { phoneNumber: "3000000190" },
  });
  assert.equal(deBukeala.telefono, "573000000190");
});

test("hallazgo 3: «tel:»/«cel» en medio de la línea o sin dos puntos cuenta como etiqueta", async () => {
  const env = fakeEnv();
  const bk = await bookingsRevision(env);
  for (const id of ["r3-linea", "r3-coma", "r3-punto", "r3-cel", "r3-orden"]) {
    assert.equal(bk[id].telefonoFuente, "etiqueta", id);
    const d = await destinoDe(env, bk, id);
    assert.equal(d.telefono, ESPERADO_REVISION[id], `${id}: ${d.motivo}`);
  }
  // La etiqueta manda sobre un número suelto anterior (como ya pasaba con "tel:" al inicio de línea).
  assert.equal(bk["r3-orden"].cellPhone, "573000000137");
  // Controles: etiqueta separada del número, o "tel" al final de otra palabra -> sigue suelto -> NO.
  for (const id of ["r3-no-clinica", "r3-no-hotel"]) {
    assert.equal(bk[id].telefonoFuente, "suelto", id);
    assert.equal((await destinoDe(env, bk, id)).telefono, "", id);
  }
  // Los administrativos del día original siguen sin etiqueta.
  const orig = await bookingsDelDia(env);
  assert.equal(orig["ev-admin-1"].telefonoFuente, "suelto");
  assert.equal(orig["ev-admin-2"].telefonoFuente, "suelto");
});

test("hallazgo 4: las líneas 🪪/📞 con sangría se leen (el \\s del patrón ya no es una «s»)", async () => {
  const env = fakeEnv();
  const bk = await bookingsRevision(env);
  assert.equal(bk["r4-sangria"].identification, "1000000041");
  assert.equal(bk["r4-sangria"].telefonoFuente, "emoji");
  assert.equal((await destinoDe(env, bk, "r4-sangria")).telefono, "573000000141");
  // Una línea 🪪 vacía no toma la línea siguiente como documento.
  assert.equal(bk["r4-vacia"].identification, undefined);
  assert.equal((await destinoDe(env, bk, "r4-vacia")).telefono, "");
  // Y las del espejo / secretaria (sin sangría) se leen igual que antes.
  const orig = await bookingsDelDia(env);
  assert.equal(orig["ev-espejo"].identification, "1000000004");
  assert.equal(orig["ev-espejo"].cellPhone, "573000000104");
});

test("hallazgo 5: descripción en HTML del editor web (<br>, <div>, <b>, &nbsp;) se lee como texto", async () => {
  // La normalización, pura: el texto plano sale idéntico.
  const espejo = EVENTOS.find((e) => e.id === "ev-espejo").description;
  assert.equal(textoPlanoDescripcion(espejo), espejo);
  assert.equal(textoPlanoDescripcion("cc: 1<br/>tel: 2"), "cc: 1\ntel: 2");
  assert.equal(textoPlanoDescripcion("a &amp; b&nbsp;c &#128222; &lt;x&gt;"), "a & b c \u{1F4DE} <x>");

  const env = fakeEnv();
  const bk = await bookingsRevision(env);
  const cedulas = { "r5-br": "1000000051", "r5-div": "1000000052", "r5-b": "1000000053" };
  for (const [id, cc] of Object.entries(cedulas)) {
    assert.equal(bk[id].telefonoFuente, "etiqueta", id);
    assert.equal(bk[id].identification, cc, `${id}: la cédula trae HTML pegado`);
    const d = await destinoDe(env, bk, id);
    assert.equal(d.telefono, ESPERADO_REVISION[id], `${id}: ${d.motivo}`);
  }
  // Un administrativo en HTML sigue siendo administrativo.
  assert.equal(bk["r5-admin"].telefonoFuente, "suelto");
  assert.equal((await destinoDe(env, bk, "r5-admin")).telefono, "");
  // POP CUC: la cédula se lee, pero el único número (el de quien registró) es suelto -> NO.
  assert.equal(bk["r5-popcuc"].identification, "1000000054");
  assert.equal(bk["r5-popcuc"].telefonoFuente, "suelto");
  const pop = await destinoDe(env, bk, "r5-popcuc");
  assert.equal(pop.telefono, "");
  assert.match(pop.motivo, /con cédula pero teléfono suelto/);
});

for (const [nombre, cron] of [["reminderCron", () => reminderCron], ["eveningReminderCron", () => eveningReminderCron]]) {
  test(`${nombre}: los casos de la revisión, de punta a punta`, async () => {
    // Primero la tabla completa contra la puerta de envío...
    const envTabla = fakeEnv({ kv: DIRECTORIO_REVISION });
    const bk = await bookingsRevision(envTabla);
    assert.deepEqual(Object.keys(bk).sort(), Object.keys(ESPERADO_REVISION).sort());
    for (const [id, tel] of Object.entries(ESPERADO_REVISION)) {
      assert.equal((await destinoDe(envTabla, bk, id)).telefono, tel, id);
    }
    // ...y después el cron real: envía exactamente a esos y a nadie más.
    globalThis.__fake = { listEvents: async () => EVENTOS_REVISION };
    const { enviados, logs } = await correrCron(cron(), { kv: DIRECTORIO_REVISION });
    const esperados = Object.values(ESPERADO_REVISION).filter(Boolean).sort();
    assert.deepEqual(enviados.map((m) => m.phone).sort(), esperados);
    for (const [id, tel] of Object.entries(ESPERADO_REVISION)) {
      if (!tel) assert.ok(logs.some((l) => l.includes(`cita ${id}: no se envia`)), `falta el log de ${id}`);
    }
    for (const l of logs) assert.doesNotMatch(l, /3000000\d{3}/, `log con teléfono completo: ${l}`);
  });
}

// --- Cédula escrita sin dos puntos (formato colombiano habitual) -------------
// El 25-oct-2026 se le indicó al Dr. escribir "CC 52123456" en la descripción
// de una cita hecha a mano; campo() solo leía "CC: …" y la cita se quedaba
// sin recordatorio en silencio. Todo ficticio.
test("cédula sin dos puntos («CC 1000000040», «C.C. 1.000.000.041», «Cédula …») se lee y la cita a mano SÍ recibe recordatorio", async () => {
  const env = fakeEnv();
  const casos = [
    { id: "cc-espacio", desc: "CC 1000000040\ntel: 3000000140", cc: "1000000040", tel: "573000000140" },
    { id: "cc-puntos", desc: "C.C. 1.000.000.041\nCel 3000000141", cc: "1000000041", tel: "573000000141" },
    { id: "cc-palabra", desc: "Cédula 1000000042\ntel: 3000000142", cc: "1000000042", tel: "573000000142" },
    { id: "cc-documento", desc: "  Documento: 1000000043\ntel: 3000000143", cc: "1000000043", tel: "573000000143" },
  ];
  globalThis.__fake = {
    listEvents: async () => casos.map((c, i) =>
      evento({ id: c.id, titulo: `Paciente Ficticia ${i} - control`, desc: c.desc, hora: `11:${String(i * 10).padStart(2, "0")}` })),
  };
  const dia = await fuenteGCal.citasDelDia(env, "26-10-2026");
  const bk = Object.fromEntries(dia.citas.map((c) => [c.id, citaABookingDoc(c)]));
  for (const c of casos) {
    assert.equal(cedulaDeCita(bk[c.id].identification), c.cc, `${c.id}: cédula`);
    const d = await destinoDeRecordatorio(env, bk[c.id]);
    assert.equal(d.telefono, c.tel, `${c.id}: ${d.motivo}`);
  }
});

test("cédula sin dos puntos NO captura texto: «Documento pendiente», «Doc Dra. Ficticia», «CC» suelto siguen sin cédula", async () => {
  const env = fakeEnv();
  const casos = ["Documento pendiente\ntel: 3000000150", "Doc Dra. Ficticia\ntel: 3000000151", "CC\ntel: 3000000152", "cc 1234\ntel: 3000000153"];
  globalThis.__fake = {
    listEvents: async () => casos.map((desc, i) =>
      evento({ id: `nocc-${i}`, titulo: "Agenda de consultas", desc, hora: `12:${String(i * 10).padStart(2, "0")}` })),
  };
  const dia = await fuenteGCal.citasDelDia(env, "26-10-2026");
  for (const c of dia.citas) {
    const d = await destinoDeRecordatorio(env, citaABookingDoc(c));
    assert.equal(d.telefono, "", `${c.id}: ${d.motivo}`);
    assert.match(d.motivo, /sin cédula/);
  }
});
