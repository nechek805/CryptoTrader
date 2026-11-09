import { MarginJournalSchema } from '@crypto/contracts';
import type { MarginJournal } from '@crypto/contracts';
import { canonicalHash, deepFreeze } from '@crypto/core';
import { D, amount } from './spot-math.js';
export const marginGenesis = canonicalHash({ version: 'hypothetical-borrow-journal.v1' });
/** Debt is explicit; spendable cash, collateral and proceeds can never be negative. */
export class MarginResearchLedger {
  readonly entries: MarginJournal[] = [];
  private balances: Record<string, string> = {};
  balance(asset: string, account: string) {
    return new D(this.balances[asset + '/' + account] ?? 0);
  }
  post(at: number, kind: MarginJournal['kind'], postings: MarginJournal['postings']) {
    const next = { ...this.balances },
      sums = new Map<string, InstanceType<typeof D>>();
    for (const p of postings) {
      const key = p.asset + '/' + p.account;
      next[key] = amount(new D(next[key] ?? 0).plus(p.amount));
      sums.set(p.asset, (sums.get(p.asset) ?? new D(0)).plus(p.amount));
    }
    if ([...sums.values()].some((s) => !s.isZero())) throw new Error('Unbalanced margin journal');
    for (const [key, value] of Object.entries(next)) {
      const account = key.split('/')[1];
      if (
        ['FREE', 'RESERVED', 'PROCEEDS', 'FEES', 'FINANCING'].includes(account!) &&
        new D(value).isNeg()
      )
        throw new Error('Negative unreserved cash or collateral');
      if (account === 'DEBT' && new D(value).gt(0)) throw new Error('Debt cannot be an asset');
    }
    if (at < (this.entries.at(-1)?.at ?? 0)) throw new Error('Margin journal clock regression');
    const body = {
      sequence: this.entries.length + 1,
      at,
      kind,
      postings,
      balances: next,
      previousHash: this.entries.at(-1)?.hash ?? marginGenesis,
    };
    const entry = MarginJournalSchema.parse({ ...body, hash: canonicalHash(body) });
    deepFreeze(entry);
    this.balances = next;
    this.entries.push(entry);
    return entry;
  }
}
export function reconcileMarginResearchJournal(input: unknown) {
  if (!Array.isArray(input)) throw new Error('Margin journal required');
  const ledger = new MarginResearchLedger();
  for (const raw of input) {
    const entry = MarginJournalSchema.parse(raw),
      rebuilt = ledger.post(entry.at, entry.kind, entry.postings);
    if (canonicalHash(entry) !== canonicalHash(rebuilt))
      throw new Error('Margin journal reconciliation mismatch');
  }
  return ledger;
}
