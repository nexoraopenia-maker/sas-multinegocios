import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { AppError } from './errors';

const PARAMS: ScryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scrypt = (password: string, salt: Buffer, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, 64, opts, (e, key) => (e ? reject(e) : resolve(key))));

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return `scrypt$${PARAMS.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [alg, n, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !key) return false;
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), { ...PARAMS, N: Number(n) });
  const expected = Buffer.from(key, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function assertPasswordPolicy(password: string) {
  if (password.length < 10 || password.length > 200 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new AppError('La contraseña debe tener al menos 10 caracteres, con letras y números', 400, 'WEAK_PASSWORD');
  }
}
