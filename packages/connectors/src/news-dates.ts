import { fromEpoch, utc } from '@crypto/core';
import type { UtcTimestamp } from '@crypto/contracts';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Explicit ISO/RFC-822 offsets only; no host-local Date.parse fallback or inferred timezone. */
export function parseNewsTimestamp(input: string, allowRfcZones = false): UtcTimestamp {
  const value = input.trim();
  if (allowRfcZones) {
    const zones: Record<string, string> = {
      EST: '-0500',
      EDT: '-0400',
      CST: '-0600',
      CDT: '-0500',
      MST: '-0700',
      MDT: '-0600',
      PST: '-0800',
      PDT: '-0700',
    };
    const zone = value.split(' ').at(-1)!;
    if (zones[zone]) return parseNewsTimestamp(value.slice(0, -zone.length) + zones[zone]);
  }
  let local: string,
    fraction = '',
    offset = 0;
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (iso) {
    local = `${iso[1]}T${iso[2]}`;
    fraction = iso[3] ?? '';
    const zone = iso[4]!;
    if (zone !== 'Z') {
      const hours = Number(zone.slice(1, 3)),
        minutes = Number(zone.slice(4, 6));
      if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0) || zone === '-00:00')
        throw new Error('Unknown timezone');
      offset = (hours * 60 + minutes) * (zone[0] === '+' ? 1 : -1);
    }
  } else {
    const rfc =
      /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun), )?(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}:\d{2}:\d{2}) (GMT|UT|Z|[+-]\d{4})$/.exec(
        value,
      );
    if (!rfc) throw new Error('Unsupported news timestamp');
    local = `${rfc[4]}-${String(months.indexOf(rfc[3]!) + 1).padStart(2, '0')}-${rfc[2]!.padStart(2, '0')}T${rfc[5]}`;
    const zone = rfc[6]!;
    if (/^[+-]/.test(zone)) {
      const hours = Number(zone.slice(1, 3)),
        minutes = Number(zone.slice(3, 5));
      if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0) || zone === '-0000')
        throw new Error('Unknown timezone');
      offset = (hours * 60 + minutes) * (zone[0] === '+' ? 1 : -1);
    }
    if (rfc[1] && new Date(`${local}Z`).toUTCString().slice(0, 3) !== rfc[1])
      throw new Error('Weekday mismatch');
  }
  const valid = utc(`${local}.${fraction.padEnd(9, '0')}Z`);
  const nanos =
    BigInt(Date.parse(`${valid.slice(0, 19)}Z`)) * 1000000n +
    BigInt(valid.slice(20, 29)) -
    BigInt(offset) * 60000000000n;
  return fromEpoch(nanos, 'nanoseconds');
}
