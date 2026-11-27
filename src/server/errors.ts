export class AppError extends Error {
  constructor(message: string, public status = 400, public code = 'BAD_REQUEST', public details?: unknown) {
    super(message);
  }
}
export const forbidden = (message = 'No tienes permiso para esta acción') => new AppError(message, 403, 'FORBIDDEN');
export const notFound = (what = 'Registro') => new AppError(`${what} no encontrado`, 404, 'NOT_FOUND');
export const conflict = (message: string) => new AppError(message, 409, 'CONFLICT');

export const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
