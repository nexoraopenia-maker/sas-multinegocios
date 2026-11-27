# Guía de despliegue (Neon + Vercel)

## 1. Base de datos en Neon

1. Crea un proyecto en Neon (elige una región cercana a la de tus funciones en Vercel).
2. Del panel **Connect** copia dos cadenas de conexión del usuario propietario:
   - la **directa** (sin `-pooler`) → `DIRECT_URL`;
   - la **agrupada** (con `-pooler`) → base para `DATABASE_URL`.
3. En `DATABASE_URL` cambia el usuario a `saas_app` y pon una contraseña nueva y larga (inventada por ti; codifica en URL los caracteres especiales).

> La aplicación **debe** conectarse como `saas_app`. El propietario de Neon puede saltarse Row Level Security; si se usa en `DATABASE_URL`, la aplicación se niega a funcionar.

## 2. Inicializar la base (desde tu computadora)

```bash
npm install
cp .env.example .env.local     # DATABASE_URL, DIRECT_URL, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD
npm run db:migrate
npm run db:role
npm run superadmin:create
```

Borra `SUPERADMIN_PASSWORD` de `.env.local` al terminar. Crea el rol `saas_app` con estos comandos, no desde la consola de Neon: los roles creados en la consola pueden omitir RLS.

## 3. Vercel

1. Sube el proyecto a un repositorio privado e impórtalo en Vercel (framework: Next.js). Comando de build: `npm run build` (ya genera Prisma y el service worker).
2. Variables de entorno (entorno **Production**; usa otra base o rama de Neon para **Preview**):

| Variable | Obligatoria | Uso |
|---|---|---|
| `DATABASE_URL` | Sí | Conexión de la app (rol `saas_app`, con pooler) |
| `ANTHROPIC_API_KEY` | Solo asistente de stock | Clave de la API de Claude |
| `OPENAI_API_KEY` | Solo escaneo de comprobantes | Clave de la API de OpenAI |
| `AI_MODEL` | No | Si es de Claude: asistente de stock (por defecto `claude-haiku-5-5`). Si es de OpenAI: escaneo |
| `OPENAI_MODEL` | Ver nota | Modelo de OpenAI para el escaneo; necesario si `AI_MODEL` es de Claude |

Para el escaneo, además: activa *Agente de IA* en la cuenta y agrega en SuperAdmin → *Modelos de IA* el precio del modelo de OpenAI, escrito exactamente igual que en la variable. El modelo debe aceptar imágenes, PDF y salida estructurada.
| `DATA_ENCRYPTION_KEY` | Solo SUNAT | `openssl rand -base64 32`. Si se pierde, hay que volver a cargar certificados |

`DIRECT_URL` no hace falta en Vercel: las migraciones se ejecutan aparte.

3. Despliega y entra a `/login`. Cambia la contraseña del SuperAdmin y crea la primera cuenta.

## 4. Actualizaciones

1. Aplica primero las migraciones nuevas: `npm run db:migrate` (con `DIRECT_URL` de producción).
2. Despliega. Los dispositivos descargan la versión nueva al recargar con conexión.

Nunca edites una migración ya aplicada: crea otra. Si una migración futura modifica **datos** de tablas de negocio y tu propietario no omite RLS, deberá fijar `app.tenant_id` o desactivar RLS temporalmente dentro de la propia migración. Las tablas de negocio nuevas necesitan su política RLS y sus `GRANT` (ver la migración `*_rls`).

## 5. Render

**No se necesita.** La sincronización la inicia cada dispositivo y no hay tareas programadas ni procesos persistentes. Se reevaluará al implementar el envío a SUNAT (cola con reintentos).

## 6. Respaldos

- **Base completa:** configura la restauración a un punto en el tiempo (PITR) de Neon según tu plan. Es el respaldo para recuperación ante desastres.
- **Por cuenta:** SuperAdmin → cuenta → *Generar respaldo* (JSON comprimido, sin contraseñas ni secretos SUNAT; se genera solo antes de eliminar). Es una copia de exportación: **no hay importador automático**.

## 7. Verificación después de desplegar

- [ ] Instalar la PWA en un celular y en la computadora de caja.
- [ ] Abrir la app, activar el modo avión, recargar, hacer una venta y comprobar que se sincroniza al reconectar.
- [ ] Escanear con la cámara (requiere HTTPS) en Android e iPhone.
- [ ] Imprimir un ticket en la impresora térmica y una hoja de etiquetas; ajustar márgenes en el diálogo de impresión.
- [ ] Si activas el escaneo: probar con una foto y un PDF reales, comparar el borrador con el comprobante y revisar el consumo.
- [ ] Si activas el agente: hacer una consulta real y revisar el consumo en SuperAdmin. Confirmar los precios en *Modelos de IA*.

## 8. Pruebas automáticas

Define `TEST_DATABASE_URL` y `TEST_DIRECT_URL` apuntando a una base cuyo nombre contenga `test` (**se borra en cada ejecución**) y ejecuta `npm test`.
