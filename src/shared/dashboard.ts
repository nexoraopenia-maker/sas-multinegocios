export const DASHBOARD_PERIODS = [7, 30, 90] as const;

export interface DaySales { date: string; count: number; net: number }
export interface Dashboard {
  from: string; to: string; days: number;
  today: { count: number; net: number };
  period: { count: number; net: number; average: number };
  series: DaySales[];
  /** Los importes de costo son null sin permiso para ver costos. */
  margin: { amount: number; percent: number } | null;
  valuation: { cost: number; sale: number; potential: number } | null;
  purchases: {
    count: number; total: number | null;
    recent: { id: string; occurredAt: string; branch: string; reason: string; lines: number; units: number; total: number | null; scanId: string | null }[];
  };
  movements: { type: string; in: number; out: number }[];
}
