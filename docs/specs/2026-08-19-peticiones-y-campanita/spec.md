# MCP de PAUL: sección de Peticiones y campanita de notificaciones

**Fecha:** 2026-08-19 · **Rama:** `feat/admin-y-asignacion` · **Build de PAUL:** `2026.08.18-2 · hilos-campanita` (`app_version: 31`)

## 1. Qué cambió en PAUL

PAUL estrenó una sección completa llamada **Peticiones**, y con ella una
campanita de notificaciones. El propio encabezado de la sección lo dice:

> 🆘 **Peticiones del equipo** — Un solo lugar para pedir: 🐞 bugs · 💡 ideas ·
> 🔧 mejoras · 🆘 soporte. **El 💵 manda**: la fila se ordena por lo que cada
> petición trae o evita perder al mes.

Es decir: los tableros viejos de **bugs** e **ideas** dejaron de ser el sitio
donde se pide algo. Siguen vivos, pero el pie de la sección nueva los enlaza ya
etiquetados como *histórico*, y la sección nueva ofrece **migrar** una fila
vieja hacia la fila nueva.

Lo que cambia de fondo no es la UI, es el criterio de priorización. Antes una
idea subía por **votos** y un bug por **cuántas personas lo reportaron**. Ahora
cada petición declara un número en dólares —lo que trae al mes o lo que evita
perder— y ese número, multiplicado por los meses que duraría el efecto, es el
valor con el que compite contra las demás.

### Las siete acciones nuevas de la API

Todas viven en `api.php?action=...`, sobre la misma sesión `IVCOACH` que ya usa
el MCP. Cada una fue **probada contra producción**; lo de abajo es lo observado,
no lo deducido del cliente.

| Acción | Cuerpo | Respuesta observada | Errores observados |
| --- | --- | --- | --- |
| `req_list` | `{}` | `{reqs[], can_assign, team[]}` | — |
| `req_create` | `{kind, title, detail, money_kind, money_other, money_month, months_min, urgency, migrate_src?, migrate_id?}` | `{ok:true, id}` | `400 bad_kind`, `400 short` |
| `req_thread` | `{id}` | `{ok, req, comments[], roster[]}` | `404 not_found` |
| `req_comment` | `{id, body, mentions[]}` | `{ok, id, first, at, mentioned, had_at}` | `400 empty` |
| `req_take` | `{id}` | `{ok, assigned_to, task_id}` | `409 bad_status` |
| `req_assign` | `{id, person_uid, urgency}` | `{ok, assigned_to, task_id}` | `400 bad_person`, `409 bad_status` |
| `req_status` | `{id, status, reason}` | `{ok:true}` | `404 not_found`, `400 bad_status` |

Más la campanita:

| Acción | Cuerpo | Respuesta observada |
| --- | --- | --- |
| `notifs_list` | `{}` | `{ok, notifs[], unseen}` |
| `notifs_seen` | `{}` | `{ok:true}` |

Y `state` ganó tres campos: `notifs_new` (campanita sin leer), `build` y
`app_version`.

## 2. Los cinco hallazgos que no eran deducibles

Todos verificados en vivo. Cada uno se convirtió en una decisión de código.

### 2.1 PAUL **no** valida `urgency` — la degrada en silencio

Se envió `urgency: "altisima"` a `req_create`. La respuesta fue `200 {ok:true, id:3}`,
y al releer la petición con `req_thread` su urgencia era **`media`**.

Eso es peor que un error: una petición que el usuario pidió como *urgente* puede
quedar como *media* sin que nada lo reporte. En cambio `kind` sí se valida
(`400 bad_kind`) y el título también (`400 short` con menos de 6 caracteres).

**Decisión:** el enum de `urgency` se cierra en el esquema del MCP
(`urgente | alta | media | baja`). Cualquier otra cosa se rechaza en la capa de
protocolo, sin llegar a PAUL.

### 2.2 `req_take` y `req_assign` **crean una tarea real**

No son un cambio de etiqueta. Ambas responden con `task_id`, y ese id existe en
el tablero de misiones de la persona:

```
req_take   {"id":3} → {"ok":true,"assigned_to":"Arturo García","task_id":954}
req_assign {"id":4,"person_uid":"arturo","urgency":"alta"}
                   → {"ok":true,"assigned_to":"Arturo García","task_id":955}
```

Y **descartar la petición después no borra esa tarea**: se verificó leyendo
`state` tras poner la petición en `descartada`, y las tareas 954 y 955 seguían
en la fila (se eliminaron a mano con `delete_task`).

**Decisión:** la descripción de `paul_request_action` lo dice explícitamente y
apunta a `paul_task_action` action `delete` para limpiar la tarea huérfana.

### 2.3 Las @menciones por texto **no suenan** cuando el nombre es ambiguo

El roster tiene dos Diegos: `diegoc` (Diego Cruz) y `diegol` (Diego León).
Escribir `@Diego` en el cuerpo de un comentario no le suena la campanita a
ninguno de los dos. Lo que realmente notifica es el arreglo `mentions` con
**uids exactos**; el `@Nombre` del texto es solo presentación.

PAUL lo reporta: la respuesta trae `had_at: true` (el cuerpo tenía una arroba) y
`mentioned: 0` (no le sonó a nadie). El comentario **sí** se publicó.

**Decisión:** `paul_request_thread` calcula y devuelve `ambiguous_first_names`
(los nombres de pila repetidos en el roster) para que el agente sepa cuáles no
puede usar a ciegas, y `paul_comment_request` devuelve un `warning` explícito
cuando `had_at && mentioned === 0`, diciendo que **reenviar el comentario no es
la solución** — agregar los uids sí.

### 2.4 `req_status` solo escribe dos valores, y no hay máquina de estados

`hecha` y `descartada` se aceptan. `nueva` responde `400 bad_status`: una
petición cerrada **no se puede reabrir** por esta vía. Pero tampoco hay
transiciones protegidas: se pasó una petición de `hecha` a `descartada` sin
queja.

### 2.5 `money_kind: "otro"` significa "sin monto"

La UI oculta los campos de dinero cuando se elige *Otro* y muestra
`Se priorizará por contexto: 🏢 Cliente Grande (sin monto, los admins evalúan el 💵)`.

**Decisión:** `paul_create_request` **descarta** `usdPerMonth` cuando
`moneyKind` es `otro`, en vez de mandar un número que el tablero renderizaría
como un valor que la petición no tiene.

## 3. Superficie nueva del MCP

Seis herramientas, siguiendo el estilo de la casa: un listado por sección, un
alta, y un despachador para las acciones que comparten forma
(igual que `paul_task_action`).

| Herramienta | Acción de PAUL | Para qué |
| --- | --- | --- |
| `paul_requests` | `req_list` | La fila completa agrupada por estado, con el desglose de dinero y el roster asignable |
| `paul_create_request` | `req_create` | Levantar una petición (bug, idea, mejora o soporte), con o sin monto; también migra filas históricas |
| `paul_request_thread` | `req_thread` | Leer una petición y todo su hilo, más el roster y los nombres ambiguos |
| `paul_comment_request` | `req_comment` | Comentar en el hilo, con menciones por uid |
| `paul_request_action` | `req_take` · `req_assign` · `req_status` | `take` · `assign` · `done` · `discard` |
| `paul_notifications` | `notifs_list` · `notifs_seen` | Leer la campanita; `markSeen: true` la limpia (opt-in explícito) |

Decisiones de forma:

- **`paul_requests` no se confunde con `requests()`.** Ya existía en el cliente
  un `action=requests` que lista **tareas que delegaste a otros** — cosa
  distinta, que comparte la palabra en inglés y nada más. Se documentó en el
  código y no se expuso como herramienta.
- **La campanita lee sin escribir por defecto.** `notifs_seen` marca *todas*
  las notificaciones como leídas y no se puede deshacer, así que solo corre con
  `markSeen: true`. Además, si esa marca falla, las notificaciones ya leídas se
  devuelven igual con `marked_seen: false` — perder el listado por no poder
  limpiar la campana sería el peor de los dos resultados.
- **Los tableros históricos apuntan al nuevo.** `paul_report_bug` y
  `paul_create_idea` ahora dicen en su descripción que se prefiera
  `paul_create_request`, y `paul_bugs` / `paul_ideas` explican cómo migrar una
  fila con `migrateSrc` + `migrateId`. No se quitó nada: siguen funcionando.
- **`paul_tasks` expone `notifs_new`**, para que una @mención pendiente no sea
  invisible para el agente.

## 4. Pruebas

**Unitarias (`vitest`, `fetch` mockeado — nunca tocan un servidor real):**
298 pruebas en verde, 52 de ellas nuevas. Cubren las seis capas:

| Capa | Ejemplos |
| --- | --- |
| Positiva | cada acción manda su `action=` correcta y su cuerpo exacto; agrupación por estado con conteos |
| Negativa | `400 short`, `400 bad_kind`, `400 bad_person`, `400 empty`, `404 not_found`, `409 bad_status`, y un `{ok:false}` con 200 que se reporta como error |
| Frontera | título 5/6/200/201, detalle 2000/2001, comentario 0/1/1000/1001, meses 0/1/60/61, monto −1/0, fila vacía |
| Propiedad | los conteos por estado siempre suman el total, y ninguna fila se pierde aunque PAUL invente un estado nuevo |
| Fuzzing | `reqs` que no es arreglo, fila con todos los campos en `null`, `ref` no numérico, cuerpo con texto de inyección de prompt (se envía tal cual, nunca se interpreta) |
| Robustez | caída de transporte, `no_auth` con re-login y reintento, fallo al marcar la campanita sin perder el listado |

**End-to-end contra PAUL en producción**, hablando MCP real por stdio contra
`dist/index.js`: 16 comprobaciones, todas en verde. Incluyen el ciclo completo
`create → comment → take → done → discard` sobre una petición desechable, y la
limpieza de la tarea que `take` creó.

Filas de prueba creadas durante la investigación (#3, #4, #5): las tres quedaron
en estado **descartada** con motivo explícito, y las tres tareas que generaron
(954, 955, 956) se borraron.

## 5. Lo que NO se tocó

El panel de administrador no cambió: sigue teniendo las mismas 24 páginas y
ninguna de Peticiones, así que `ADMIN_PAGES` queda igual.

PAUL también expone acciones que este MCP sigue sin cubrir, y que quedan fuera
de alcance por no ser parte de la sección de Peticiones: el chat de canal
(`channel_send`), los mensajes directos entre compañeros (`peer_send`,
`peer_buzz`), los clientes (`clients_all`, `client_kpis_get`, `client_charge`,
`save_client_brief`), los uno-a-uno (`oneonone_done`, `oneonone_snooze`), las
pausas (`pause_start`, `pause_end`), el ánimo (`set_mood`), los avisos
(`notice_draft`, `notice_send`) y el histórico del coach (`coach_history`).
