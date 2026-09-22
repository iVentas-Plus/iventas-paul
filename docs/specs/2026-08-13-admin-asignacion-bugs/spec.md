# MCP de PAUL: asignación correcta, panel de administrador y alta de bugs/ideas

**Fecha:** 2026-08-13 · **Rama:** `feat/admin-y-asignacion`

## 1. Qué es PAUL, en concreto

PAUL (iVentas COACH) vive en `https://iventas.cc/iventas-coach/`. No es un solo
sistema: son **tres planos** montados sobre una única cookie de sesión PHP
(`IVCOACH`), con autenticaciones independientes que **coexisten** en la misma
sesión.

| Plano | Cómo se entra | Qué expone | Escritura |
| --- | --- | --- | --- |
| API de colaborador | `POST api.php?action=login` (JSON) | 55 acciones JSON | Sí |
| Panel de administrador | `POST admin/<página>.php` con `_form=login` | 24 páginas PHP renderizadas en servidor, ~40 mutaciones por formulario HTML | Sí, form-encoded |
| Vista de suplantación | `GET admin/view_as.php?uid=<uid>` | `api.php` empieza a devolver los datos de esa persona | **No** |

Tres hechos verificados contra producción durante esta investigación, porque
ninguno es deducible del código cliente:

1. **Los dos logins son independientes pero conviven.** Autenticarse en
   `api.php` no abre `/admin/`, y autenticarse en `/admin/` deja a `api.php`
   respondiendo `{"error":"no_auth"}`. Hacer ambos sobre la misma cookie
   funciona y ninguno invalida al otro.
2. **`view_as.php` deja la sesión atrapada.** En ese modo toda escritura
   responde `{"error":"read_only"}` — **incluido `action=login`, que devuelve
   403**. La única salida es `GET admin/view_self.php`. Por eso el cliente
   expone `withViewAs(uid, fn)` con `finally`: una sesión abandonada dentro de
   una suplantación no puede escribir nada ni volver a autenticarse.
3. **`view_admin` no significa "soy administrador".** En una sesión normal de
   una cuenta administradora vale `false`; solo se pone en `true` mientras hay
   una suplantación activa. **La API JSON no tiene forma de reportar el rol de
   administrador**: la única detección posible es intentar el login del panel.

## 2. El defecto de asignación

`paul_register_task` afirmaba en su propia descripción:

> *"There is no direct create-task API: this tool talks to PAUL, answers its
> urgency question, and then VERIFIES against the task list…"*

**La premisa es falsa.** Existen tres altas directas, y el MCP no usaba ninguna:

| Acción | Payload | Respuesta | ¿La usa el MCP? |
| --- | --- | --- | --- |
| `peer_assign` | `{title, person_uid, est_min, urgency}` | `{ok, assigned_to}` | No — no devuelve id |
| `assign_confirm` | `{person_uid, title, urgency, client, reason, suggested_uid, est_min}` | `{ok, reply, undo_id, queued}` | **Sí** |
| `ideas_import` | `{items:[{title, est_min, priority, weeks}]}` | `{ok}` (alta masiva) | No — fuera de alcance |

Se probaron **en vivo, en frío** (sin diálogo previo ni `pending_assign` en
sesión) y las dos primeras funcionan. `assign_confirm` es la mejor: su
`undo_id` **es el id de la tarea nueva** — exactamente el dato que la
implementación anterior intentaba deducir.

La tabla documenta el catálogo del servidor, no la superficie del MCP: solo
`assign_confirm` está expuesta. `peer_assign` se descartó porque no devuelve el
id de la tarea creada, y el alta masiva de `ideas_import` no tiene un caso de
uso pedido.

### Qué costaba el camino conversacional

- **Rechazaba títulos legítimos.** Un guardia regex prohibía cualquier título
  con `alta`, `media`, `baja`, `normal`, `regular`, `urgente`… porque dentro de
  un mensaje de chat esa palabra se leía como respuesta a la pregunta de
  urgencia de PAUL. "Dar de alta el bot de Refrimex" era imposible de
  registrar.
- **Podía reportar una tarea ajena como propia.** Un `pending_assign` viejo en
  la sesión PHP podía confirmar una tarea distinta; el código lo llamaba
  `hijackedCommit` y solo sabía reportarlo.
- **Gastaba presupuesto de IA** en 1-2 llamadas a `coach_chat` por cada alta,
  más dos llamadas a `state` para el diff.
- **No sabía asignar a nadie más.** Faltaba `peer_contacts`, así que el MCP no
  tenía forma de obtener un `uid` válido.

### Qué queda en su lugar

`src/tools/assign.ts` con una sola función `assignTask()` sobre
`assign_confirm`, y dos registros delgados encima: `paul_register_task` (a uno
mismo, resolviendo el uid propio desde la respuesta de `login`) y
`paul_assign_task` (a otra persona). Desaparecen el guardia de urgencia, el
matcher difuso de títulos, el diff de estado y toda la taxonomía de fallos que
solo existía por el chat.

**Detalle que el agente debe respetar:** `queued: true` **no es una
asignación**. Significa que el autopiloto está apagado para ese departamento y
PAUL solo encoló una propuesta para que un admin la confirme.

## 3. Corrección adicional encontrada de paso

`red_gate_ack` enviaba como identificador de pregunta la frase
`"¿Qué vas a hacer para que esto no vuelva a pasar?"`. El cliente web real
manda la cadena literal **`mejora`**. El servidor nunca recibe esa frase de su
propia UI, así que depender de ella era apostar a un emparejamiento que no
ocurre. Corregido, con el test actualizado.

## 4. Alcance de la capa de administrador

De cinco alternativas evaluadas se eligió **núcleo curado + escape hatch**: tools
tipadas para lo de alto valor, más dos tools genéricas que alcanzan las 24
páginas sin escribir 24 parsers frágiles.

El panel es HTML sin contrato ni versionado: cada parser dedicado es deuda que
se rompe sola con el próximo cambio de markup, y ningún test puede notarlo.
Por eso `src/admin-parse.ts` es deliberadamente **genérico** — un extractor de
tablas que sirve en todas las páginas — con solo dos parsers específicos
(tareas y colaboradores), que son los que alimentan mutaciones.

### Qué NO se pudo determinar

- **`queue.php`**: las mutaciones de aprobar/rechazar de la cola del
  autopiloto. Ambas colas están vacías en producción, así que su markup no
  existe todavía. Solo se implementó `_form=autopilot`.
- **`objectives.php`**: las acciones por objetivo. No hay ningún objetivo
  creado.
- **`clients.php?c=<slug>`**: la ficha por cliente no se capturó.

Los tres son alcanzables hoy con `paul_admin_page` / `paul_admin_action`.

### Trampas de parseo documentadas en las descripciones de las tools

- En `redflags.php` el conteo semanal se renderiza como 🔴 repetidos, **no**
  como un dígito.
- En `forecast.php` los balances usan **U+2212 MINUS SIGN**, no un guion ASCII.
- En `objectives.php` los `<option>` de `area` no tienen atributo `value`, así
  que el navegador envía el texto de la opción.
- En `findings.php` el descarte va en un **botón submit con nombre**
  (`name="dismiss" value="<id>"`), no en un input oculto: un serializador que
  solo recorra inputs lo pierde.
- `tasks.php` está **acotado a una persona** vía `?u=<uid>`. No existe ninguna
  vista de todos: barrer al equipo son 13 peticiones.

## 5. Bugs, ideas y tips

Ya existían en PAUL; solo faltaba exponerlos.

- **Bug**: el colaborador aporta `title`, `desc` e `images[]`. No hay severidad
  ni categoría: la prioridad entra después, al asignar. Estados: `abierto`,
  `en_proceso`, `resuelto`. El servidor **deduplica**: un reporte equivalente
  se fusiona como nota en un bug existente y responde `grouped: true`, que es
  éxito, no fallo.
- **Idea**: un solo campo `text` (≤400). Son feedback sobre **PAUL mismo**, no
  ítems de trabajo. Estados: `abierta`, `planeada`, `lista`, `descartada`.
- **Tips**: `paul_tips` y `tips?id=<taskId>` son consejos que **PAUL emite**,
  no algo que el usuario da de alta. La confusión importa: un agente podría
  intentar usarlos como función de creación de contenido. Lo que sí es alta de
  contenido es la **base de conocimiento** del panel (`knowledge.php`),
  expuesta como `addKnowledge`/`deleteKnowledge`.

No se expone la subida de imágenes de bugs: requiere multipart y el resto de la
superficie es JSON puro.

## 6. Cobertura

Antes: **9 de 55 acciones (16%)**, 8 tools. Después: el núcleo de tareas,
asignación, cierre, bugs, ideas y tips por API JSON, más el plano de
administración completo por panel.

## 7. Riesgos asumidos

1. **El panel es HTML sin contrato.** Un rediseño rompe los parsers. Mitigado
   con extracción genérica y tests sobre HTML real capturado, pero no
   eliminado. El camino de fondo es pedir un `admin/api.php` JSON del lado PHP.
2. **No hay token CSRF en ninguna forma del panel.** No es un hallazgo de este
   cambio, pero conviene que el equipo de PAUL lo sepa.
3. **Las escrituras de admin no tienen deshacer.** Las descripciones de las
   tools lo dicen explícitamente y la skill prohíbe ejecutarlas sin petición
   del usuario.
