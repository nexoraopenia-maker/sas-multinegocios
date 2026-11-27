/** Enlace a la pantalla de etiquetas con las copias precargadas: ?v=variante:copias,… */
export const MAX_COPIES = 500;

export function labelsHref(lines: { variantId: string; quantity: number }[]) {
  const copies = new Map<string, number>();
  for (const l of lines) copies.set(l.variantId, (copies.get(l.variantId) ?? 0) + l.quantity);
  const list = [...copies].filter(([, q]) => q > 0).map(([id, q]) => `${id}:${Math.min(MAX_COPIES, Math.ceil(q))}`);
  return `/app/etiquetas?v=${list.join(',')}`;
}

export function parseLabelsParam(param: string): Record<string, number> {
  return Object.fromEntries(param.split(',').flatMap((part) => {
    const [id, q] = part.split(':');
    const copies = Number(q);
    return id && Number.isInteger(copies) && copies > 0 ? [[id, Math.min(MAX_COPIES, copies)]] : [];
  }));
}
