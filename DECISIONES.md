# Decisiones

Fecha de construcción: 2026-11-26. Las fases se ejecutaron seguidas; aquí se resume cada una.

## Generales

- La especificación del proyecto es `CLAUDEsas.md` (no se renombró). Del `CLAUDE.md` de la carpeta personal, que describe otro proyecto, se aplicaron solo las reglas de seguridad; su mención a Supabase no aplica: aquí se usa **Neon** con RLS.
- Interfaz, mensajes y documentación en español. Moneda PEN, zona horaria America/Lima.
- **Dependencias** y su motivo: `next`, `react`, `typescript` (stack); `prisma`, `@prisma/client`, `@prisma/adapter-pg`, `pg` (ORM sobre TCP, compatible con el pooler de Neon y con PostgreSQL local); `zod` (validación compartida); `@anthropic-ai/sdk` (agente); `exceljs` (plantilla, importación y exportación Excel); `pdf-lib` (PDF sin binarios); `bwip-js` (códigos de barras y QR, también sin red); `@zxing/browser` y `@zxing/library` (cámara donde no existe `BarcodeDetector`, p. ej. iOS). Desarrollo: `vitest`, `tsx`, `eslint`.
- Sin librerías para sesiones, contraseñas (scrypt de Node), IndexedDB, service worker ni estilos (CSS propio): menos superficie.
- `npm audit` reporta avisos transitivos en `effect` (usado por la CLI de Prisma al leer nuestra configuración) y `uuid` (dentro de `exceljs`, sin pasar el búfer afectado). No se aplicó `--force` porque retrocede versiones mayores. Revisar al actualizar.
- **Render no se usa.**

## Fase 1 · Fundamentos

- **Aislamiento en dos capas:** cada consulta filtra por `tenantId` y además RLS (`FORCE`) en la base. La app usa el rol `saas_app` sin `BYPASSRLS` y verifica esto al arrancar. `app.tenant_id` se fija por transacción desde la sesión del servidor.
- El contexto de plataforma (`app.platform`) solo abre `Tenant`, usuarios, sesiones, auditoría, respaldos, precios y consumo de IA; **no** las tablas de negocio.
- Claves foráneas compuestas `(tenantId, id)` en las relaciones principales; las referencias opcionales (lote, cliente) se validan en el servidor.
- Sesiones propias en base de datos (token aleatorio, se guarda su hash), cookie `httpOnly` `SameSite=Lax`; 7 días para negocios (jornadas sin red), 8 h para SuperAdmin. Límite: 5 fallos por correo y 30 por IP en 15 min (la IP viene de `x-forwarded-for`, fiable en Vercel).
- CSRF: se exige mismo origen en peticiones que modifican datos.
- RBAC por permisos (`src/shared/permissions.ts`); una sola ruta API con tabla de rutas que centraliza autenticación y estado de cuenta.
- La app de negocio es **estática y cliente** (`/app/*`): el HTML no contiene datos, por eso puede guardarse sin riesgo para uso sin red. El SuperAdmin es renderizado en servidor y nunca se cachea.

## Fase 2 · SuperAdmin

- Sin planes: `Tenant.features` (JSON validado) con interruptores y límites; solo la plataforma puede escribirlo (RLS).
- Alta atómica: cuenta, administrador, sucursal, ajustes y categorías según rubro.
- Eliminación lógica con confirmación y respaldo previo (JSON gzip en la base, descargable). No incluye contraseñas ni secretos SUNAT. No se implementó restauración automática.
- Auditoría de solo inserción.

## Fase 3 · Inventario

- Atributos dinámicos: definición en `Category.attributes`, valores en JSONB de producto o variante, validados en servidor. No requiere cambios de esquema.
- Códigos generados: EAN-13 interno con prefijo `2` y SKU `CAT-000001`.
- **Kárdex inmutable** (`StockMovement`, sin UPDATE ni DELETE para la app). `StockBalance` es un saldo derivado que mantiene un trigger.
- El vencimiento se controla por producto; la categoría fija el valor inicial y, al cambiarlo, se aplica a sus productos.
- Costo promedio ponderado al ingresar mercadería con costo.
- Importación todo-o-nada con validación previa; máximo 2000 filas y 4 MB.
- Crear o editar productos y categorías requiere conexión (evita conflictos de códigos).

## Fase 4 · Punto de venta

- Toda mutación de stock, ventas y caja es una **operación** con UUID; con o sin red pasa por el mismo código del servidor.
- Venta exige caja abierta en la interfaz. Si una venta offline llega sin caja válida, se registra y se marca: una venta ocurrida no se pierde.
- Precios: sin permiso de precios se acepta el vigente, o uno anterior reemplazado hace menos de 60 días (venta offline), y se avisa. Límite conocido: un vendedor con un cliente modificado podría usar un precio reciente anterior; quedará en avisos.
- El descuento del vendedor se limita (configurable) en dispositivo y servidor.
- Se registra en caja lo que queda (el vuelto se descuenta). Arqueo ciego: el vendedor no ve lo esperado antes de contar.
- Devoluciones proporcionales a lo cobrado, al lote de origen; “no vendible” genera merma. Cambios = devolución con vale + venta nueva.
- Ticket: el alto de página se estima según las líneas (CSS no permite alto automático).

## Fase 5 · Multisucursal

- Flujo solicitud → aprobación (supervisor de origen) → envío → recepción. El stock sale al enviar y entra al recibir; lo no recibido queda como merma en destino, con aviso.
- Otras sucursales se consultan en solo lectura. Sin la función activa, la cuenta opera una sola sede.
- La aprobación requiere conexión.

## Fase 6 · Alertas

- Una única función (`computeAlerts`) para dispositivo y servidor. Alerta efectiva = habilitada por el SuperAdmin **y** por el administrador.
- Bajo stock: cantidad ≤ mínimo, por sucursal, solo productos con mínimo > 0. Vencimiento: solo productos que lo controlan y lotes con existencias.

## Fase 7 · Offline-first

- IndexedDB: copia por usuario y sucursal, cola de operaciones y correlativo. Service worker propio; precarga todas las pantallas y archivos tras cada build.
- **Idempotencia:** `SyncOperation (tenantId, id)` guardada en la misma transacción que los efectos, con hash del contenido. Reenviar devuelve el mismo resultado; la misma clave con otros datos se rechaza.
- **Conflictos:** las operaciones se aplican en orden de envío por dispositivo. El stock es suma de movimientos, así que los de varios equipos se combinan. `occurredAt` es la hora del dispositivo, corregida si está en el futuro o tiene más de 45 días. Stock negativo → se acepta y avisa al supervisor. Operación inválida → `REJECTED`, sin efectos parciales, con aviso que conserva los datos. Conteos: se concilian contra el saldo a la hora del conteo.
- Errores inesperados no marcan rechazo: se reintenta.
- Numeración: serie por dispositivo y sucursal (`T01-01`) asignada por el servidor; requiere conexión la primera vez. Una venta rechazada deja un salto de correlativo.
- Cada usuario envía solo sus propias operaciones, desde su sesión.
- Límites: la descarga es completa (no incremental), adecuada para catálogos de unos pocos miles de variantes; para volúmenes mayores habrá que sincronizar por cambios. Los datos locales no están cifrados.

## Fase 8 · Agente de IA

- API Messages de Claude con ciclo propio, para verificar el límite antes de cada llamada. Modelo `claude-haiku-5-5` por defecto (`AI_MODEL`), esfuerzo `low`: es el que más consultas permite dentro del tope de 1 USD por cuenta (ajuste del 2026-11-26; antes `claude-opus-5-5`).
- Cuatro herramientas de solo lectura sin parámetro de negocio, ejecutadas en transacciones `READ ONLY` bajo RLS. No exponen costos.
- **Límite:** antes de llamar se reserva el costo del peor caso (con bloqueo por negocio) y se recorta `max_tokens` a lo disponible; luego se liquida el consumo real. El conteo previo de tokens es una estimación (se añade margen).
- **Sin reintento con otro modelo** (ajuste del 2026-11-26) y sin reintentos del SDK: cada llamada usa un solo modelo y tiene una sola reserva. Si el servicio falla o rechaza la consulta, el usuario recibe un mensaje para volver a intentarlo.
- La entrada se limita a 90 000 tokens por llamada, porque `claude-haiku-5-5` tiene un precio mayor desde 100 000.
- No usar `claude-haiku-4-5` en `AI_MODEL`: no admite el parámetro de esfuerzo empleado.

## Fase 9 · Reportes y cierre

- Nueve reportes con un formato común; exportación en servidor a Excel y PDF; textos protegidos contra fórmulas.
- Pruebas contra PostgreSQL real con las migraciones y el rol restringido.

## Fase 10 · QR de comprobantes y SUNAT

- El QR peruano trae RUC, tipo, serie, número, IGV, total y fecha, **no el detalle**: precarga el documento y evita ingresarlo dos veces.
- SUNAT queda **preparada, no implementada**: activación por cuenta, configuración y certificado cifrados (AES-256-GCM), cola `ElectronicDocument` e interfaz `InvoiceProvider`. Falta generar el XML UBL, firmarlo, enviarlo a SUNAT/OSE, notas de crédito y reintentos.
