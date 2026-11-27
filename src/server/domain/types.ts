import type { OperationType, Payload } from '@/shared/operations';
import type { Ctx } from '../context';
import type { Tx } from '../db';

export interface OpMeta { time: Date; deviceKey: string; opId: string }
export type Handler<T extends OperationType> = (tx: Tx, ctx: Ctx, payload: Payload<T>, meta: OpMeta) => Promise<object>;
