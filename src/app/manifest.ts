import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Inventario y Ventas', short_name: 'Ventas', description: 'Punto de venta e inventario que funciona sin internet', lang: 'es',
    start_url: '/app', scope: '/', display: 'standalone', background_color: '#f4f5f2', theme_color: '#0f6b5f',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [{ name: 'Nueva venta', url: '/app/pos' }],
  };
}
