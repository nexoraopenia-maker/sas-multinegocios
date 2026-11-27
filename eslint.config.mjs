import next from 'eslint-config-next/core-web-vitals';

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'src/generated/**', 'public/sw.js', 'next-env.d.ts'] },
  ...next,
  {
    rules: {
      // La app usa <a> a propósito: una navegación completa se resuelve desde la caché del service worker sin red.
      '@next/next/no-html-link-for-pages': 'off',
      '@next/next/no-location-assign-relative-destination': 'off',
      // Carga inicial de datos desde efectos (IndexedDB / API) es un patrón intencional.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
];

export default config;
