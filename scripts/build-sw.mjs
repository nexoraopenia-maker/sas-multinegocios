// Tras "next build": genera public/sw.js con la lista de archivos que deben quedar disponibles sin conexión.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);

const staticDir = join(root, '.next/static');
const assets = walk(staticDir).filter((f) => !f.endsWith('.map')).map((f) => '/_next/static/' + relative(staticDir, f).split(sep).map(encodeURIComponent).join('/'));
const icons = walk(join(root, 'public/icons')).map((f) => '/icons/' + f.split(sep).pop());

const appDir = join(root, 'src/app/app');
const pages = walk(appDir).filter((f) => f.endsWith(`${sep}page.tsx`)).map((f) => ['/app', ...relative(appDir, f).split(sep).slice(0, -1)].join('/'));

const template = readFileSync(join(root, 'src/sw/sw.js'), 'utf8');
const version = createHash('sha256').update(template + assets.join() + readFileSync(join(root, '.next/BUILD_ID'), 'utf8')).digest('hex').slice(0, 12);
writeFileSync(join(root, 'public/sw.js'), template
  .replace('__VERSION__', version)
  .replace('__ASSETS__', JSON.stringify([...assets, ...icons, '/manifest.webmanifest']))
  .replace('__PAGES__', JSON.stringify([...pages, '/login'])));
console.log(`sw.js ${version}: ${assets.length} archivos y ${pages.length} páginas disponibles sin conexión.`);
