import type { z } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    /** Extra top-level fields merged into the error response (e.g. `match` on 409). */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, code = 'conflict', extra?: Record<string, unknown>) =>
  new AppError(409, code, message, undefined, extra);
export const unprocessable = (message: string, code = 'rule_violation') => new AppError(422, code, message);
export const tooMany = (message: string) => new AppError(429, 'too_many_attempts', message);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'Invalid input',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
