import { createHash } from 'node:crypto';
import { HashSchema, IdSchema } from '@crypto/contracts';

/** canonical-json.v1: sorted UTF-16 keys, JSON scalars, ordered dense arrays, no coercion. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 100) throw new TypeError('Canonical JSON depth exceeds 100');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) {
      if (Number.isInteger(item) && !Number.isSafeInteger(item))
        throw new TypeError('Unsafe integer: serialize as a string');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('Expected JSON-compatible values');
    if (ancestors.has(item)) throw new TypeError('Cyclic JSON');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Reflect.ownKeys(item).length !== item.length + 1)
          throw new TypeError('Expected a dense JSON array without extra properties');
        const parts: string[] = [];
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (!descriptor || !('value' in descriptor))
            throw new TypeError('Sparse/accessor arrays are not JSON data');
          parts.push(encode(descriptor.value, depth + 1));
        }
        return `[${parts.join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Expected plain JSON object');
      const keys = Object.keys(item).sort();
      if (Reflect.ownKeys(item).length !== keys.length)
        throw new TypeError('Symbols/nonenumerable properties are not JSON data');
      return `{${keys
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !('value' in descriptor))
            throw new TypeError('Accessors are not JSON data');
          return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
        })
        .join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value, 0);
}

export function canonicalHash(value: unknown): string {
  return HashSchema.parse(
    `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`,
  );
}

export function deterministicId(namespace: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(namespace)) throw new TypeError('Invalid ID namespace');
  const digest = canonicalHash({ schemaVersion: 'id.v1', namespace, value }).slice(7);
  return IdSchema.parse(`${namespace}_${digest}`);
}
