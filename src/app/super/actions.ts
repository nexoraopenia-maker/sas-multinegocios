'use server';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { logout, SESSION_COOKIE } from '@/server/auth';
import { AppError } from '@/server/errors';
import * as platform from '@/server/platform';
import { featuresSchema } from '@/shared/features';
import { requireSuper } from './session';

export type ActionState = { ok?: string; error?: string };

async function guard(fn: (actor: Awaited<ReturnType<typeof requireSuper>>) => Promise<string>): Promise<ActionState> {
  const actor = await requireSuper();
  try {
    const ok = await fn(actor);
    revalidatePath('/super', 'layout');
    return { ok };
  } catch (e) {
    if (e instanceof z.ZodError) return { error: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    if (e instanceof AppError) return { error: e.message };
    console.error(e);
    return { error: 'No se pudo completar la acción' };
  }
}
const text = (f: FormData, k: string) => String(f.get(k) ?? '');

export async function createAccountAction(_: ActionState, f: FormData) {
  return guard(async (actor) => {
    await platform.createAccount(actor, platform.accountInput.parse(Object.fromEntries(['businessName', 'businessType', 'adminName', 'email', 'password'].map((k) => [k, text(f, k)]))));
    return `Cuenta creada para ${text(f, 'email')}. Deberá cambiar la contraseña al ingresar.`;
  });
}

export async function statusAction(_: ActionState, f: FormData) {
  return guard(async (actor) => {
    const status = z.enum(['ACTIVE', 'SUSPENDED']).parse(text(f, 'status'));
    await platform.setAccountStatus(actor, text(f, 'tenantId'), status);
    return status === 'ACTIVE' ? 'Cuenta reactivada' : 'Cuenta suspendida y sesiones cerradas';
  });
}

export async function featuresAction(_: ActionState, f: FormData) {
  return guard(async (actor) => {
    const flag = (k: string) => f.get(k) === 'on';
    await platform.updateFeatures(actor, text(f, 'tenantId'), featuresSchema.parse({
      alertExpiry: flag('alertExpiry'), alertLowStock: flag('alertLowStock'), multiBranch: flag('multiBranch'), aiAgent: flag('aiAgent'), sunat: flag('sunat'),
      aiLimitType: text(f, 'aiLimitType'), aiLimitValue: Number(text(f, 'aiLimitValue')), maxBranches: Number(text(f, 'maxBranches')), maxUsers: Number(text(f, 'maxUsers')),
    }));
    return 'Funciones y límites actualizados';
  });
}

export async function resetAiAction(_: ActionState, f: FormData) {
  return guard(async (actor) => { await platform.resetAiUsage(actor, text(f, 'tenantId')); return 'Consumo de IA reiniciado'; });
}

export async function passwordAction(_: ActionState, f: FormData) {
  return guard(async (actor) => { await platform.resetUserPassword(actor, text(f, 'userId'), text(f, 'password')); return 'Contraseña restablecida; se pedirá cambiarla'; });
}

export async function backupAction(_: ActionState, f: FormData) {
  return guard(async (actor) => { await platform.createBackup(actor, text(f, 'tenantId')); return 'Respaldo generado'; });
}

export async function deleteAction(_: ActionState, f: FormData) {
  return guard(async (actor) => { await platform.deleteAccount(actor, text(f, 'tenantId'), text(f, 'confirmation')); return 'Cuenta eliminada. El respaldo quedó guardado.'; });
}

export async function priceAction(_: ActionState, f: FormData) {
  return guard(async (actor) => {
    await platform.saveModelPrice(actor, { model: text(f, 'model'), inputPerMTok: Number(text(f, 'inputPerMTok')), outputPerMTok: Number(text(f, 'outputPerMTok')) });
    return 'Precio guardado';
  });
}

export async function logoutAction() {
  const jar = await cookies();
  await logout(jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}
