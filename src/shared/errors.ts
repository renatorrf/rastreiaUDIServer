export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = (message = 'Credenciais inválidas.') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Você não possui permissão para esta ação.') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Recurso não encontrado.') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

export const validationError = (fieldErrors: Record<string, string>, message = 'Revise os campos obrigatórios.') =>
  new AppError(422, 'VALIDATION_ERROR', message, fieldErrors);
