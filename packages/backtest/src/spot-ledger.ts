import { SpotJournalSchema } from '@crypto/contracts';
import type {
  SpotBalance,
  SpotPosting,
  SpotJournal,
  SpotSimulationRequest,
  UtcTimestamp,
} from '@crypto/contracts';
import { canonicalHash, deepFreeze, deterministicId } from '@crypto/core';
import { D, amount } from './spot-math.js';

export const journalGenesis = canonicalHash({ schemaVersion: 'spot-journal-genesis.v1' });
export class SpotLedger {
  readonly entries: SpotJournal[] = [];
  #balances = new Map<string, SpotBalance>();
  balances() {
    return [...this.#balances.values()]
      .map((b) => ({ ...b }))
      .sort((a, b) => (`${a.portfolio}|${a.asset}` < `${b.portfolio}|${b.asset}` ? -1 : 1));
  }
  balance(portfolio: SpotBalance['portfolio'], asset: string) {
    return (
      this.#balances.get(`${portfolio}|${asset}`) ?? {
        portfolio,
        asset,
        free: amount('0'),
        reserved: amount('0'),
      }
    );
  }
  post(
    at: UtcTimestamp,
    kind: SpotJournal['kind'],
    postings: SpotPosting[],
    orderId: string | null = null,
    fillId: string | null = null,
  ) {
    const sums = new Map<string, InstanceType<typeof D>>(),
      next = new Map([...this.#balances].map(([k, b]) => [k, { ...b }]));
    for (const p of postings) {
      const key = `${p.portfolio}|${p.asset}`;
      sums.set(key, (sums.get(key) ?? new D(0)).plus(p.amount));
      if (p.account !== 'FREE' && p.account !== 'RESERVED') continue;
      const b = next.get(key) ?? {
          portfolio: p.portfolio,
          asset: p.asset,
          free: amount(0),
          reserved: amount(0),
        },
        field = p.account === 'FREE' ? 'free' : 'reserved';
      b[field] = amount(new D(b[field]).plus(p.amount));
      next.set(key, b);
    }
    if ([...sums.values()].some((v) => !v.isZero())) throw new Error('Unbalanced spot journal');
    if ([...next.values()].some((b) => new D(b.free).isNeg() || new D(b.reserved).isNeg()))
      throw new Error('Negative spot wallet balance');
    if (this.entries.at(-1) && this.entries.at(-1)!.at > at)
      throw new Error('Spot journal clock regression');
    const old = this.#balances;
    this.#balances = next;
    try {
      const body = {
          schemaVersion: 'spot-journal.v1' as const,
          sequence: this.entries.length + 1,
          at,
          kind,
          orderId,
          fillId,
          postings,
          balancesAfter: this.balances(),
          previousHash: this.entries.at(-1)?.hash ?? journalGenesis,
        },
        id = deterministicId('spot-journal', body),
        entry = SpotJournalSchema.parse({ ...body, id, hash: canonicalHash({ ...body, id }) });
      deepFreeze(entry);
      this.entries.push(entry);
      return entry.id;
    } catch (e) {
      this.#balances = old;
      throw e;
    }
  }
  move(
    at: UtcTimestamp,
    portfolio: SpotBalance['portfolio'],
    asset: string,
    value: string,
    toReserved: boolean,
    orderId: string,
  ) {
    return this.post(
      at,
      toReserved ? 'RESERVE' : 'RELEASE',
      [
        {
          portfolio,
          asset,
          account: toReserved ? 'FREE' : 'RESERVED',
          amount: amount(new D(value).neg()),
        },
        { portfolio, asset, account: toReserved ? 'RESERVED' : 'FREE', amount: amount(value) },
      ],
      orderId,
    );
  }
  initialize(request: SpotSimulationRequest) {
    for (const portfolio of request.portfolios)
      for (const b of request.initialBalances)
        this.post(request.startAt, 'DEPOSIT', [
          { portfolio, asset: b.asset, account: 'FREE', amount: b.amount },
          { portfolio, asset: b.asset, account: 'EXTERNAL', amount: amount(new D(b.amount).neg()) },
        ]);
  }
}
/** Independent journal replay checks every posting group, balance snapshot and chain. */
export function reconcileSpotJournal(input: unknown) {
  if (!Array.isArray(input)) throw new Error('Expected spot journal');
  const ledger = new SpotLedger();
  for (const raw of input) {
    const e = SpotJournalSchema.parse(raw),
      id = ledger.post(e.at, e.kind, e.postings, e.orderId, e.fillId),
      rebuilt = ledger.entries.at(-1)!;
    if (id !== e.id || canonicalHash(e) !== canonicalHash(rebuilt))
      throw new Error('Spot journal reconciliation mismatch');
  }
  return ledger.balances();
}
