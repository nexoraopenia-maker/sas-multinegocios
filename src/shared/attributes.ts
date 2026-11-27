import { z } from 'zod';

export const attributeDefSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,30}$/, 'Usa minúsculas, números y guion bajo'),
  label: z.string().min(1).max(40),
  type: z.enum(['text', 'number', 'select']),
  options: z.array(z.string().min(1).max(60)).max(100).default([]),
  required: z.boolean().default(false),
  /** true: varía entre variantes (talla, color). false: describe al producto (material). */
  perVariant: z.boolean().default(true),
});
export type AttributeDef = z.infer<typeof attributeDefSchema>;
export type AttributeValues = Record<string, string | number>;

/** Valida los valores contra la definición de la categoría (JSONB validado, sin cambiar el esquema). */
export function validateAttributes(defs: AttributeDef[], values: Record<string, unknown>, perVariant: boolean) {
  const out: AttributeValues = {};
  const errors: string[] = [];
  const scope = defs.filter((d) => d.perVariant === perVariant);
  for (const key of Object.keys(values)) {
    if (!scope.some((d) => d.key === key) && values[key] !== '' && values[key] != null) {
      errors.push(`Atributo desconocido: ${key}`);
    }
  }
  for (const def of scope) {
    const raw = values[def.key];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      if (def.required) errors.push(`Falta "${def.label}"`);
      continue;
    }
    if (def.type === 'number') {
      const n = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n)) errors.push(`"${def.label}" debe ser un número`);
      else out[def.key] = n;
    } else {
      const s = String(raw).trim().slice(0, 120);
      if (def.type === 'select' && !def.options.includes(s)) {
        errors.push(`"${def.label}" debe ser: ${def.options.join(', ')}`);
      } else out[def.key] = s;
    }
  }
  return { values: out, errors };
}

const attr = (key: string, label: string, extra: Partial<AttributeDef> = {}): AttributeDef =>
  ({ key, label, type: 'text', options: [], required: false, perVariant: true, ...extra });

export const BUSINESS_TYPES = {
  joyeria: 'Joyería', ropa: 'Ropa', zapatillas: 'Zapatillas', comercio: 'Comercio general', mixta: 'Tienda mixta',
} as const;
export type BusinessType = keyof typeof BUSINESS_TYPES;

type CategoryTemplate = { name: string; tracksExpiry: boolean; attributes: AttributeDef[] };

const T: Record<string, CategoryTemplate> = {
  joyas: { name: 'Joyas', tracksExpiry: false, attributes: [
    attr('material', 'Material', { perVariant: false }), attr('kilates', 'Kilates', { type: 'select', options: ['9k', '14k', '18k', '24k', '925'] }),
    attr('peso_g', 'Peso (g)', { type: 'number' }), attr('talla', 'Talla')] },
  ropa: { name: 'Ropa', tracksExpiry: false, attributes: [attr('talla', 'Talla'), attr('color', 'Color'), attr('material', 'Material', { perVariant: false })] },
  zapatillas: { name: 'Zapatillas', tracksExpiry: false, attributes: [attr('talla', 'Talla'), attr('color', 'Color'), attr('modelo', 'Modelo')] },
  general: { name: 'General', tracksExpiry: false, attributes: [attr('presentacion', 'Presentación')] },
  alimentos: { name: 'Alimentos y bebidas', tracksExpiry: true, attributes: [attr('presentacion', 'Presentación'), attr('sabor', 'Sabor')] },
};

/** Categorías iniciales según rubro. El negocio puede editarlas o crear otras. */
export function categoryTemplates(type: BusinessType): CategoryTemplate[] {
  switch (type) {
    case 'joyeria': return [T.joyas, T.general];
    case 'ropa': return [T.ropa, T.general];
    case 'zapatillas': return [T.zapatillas, T.general];
    case 'mixta': return [T.ropa, T.alimentos, T.general];
    default: return [T.general, T.alimentos];
  }
}
