# Bukeala Internal API Reference

Base: `https://appoint.tuscitasmedicas.com/keraltyadscritos`

Todos los requests requieren la cookie de sesión obtenida tras el login CAS. Header común:

```
Cookie: <cookies del dominio appoint.tuscitasmedicas.com>
X-Requested-With: XMLHttpRequest
Accept: application/json, text/javascript, */*; q=0.01
Referer: https://appoint.tuscitasmedicas.com/keraltyadscritos/findAvailability
```

Constantes observadas (cambian según el médico):
- `branchId = 456`
- `companyId = 309`
- `entityCode = 10`
- `attentionType = "P"` (presencial)

---

## 1. `GET /findAvailability/loadBranches`
Sucursales disponibles.

**Query**: `areaCode`, `jsonComponentCodes` (JSON `[]`), `_` (timestamp).
**Response**: `application/json` (forma exacta TBD: ver `/debug/branches`).

---

## 2. `GET /findAvailability/loadComponents`
Lista de especialidades / componentes.

**Query**:
- `branchIdStr` = `456`
- `attentionType` = `P`
- `areaCode` = `""`
- `authorizationCode` = `""`
- `_` = timestamp

**Response**: array de objetos. La forma se confirma en `/debug/components`. Probable estructura:
```json
[
  { "id": 1218, "code": "890239", "name": "MEDICINA GENERAL", "secondExternalCode": "..." },
  ...
]
```

---

## 3. `GET /findAvailability/loadAreaHints`
Áreas (consultorios/sedes) por especialidad.

**Query**:
- `branchIdStr` = `456`
- `componentCode` = código de la especialidad

**Response**: array. Probable: `[{ id, code, name }, ...]`.

---

## 4. `GET /findAvailability/doSearch`
**EL endpoint clave**: devuelve slots disponibles.

**Query**:
- `branchId` = `456`
- `jsonComponentCodes` = `["890239"]` URL-encoded
- `startDateStr` = `04/05/2026` (DD/MM/YYYY)
- `resultShow` = `0`
- `resultGrouped` = `false`
- `isMultipleComponent` = `false`
- `attentionType` = `P`
- `followedBookingsCount` = `1`
- `daysSelected` = `""`
- `timeFrom`, `timeTo` = `""`
- `areaPattern` = `""`
- `minQuantitySessions`, `maxQuantitySessions` = `""`
- `intervalSessions` = `1`
- `isOverBooking` = `false`
- `isOrdered` = `false`
- `authorizationCode` = `""`
- `_` = timestamp

**Response**: array de slots. Cada slot debe contener al menos: `bookingComponentId`, `areaId`, `bookingDateStr` (`DD/MM/YY`), `bookingTime` (segundos desde medianoche), `branchCode`, `bookingComponent.code`, `bookingComponent.secondExternalCode`, `area.code`, `duration`, `preparationMessages` y datos del profesional.

> Confirmar parseo con `/debug/search?date=DD/MM/YYYY&componentCode=XXXXXX`.

---

## 5. `GET /findCustomer/validate/{idType}/{identification}`
Valida paciente.

`idType`:
- `1` (a veces) o `C` para cédula.

**Response**: datos del cliente si existe; vacío o error si no.

---

## 6. `GET /booking/validateBookingDate`
Valida que el slot siga libre.

**Query**:
- `bookingComponentId`
- `startDateStr` = `DD/MM/YY`
- `bookingTime` = segundos
- `validateDaysBetweenBookings` = `true`
- `isOverBooking` = `false`
- `branchId`, `areaId`
- `_` = timestamp

---

## 7. `GET /prebooking/addPrebookingSchedule`
Reserva temporalmente el slot (5–10 min) antes de confirmar.

**Query**:
- `timeInSeconds` (45600 = 12:40 PM)
- `bookingComponentId`
- `startDateStr` = `DD/MM/YY`
- `areaId`
- `followedBookingsCount` = `""`
- `_` = timestamp

---

## 8. `POST /booking/assign`
Carga la pantalla de confirmación. Form-encoded.

**Body**:
```
branchId=456
customerIdentification=63438331
customerIdentificationType=C
customerGender=F
bookingsDataJson=[{"bookingComponentId":1218,"areaId":1074,"dateFormatted":"06/05/26","timeInSeconds":45600,"timeInBetween":""}]
multipleComponentId=
searchParamsJson={...searchParams...}
```

> Para uso del bot, este paso suele ser opcional si vamos directo a `postBooking`. Lo dejamos para cumplir con flujo legítimo.

---

## 9. `POST /booking/postBooking` ⭐
**Crea la cita.** JSON.

**Headers**:
```
Content-Type: application/json
X-Requested-With: XMLHttpRequest
```

**Body** (estructura exacta capturada del HAR):
```json
{
  "bookingsDataJson": "[{\"bookingComponentId\":1218,\"bookingComponentCode\":\"890239\",\"branchCode\":\"7960\",\"unidadOrganizativa\":\"7960\",\"preparationMessages\":[],\"areaId\":1074,\"areaCode\":\"80040718\",\"comment\":\"200\",\"dateFormatted\":\"06/05/26\",\"timeInSeconds\":45600,\"attachmentUrls\":null,\"duration\":20}]",
  "branchId": "456",
  "name": "APELLIDO APELLIDO, NOMBRE NOMBRE",
  "customerIdentification": "1234567890",
  "customerIdentificationType": "C",
  "customerGender": "F",
  "unidadOrganizativa": "7960",
  "branchCode": "7960",
  "email": "paciente@example.com",
  "comment": "",
  "phoneCountryCode": "mx",
  "cellPhone": {
    "id": null,
    "phoneNumber": "3001234567",
    "countryCode": "co",
    "dialCode": "+57"
  },
  "landPhone": null,
  "overBooking": false,
  "followedBookingsCount": 1,
  "isReassign": false,
  "cancelationComment": "",
  "presential": "true",
  "multipleComponentIdStr": ""
}
```

Notas:
- `bookingsDataJson` es **string JSON** dentro del JSON principal (doble encoding).
- `dateFormatted` usa formato corto `DD/MM/YY`.
- `timeInSeconds` es segundos desde medianoche (45600 = 12:40 PM).
- `comment` interno = `"200"` (no es comentario libre del usuario; ese va en el body raíz).
- `phoneCountryCode = "mx"` aunque el `dialCode` sea `+57`. Bug del frontend pero el backend lo acepta así.
- `customerGender` = `F` o `M`.

**Response** (esquema esperado):
```json
{
  "result": { "code": "SUCCESS" | "FAIL" },
  "bookingResults": [{ "result": { "code": "SUCCESS" }, ... }],
  "messages": [{ "code": "...", "description": "..." }],
  "quantitySessions": 0
}
```

---

## 10. `GET /myBookings?historial=true|false`
HTML con la lista de citas del usuario. Parsear con regex o cheerio.

---

## 11. `POST /booking/action/checkBookingCancelation`
Verifica si una cita se puede cancelar.

---

## 12. `GET /booking/action/cancelationReasons`
Lista de motivos para cancelar.

---

## 13. `POST /booking/action/cancelBooking`
Form-encoded.

**Body**:
```
bookingId=...
cancelationReasonId=...
cancelationComment=...
```

---

## Cookies relevantes

Aún no confirmado el nombre exacto. En aplicaciones Java/CAS típicas:
- `JSESSIONID` (HttpOnly)
- `CASTGC` o similar en `app01.colsanitas.com`
- Posiblemente cookies de Cloudflare (`__cf_bm`, etc.)

La extensión captura **todas** las cookies de los dominios configurados, así que esto se resuelve solo.

## Manejo de expiración

El Worker debe detectar:
- HTTP 401, 403
- Redirect 302 a `/cas/login`
- Body con `<title>Login</title>` o palabras clave

Cuando lo detecte, marcar la sesión como inválida y notificar a Telegram.
