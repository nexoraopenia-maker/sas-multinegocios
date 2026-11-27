import { z } from 'zod';

/** Todo se habilita por cuenta desde el SuperAdmin. No existen planes. */
export const featuresSchema = z.object({
  alertExpiry: z.boolean().default(true),
  alertLowStock: z.boolean().default(true),
  multiBranch: z.boolean().default(true),
  aiAgent: z.boolean().default(false),
  aiLimitType: z.enum(['USD', 'TOKENS']).default('USD'),
  aiLimitValue: z.number().min(0).max(1_000_000_000).default(1),
  sunat: z.boolean().default(false),
  maxBranches: z.number().int().min(1).max(500).default(5),
  maxUsers: z.number().int().min(1).max(5000).default(20),
});
export type Features = z.infer<typeof featuresSchema>;
export const parseFeatures = (raw: unknown): Features => featuresSchema.parse(raw ?? {});

export const FEATURE_LABELS: Record<keyof Features, string> = {
  alertExpiry: 'Alertas de vencimiento',
  alertLowStock: 'Alertas de bajo stock',
  multiBranch: 'Multisucursal y traslados',
  aiAgent: 'Agente de IA de stock',
  aiLimitType: 'Tipo de límite de IA',
  aiLimitValue: 'Límite de consumo de IA',
  sunat: 'Facturación electrónica SUNAT',
  maxBranches: 'Máximo de sucursales',
  maxUsers: 'Máximo de usuarios',
};
