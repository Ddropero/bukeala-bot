/**
 * Feriados colombianos (Ley Emiliani).
 *
 * Calculados dinámicamente para cualquier año:
 *   - Fijos: 1 enero, 1 mayo, 20 julio, 7 agosto, 8 diciembre, 25 diciembre
 *   - Móviles (Ley Emiliani, se trasladan al lunes siguiente si no caen en lunes):
 *       Reyes Magos (6 enero), San José (19 marzo), San Pedro y San Pablo (29 junio),
 *       Asunción (15 agosto), Día de la Raza (12 octubre), Todos los Santos (1 noviembre),
 *       Independencia de Cartagena (11 noviembre)
 *   - Basados en Pascua:
 *       Jueves Santo (-3), Viernes Santo (-2),
 *       Ascensión (Emiliani, +43), Corpus Christi (Emiliani, +64),
 *       Sagrado Corazón (Emiliani, +71)
 *
 * Algoritmo de Pascua: Anonymous Gregorian (Meeus).
 *
 * Todas las fechas en formato YYYY-MM-DD (zona horaria America/Bogota).
 */

/**
 * Calcula la fecha del Domingo de Pascua para un año dado.
 * Algoritmo: Anonymous Gregorian (Meeus).
 */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** Suma días a una fecha (UTC). */
function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Traslada un feriado al lunes siguiente si no cae en lunes (Ley Emiliani).
 * Domingo (0) → +1; Lunes (1) → +0; Martes (2) → +6; etc.
 */
function emilianiShift(date: Date): Date {
  const dow = date.getUTCDay(); // 0=Dom, 1=Lun, ..., 6=Sab
  if (dow === 1) return date;
  const daysUntilMonday = (8 - dow) % 7 || 7;
  return addDays(date, daysUntilMonday);
}

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Devuelve un Set con todas las fechas feriadas de Colombia para un año
 * en formato YYYY-MM-DD.
 */
export function getColombianHolidays(year: number): Set<string> {
  const holidays = new Set<string>();

  // Fijos
  holidays.add(`${year}-01-01`); // Año Nuevo
  holidays.add(`${year}-05-01`); // Día del Trabajo
  holidays.add(`${year}-07-20`); // Independencia
  holidays.add(`${year}-08-07`); // Batalla de Boyacá
  holidays.add(`${year}-12-08`); // Inmaculada Concepción
  holidays.add(`${year}-12-25`); // Navidad

  // Móviles (Emiliani)
  const emilianiFixed: [number, number][] = [
    [1, 6],    // Reyes Magos
    [3, 19],   // San José
    [6, 29],   // San Pedro y San Pablo
    [8, 15],   // Asunción de la Virgen
    [10, 12],  // Día de la Raza
    [11, 1],   // Todos los Santos
    [11, 11],  // Independencia de Cartagena
  ];
  for (const [mo, day] of emilianiFixed) {
    const d = new Date(Date.UTC(year, mo - 1, day));
    holidays.add(toISODate(emilianiShift(d)));
  }

  // Basados en Pascua
  const easter = easterSunday(year);
  holidays.add(toISODate(addDays(easter, -3))); // Jueves Santo
  holidays.add(toISODate(addDays(easter, -2))); // Viernes Santo
  holidays.add(toISODate(emilianiShift(addDays(easter, 39)))); // Ascensión (40 días tras Pascua, contando)
  holidays.add(toISODate(emilianiShift(addDays(easter, 60)))); // Corpus Christi
  holidays.add(toISODate(emilianiShift(addDays(easter, 68)))); // Sagrado Corazón

  return holidays;
}

/**
 * ¿Es feriado en Colombia? Acepta Date o string YYYY-MM-DD.
 */
export function isColombianHoliday(date: Date | string): boolean {
  const iso = typeof date === "string" ? date : toISODate(date);
  const year = parseInt(iso.slice(0, 4), 10);
  return getColombianHolidays(year).has(iso);
}
