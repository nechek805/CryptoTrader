import { z } from 'zod';
import { canonicalHash } from '@crypto/core';
import { PersistenceError } from './errors.js';

const CursorSchema = z.strictObject({
  schemaVersion: z.literal('page-cursor.v1'),
  scopeHash: z.string(),
  after: z.string().min(1).max(200),
});
export function encodeCursor(scope: unknown, after: string): string {
  return Buffer.from(
    JSON.stringify({ schemaVersion: 'page-cursor.v1', scopeHash: canonicalHash(scope), after }),
  ).toString('base64url');
}
export function decodeCursor(scope: unknown, cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 2048) throw new Error();
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const value = CursorSchema.parse(decoded);
    if (value.scopeHash !== canonicalHash(scope)) throw new Error();
    return value.after;
  } catch {
    throw new PersistenceError('VALIDATION');
  }
}
