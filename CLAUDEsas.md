# CLAUDE.md — SaaS Multinegocio (Inventario, Ventas, Multisucursal y SuperAdmin)

## 1. Propósito y alcance
SaaS **multinegocio de inventario y ventas** para tiendas físicas: joyerías, ropa, zapatillas, comercios en general y **tiendas mixtas** (por ejemplo, ropa más chocolates o bebidas). Debe adaptarse a cada rubro **sin desarrollos a medida por cliente**.

Reglas de negocio no negociables:
- **Sin planes rígidos.** No modelar Pro, Simple, Empresarial ni Enterprise. Las funciones, adicionales y estados de cuenta se controlan por cuenta desde el panel **SuperAdmin** (feature flags y límites configurables).
- **SUNAT es opcional.** Una cuenta se crea y opera con correo y contraseña, con comprobantes internos. La facturación electrónica con **certificado digital** es un adicional que el SuperAdmin activa por cuenta (fase posterior). Nunca hacer SUNAT obligatoria para arrancar.
- **Multidispositivo y PWA instalable** para POS, celulares, tablets, laptops y escritorio.
- **Debe funcionar sin internet** (ver sección 4).

## 2. Stack
- Next.js (App Router) + TypeScript estricto.
- **Neon (PostgreSQL serverless)** con Prisma. Si se propone otro ORM, documentarlo en `DECISIONES.md`.
- Despliegue en **Vercel**. **Render solo si es estrictamente necesario** (por ejemplo, un worker o tareas programadas); justificar cada uso en `DECISIONES.md`.
- Variables de entorno separadas por entorno (desarrollo y producción), con `.env.example` siempre actualizado. Nunca commitear secretos.

## 3. Arquitectura y aislamiento multi-tenant
- Separar presentación (UI/PWA), lógica de negocio/API y persistencia.
- **Todas las tablas de negocio llevan `tenant_id`** (y `branch_id` cuando aplique), con Row Level Security en Neon **y** filtrado obligatorio en cada query.
- **El `tenant_id` sale de la sesión en el servidor, nunca del cliente.** Ningún endpoint acepta un `tenant_id` enviado por el usuario como fuente de verdad.
- Validar en el backend, en cada operación sensible: autenticación, rol (RBAC), pertenencia a sucursal y **estado de la cuenta** (suspendida o eliminada = sin acceso).
- No confiar en ocultar botones en el frontend como medida de seguridad.
- Registrar en auditoría las acciones sensibles (SuperAdmin, ajustes de stock, anulaciones, cambios de precio).
- Documentar en `DECISIONES.md` cada decisión de arquitectura y cada cambio de esquema.

## 4. Offline-first (requisito obligatorio)
- Service worker con caché de la app; datos locales en **IndexedDB** (catálogo, precios, stock, clientes frecuentes).
- **Cola de operaciones pendientes** (ventas, ingresos, ajustes, traslados) con sincronización automática al reconectar. Cada operación lleva una **clave de idempotencia** para que reenviarla no duplique datos.
- El stock es un **libro de movimientos (kárdex)**, no un número que se sobrescribe; así las operaciones offline de distintos dispositivos se combinan sin perder datos.
- Conflictos: regla definida y documentada (orden por marca de tiempo; si el stock resultante queda negativo, alertar al supervisor).
- Numeración de comprobantes por serie de dispositivo o sucursal para evitar choques offline.
- Indicador visible de estado: en línea, sin conexión, sincronizando, con pendientes.
- Las alertas (sección 7) también deben calcularse con datos locales.
- Todo lo que requiere internet (agente de IA, envío por WhatsApp o correo) debe degradarse con un mensaje claro sin romper el resto.

## 5. Panel SuperAdmin (dueño del SaaS)
Control global sobre todos los negocios:
- **Cuentas:** crear (correo y contraseña inicial, con **cambio obligatorio en el primer ingreso**), **suspender**, reactivar y **eliminar**. La eliminación es lógica (soft delete) con respaldo previo y confirmación. No dejar credenciales por defecto en el código.
- **Adicionales y ajustes puntuales** por cuenta mediante feature flags.
- **Agente de IA por negocio:** activar o desactivar, y fijar un **límite de consumo** en dólares (valor por defecto 1 USD, editable) o en tokens, con costo por modelo configurable. Al llegar al límite el agente se bloquea y avisa al negocio. El SuperAdmin ve el consumo acumulado por cuenta.
- **Alertas** de vencimiento y de bajo stock: activar o desactivar por cuenta.
- **Facturación electrónica SUNAT:** activar o desactivar por cuenta cuando esté implementada.
- Métricas globales (cuentas activas, uso, consumo de IA, estado de sincronización) y registro de auditoría de sus acciones.

## 6. Roles, permisos y multisucursal
- **Administrador / Dueño:** negocio, sucursales, usuarios, precios, reportes y configuraciones permitidas.
- **Supervisor:** aprobar ajustes y traslados, revisar caja, seguimiento de stock.
- **Vendedor:** POS, consulta de inventario y ventas según permisos.
- **Multisucursal:** cada sucursal opera su inventario local y puede **consultar el stock de las demás** (solo lectura). Los traslados siguen el flujo solicitud, envío y recepción, con aprobación del supervisor.

## 7. Inventario y alertas
- **Ingreso:** manual, **masivo** (Excel/CSV con plantilla y validación) y escaneo del **QR de boleta o factura**.
- **Identificadores autogenerados:** si el producto no trae SKU, código de barras o QR, generar uno único, listo para imprimir en etiquetas.
- **Variantes y atributos dinámicos por categoría** (talla, color, modelo, material, kilates, peso, etc.), definidos por cada negocio **sin cambiar el esquema de la base de datos** (tabla de atributos o JSONB validado).
- **Cámara** del celular o tablet para escanear códigos de barras y QR en ventas **y en ingreso de inventario**, además de lector físico y búsqueda manual.
- **Kárdex** completo: entradas, salidas, ajustes, traslados y mermas, con usuario, fecha y motivo.
- Conteo físico con conciliación y ajustes aprobados por el supervisor.
- **Tres alertas automáticas y opcionales, visibles en el panel principal** (con contador y acceso al listado):
  1. Productos **vencidos**.
  2. Productos **por vencer** (días de anticipación configurables).
  3. Productos con **bajo stock** (mínimo configurable por producto).
- El control de vencimiento se activa **por producto o categoría**; los productos sin vencimiento (ropa, joyas) nunca están obligados a usarlo. Soportar **lotes** con fecha propia y sugerir en la venta el lote que vence primero (FEFO).

## 8. Punto de venta (POS) y caja
- Ventas con **cámara** o **pistola de escáner**, o búsqueda manual; descuentos y pago mixto.
- Medios de pago: efectivo, billeteras digitales (Yape, Plin), tarjetas y transferencias.
- Apertura, cierre y cuadre de caja por turno y medio de pago.
- Cambios, devoluciones y vales, con permiso de supervisor.
- Comprobantes internos imprimibles (ticket y A4).
- Interfaz táctil y rápida, usable en pantallas pequeñas.

## 9. Agente de IA para consulta de stock
- Responde en lenguaje natural sobre stock por producto, variante, sucursal, vencimientos y bajo stock.
- **Solo lectura.** Accede solo a los datos del propio negocio mediante herramientas acotadas por `tenant_id`. Nunca modifica datos ni ve otros negocios.
- Sujeto al límite de consumo definido por el SuperAdmin, con registro de uso por consulta.

## 10. Reportes
Ventas por periodo, sucursal, vendedor y producto; valorización de inventario; rotación; productos sin movimiento; mermas y vencidos; cierres de caja. Exportación a Excel y PDF.

## 11. Estándares de trabajo para Claude Code
- Leer los archivos relevantes antes de proponer o aplicar cambios.
- Cambios incrementales, modulares y tipados, coherentes con el resto del proyecto.
- Al tocar endpoints, esquema de base de datos o autenticación, verificar casos borde: fuga entre tenants, sucursal sin permisos, cuenta suspendida, producto sin código previo, producto sin vencimiento, operación offline repetida (idempotencia) y stock negativo.
- Mantener pruebas para las reglas críticas: aislamiento entre tenants, permisos por rol, kárdex, sincronización offline y límite de IA.
- Migraciones de base de datos versionadas y reversibles cuando sea posible; nunca editar una migración ya aplicada.
- Tras cada entrega, resumir qué se cambió, qué archivos se tocaron y qué verificaciones faltan.
- Ante una duda no bloqueante, elegir la opción más razonable, anotarla en `DECISIONES.md` y continuar.

## 12. Hoja de ruta (marcar al completar cada fase)
- [x] 1. Fundamentos: Next.js, Neon, esquema, multi-tenant, auth, RBAC, PWA base
- [x] 2. SuperAdmin: cuentas, suspensión y eliminación, feature flags, auditoría
- [x] 3. Inventario: productos, atributos, códigos y etiquetas, carga manual y masiva, kárdex, lotes
- [x] 4. POS: ventas, cámara, caja y cuadre, comprobantes internos, devoluciones
- [x] 5. Multisucursal: stock entre sedes y traslados con aprobación
- [x] 6. Alertas en el panel principal
- [x] 7. Offline-first: IndexedDB, cola de sincronización, conflictos
- [x] 8. Agente de IA con límite de consumo
- [x] 9. Reportes, pruebas, documentación y guía de despliegue
- [x] 10. Extensión: QR de boleta o factura y facturación SUNAT con certificado digital — *QR implementado; SUNAT solo preparada (configuración cifrada y cola): la emisión electrónica sigue pendiente*

## 13. Comandos y estructura

### Comandos
| Acción | Comando |
|---|---|
| Instalar (genera Prisma) | `npm install` |
| Desarrollo (sin service worker) | `npm run dev` |
| Build de producción + service worker | `npm run build` y `npm start` |
| Lint / tipos | `npm run lint` · `npm run typecheck` |
| Pruebas (requiere `TEST_DATABASE_URL` y `TEST_DIRECT_URL`; borra esa base) | `npm test` |
| Aplicar migraciones | `npm run db:migrate` |
| Contraseña del rol `saas_app` | `npm run db:role` |
| Crear SuperAdmin | `npm run superadmin:create` |
| Cuenta demo con productos de ejemplo | `npm run db:seed:demo` |
| Nueva migración (desarrollo) | `npm run db:migrate:dev -- --name <nombre>` |

### Estructura
```
prisma/            schema.prisma y migraciones (la de RLS contiene políticas, grants y trigger de stock)
scripts/           rol de BD, SuperAdmin, cuenta demo, service worker, íconos
src/shared/        reglas usadas por cliente y servidor: operaciones, permisos, stock/FEFO, alertas, totales
src/server/        db (contexto RLS), auth, platform (SuperAdmin)
  domain/          sync (motor de operaciones), ventas, inventario, traslados, caja, catálogo, importación, consultas
  api/             tabla de rutas y control de acceso (una sola ruta: app/api/[...path])
  ai/ reports/ sunat/
src/client/        IndexedDB, sincronización, estado local y componentes
src/app/           app/ (PWA del negocio, estática) · super/ (SuperAdmin) · login
src/sw/sw.js       plantilla del service worker (public/sw.js se genera)
tests/             aislamiento, permisos, kárdex, sincronización, límite de IA
docs/              despliegue y manual
```

### Reglas al extender
- Acceso a datos solo con `withTenant(ctx.tenantId, …)`; nunca crear otro cliente Prisma.
- Tabla de negocio nueva: `tenantId`, política RLS, `GRANT` y, si aplica, añadirla a `BACKUP_MODELS` (`src/server/platform.ts`).
- Mutación nueva de stock, ventas o caja: definirla en `src/shared/operations.ts`, registrarla en `src/server/domain/sync.ts` y reflejarla en `src/client/local.ts`.
- Navegación interna de la app con `<a href>` (se resuelve desde la caché sin red).
