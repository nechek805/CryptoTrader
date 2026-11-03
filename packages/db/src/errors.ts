import { z } from 'zod';

export type PersistenceErrorCode =
  | 'VALIDATION'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'CORRUPT'
  | 'CLOSED'
  | 'READ_ONLY'
  | 'MIGRATION'
  | 'STORAGE';
const messages: Record<PersistenceErrorCode, string> = {
  VALIDATION: 'Persistence input failed validation',
  CONFLICT: 'Immutable record or revision conflict',
  NOT_FOUND: 'Referenced research record was not found',
  CORRUPT: 'Stored record or audit integrity check failed',
  CLOSED: 'Repository session is closed',
  READ_ONLY: 'Write attempted in a read-only session',
  MIGRATION: 'Migration history or checksum does not match this software',
  STORAGE: 'Database operation failed; check service, permissions and configuration',
};
export class PersistenceError extends Error {
  constructor(readonly code: PersistenceErrorCode) {
    super(messages[code]);
    this.name = 'PersistenceError';
  }
}
export function safeDatabaseError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  return new PersistenceError(error instanceof z.ZodError ? 'VALIDATION' : 'STORAGE');
}
