# SaaS multinegocio de inventario y ventas

PWA para tiendas físicas (joyerías, ropa, zapatillas, tiendas mixtas): inventario con kárdex, punto de venta que funciona sin internet, multisucursal, alertas, panel SuperAdmin y asistente de IA de solo lectura.

## Inicio rápido (desarrollo)

Requisitos: Node 20.12+ y PostgreSQL (Neon o local).

```bash
npm install
cp .env.example .env.local        # completa DATABASE_URL y DIRECT_URL
npm run db:migrate                # crea tablas, RLS y el rol saas_app
npm run db:role                   # asigna al rol la contraseña de DATABASE_URL
npm run superadmin:create         # usa SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD
npm run dev                       # http://localhost:3000
```

El modo sin conexión (service worker) solo se activa en producción: `npm run build && npm start`.

## Documentación

- [Guía de despliegue](docs/DESPLIEGUE.md)
- [Manual de usuario](docs/MANUAL.md) (SuperAdmin, administrador, supervisor y vendedor)
- [Decisiones de arquitectura](DECISIONES.md)
- [Especificación y hoja de ruta](CLAUDEsas.md)
