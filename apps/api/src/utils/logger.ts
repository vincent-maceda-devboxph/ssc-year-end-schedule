import { pino } from 'pino';
import { config } from '../config.js';

export const logger = pino({ level: process.env.NODE_ENV === 'test' ? 'silent' : config.logLevel });
