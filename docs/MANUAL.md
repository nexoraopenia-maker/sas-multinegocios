# Manual de usuario

## Para todos

**Ingresar:** abre la dirección del sistema, escribe tu correo y contraseña. La primera vez te pedirá crear una contraseña nueva (mínimo 10 caracteres, con letras y números). Tras 5 intentos fallidos hay que esperar 15 minutos.

**Instalar como app:** en Chrome/Edge, menú → *Instalar aplicación*; en iPhone/iPad, Safari → *Compartir* → *Agregar a inicio*.

**Estado de conexión (arriba a la derecha):**

| Indicador | Significado |
|---|---|
| En línea | Todo sincronizado |
| Sincronizando | Enviando o descargando datos |
| N pendientes | Hay operaciones guardadas en este equipo por enviar |
| Sin conexión | Puedes seguir trabajando |
| N rechazadas | El servidor no aceptó alguna operación: tócalo para ver el motivo |

**Trabajar sin internet**
- Antes, ingresa al menos una vez con conexión en ese equipo y esa sucursal.
- Funciona: vender, abrir y cerrar caja, ingresar mercadería, solicitar ajustes y conteos, pedir, enviar y recibir traslados, ver inventario y alertas.
- Necesita internet: iniciar sesión, crear o editar productos, carga masiva, aprobar, anular, devolver, usar vales, reportes, kárdex, asistente IA, enviar por WhatsApp o correo.
- **No borres los datos del navegador ni uses modo incógnito** si hay pendientes: se perderían.
- La sesión dura 7 días; conéctate al menos una vez dentro de ese plazo.

## Vendedor

1. **Caja → Abrir caja** con el efectivo inicial.
2. **Vender:** escanea con el lector, usa *Cámara*, o busca por nombre. Ajusta cantidades y descuentos (hay un máximo).
3. **Cobrar:** elige efectivo, Yape, Plin, tarjeta, transferencia o vale. Con *Pago mixto* combinas medios. En efectivo, anota lo recibido y se calcula el vuelto.
4. **Confirmar venta** e imprime (ticket o A4) o envía por WhatsApp/correo.
5. En productos con vencimiento, el sistema toma primero el lote que vence antes; puedes elegir otro.
6. **Caja → Arqueo y cierre:** cuenta el dinero y anota el total de cada medio. La diferencia se muestra al cerrar.

Devoluciones y anulaciones las hace un supervisor.

## Supervisor

Todo lo del vendedor, además:
- **Devoluciones y anulaciones:** *Ventas* → toca el comprobante → *Devolución o cambio* o *Anular venta*. Marca *Dañado* si el producto no vuelve a la venta. Para un **cambio**: devuelve con reembolso *Vale* y cobra la venta nueva con ese código. Para devolver efectivo debe haber una caja abierta.
- **Ajustes, mermas y conteo:** crea solicitudes o **apruébalas/recházalas**. El stock cambia solo al aprobar. En un conteo, la diferencia se calcula contra el stock que había a la hora en que se contó.
- **Traslados:** (1) la sucursal que necesita **solicita**; (2) el supervisor de origen **aprueba**; (3) origen **registra el envío**; (4) destino **confirma la recepción**. Si llega menos, se registra el faltante y se genera un aviso.
- **Avisos:** revisa stock negativo, ventas por revisar, operaciones rechazadas, diferencias de caja y de traslados. Márcalos como resueltos.
- **Caja:** revisa los cierres y márcalos como revisados.
- **Inventario:** crea productos, carga masiva, etiquetas (cambiar precios de productos existentes es del administrador).
- **Reportes:** consulta y exporta a Excel o PDF.

## Administrador / Dueño

Todo lo anterior, además:
- **Configuración → Negocio:** nombre, RUC (opcional), pie de comprobante, descuento máximo del vendedor, días de aviso de vencimiento, qué alertas mostrar y formato de etiquetas.
- **Configuración → Sucursales:** el código (p. ej. `T02`) aparece en los comprobantes y no se puede cambiar.
- **Configuración → Usuarios:** crea usuarios con contraseña temporal, asigna rol y sucursales. A un vendedor puedes darle permisos extra (ingresar mercadería, traslados, ajustes, descuentos sin límite).
- **Categorías:** define atributos propios (talla, color, kilates, peso…) y si la categoría controla vencimiento.
- **Productos:** si dejas vacíos el SKU y el código de barras, se generan. El *stock mínimo* activa la alerta de bajo stock.
- **Carga masiva:** *Inventario → Carga masiva* → descarga la plantilla → valida → importa. Si hay un error, no se guarda nada.
- **Ingreso con QR:** en *Ingreso*, escanea el QR de la factura o boleta del proveedor. Se llenan RUC, número y total, y se impide registrarla dos veces. Los productos se agregan a mano o escaneando (el QR no trae el detalle).
- **Panel de inicio:** tarjetas de vencidos, por vencer y bajo stock; toca una para ver el listado.
- **Asistente IA** (si está activado): pregunta en lenguaje natural; solo consulta. Cada pregunta se responde por separado. Al agotar el límite se bloquea y aparece un aviso.
- **Panel de inicio** (con permiso de reportes): ventas de hoy y del periodo (7, 30 o 90 días), margen e inventario aproximados (con permiso de costos), ventas por día, ingresos recientes y movimientos. Necesita conexión; las alertas funcionan sin ella.
- **Escanear comprobante** (Ingreso → *Escanear con IA*; requiere el agente activado, permiso de ingreso e internet):
  1. Toma una foto o sube un JPG, PNG, WEBP o PDF (máximo 4 MB y 10 páginas).
  2. Revisa el borrador: datos del comprobante, producto de cada línea (los marcados «Sugerido» se deben verificar), cantidad, costo, lote y vencimiento. Puedes crear productos nuevos (con permiso de catálogo) u omitir líneas.
  3. Revisa si los costos incluyen IGV y pulsa *Confirmar ingreso*. Recién entonces cambia el inventario.
  4. Genera las etiquetas desde el aviso de confirmación.
  - Un comprobante ya ingresado (mismo RUC, tipo, serie y número) o un archivo ya usado se bloquea. El archivo original queda guardado como respaldo.
  - Cada lectura consume del mismo límite de IA que el asistente.
- **Accesos rápidos:** abrir caja desde Vender, montos rápidos de apertura, crear sucursal desde Traslados, filtros de stock en Inventario y botones de reposición en las alertas.
- **SUNAT** (si está activado): puedes guardar el certificado; **la emisión electrónica aún no está disponible**. Los comprobantes que imprime el sistema son internos, sin valor tributario.

## SuperAdmin (dueño del sistema)

- **Cuentas:** métricas globales y estado de sincronización de cada negocio.
- **Nueva cuenta:** nombre, rubro, correo (p. ej. `paul@admin.pe`) y contraseña inicial. Se crean la sucursal *Principal* y categorías según el rubro.
- **Dentro de una cuenta:**
  - *Funciones y límites:* alertas, multisucursal, agente IA (límite en US$ —1 por defecto— o en tokens), SUNAT, máximo de sucursales y usuarios. No hay planes.
  - *Consumo de IA:* detalle por consulta; *Reiniciar consumo* empieza de cero.
  - *Usuarios:* restablecer contraseñas.
  - *Estado:* suspender (corta las sesiones) o reactivar; generar y descargar respaldos; eliminar (pide escribir el nombre, respalda antes y no borra físicamente).
- **Modelos de IA:** precio por millón de tokens. Mantenlo actualizado: el límite en dólares depende de él.
- **Auditoría:** historial de tus acciones y de cambios sensibles.

Un equipo sin conexión se entera de una suspensión la próxima vez que se conecta.
