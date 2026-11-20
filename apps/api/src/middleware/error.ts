import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
      ...err.extra,
    });
    return;
  }
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({ error: { code: 'bad_request', message: `Invalid ${err.path}` } });
    return;
  }
  if (typeof err === 'object' && err && (err as { code?: number }).code === 11000) {
    res.status(409).json({ error: { code: 'duplicate', message: 'A record with these values already exists' } });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON body' } });
    return;
  }
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
}
