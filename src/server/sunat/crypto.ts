import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../errors';

function key() {
  const k = Buffer.from(process.env.DATA_ENCRYPTION_KEY ?? '', 'base64');
  if (k.length !== 32) throw new AppError('El servidor no tiene configurada DATA_ENCRYPTION_KEY', 503, 'NOT_CONFIGURED');
  return k;
}

/** AES-256-GCM: iv.tag.datos en base64. */
export function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(token: string) {
  const [iv, tag, data] = token.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
