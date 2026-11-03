import { SignalCandidateSchema, SpotCommandSchema, utcNanoseconds } from '@crypto/contracts';
import type {
  BacktestManifest,
  SpotSimulationRequest,
  ReplayArtifact,
  SpotCommand,
  MarketSizingAudit,
} from '@crypto/contracts';
import { canonicalHash, deterministicId, fromEpoch } from '@crypto/core';
import { sizeMarketTarget } from '@crypto/strategies';
import { simulateSpot } from './spot-simulator.js';
import { SpotEvidence } from './spot-evidence.js';
import { D, amount } from './spot-math.js';

/** Reconcile one target per delivered timestamp; sizing sees only a post-receipt execution prefix. */
export function compileMarketTargets(
  replay: Pick<ReplayArtifact, 'candidates'>,
  manifest: BacktestManifest,
  policy: SpotSimulationRequest,
  codeVersion: string,
) {
  const commands: SpotCommand[] = [],
    decisions: MarketSizingAudit[] = [],
    cancelled = new Set<string>(),
    lastPerTime = new Map(replay.candidates.map((c) => [c.decisionAt, c])),
    evidence = new SpotEvidence(
      {
        schemaVersion: 'spot-simulation-input.v1',
        market: manifest.input.market,
        bars: manifest.input.replay.bars,
        commands: [],
      },
      policy,
    );
  let lastTarget: 'FLAT' | 'LONG' = 'FLAT',
    epoch = 0,
    attemptedEpoch = -1;
  for (const c of lastPerTime.values()) {
    if (c.score.status !== 'KNOWN' || ![0, 1].includes(c.score.value))
      throw new Error('Only flat/long target-state scores are executable in spot');
    const target = c.score.value === 1 ? 'LONG' : 'FLAT';
    if (target !== lastTarget) {
      epoch++;
      lastTarget = target;
    }
    const placementAt = fromEpoch(utcNanoseconds(c.decisionAt) + 1n, 'nanoseconds'),
      audit: MarketSizingAudit = {
        candidateId: c.id,
        decisionAt: c.decisionAt,
        placementAt,
        target,
        heldQuantity: amount(0),
        quantity: amount(0),
        side: 'NONE',
        reason: 'TARGET_ALREADY_MET',
        prefixHash: null,
        commandIds: [],
      };
    if (placementAt >= policy.endAt) {
      audit.reason = 'END_OF_WINDOW';
      decisions.push(audit);
      continue;
    }
    const prefix = simulateSpot(
        {
          schemaVersion: 'spot-simulation-input.v1',
          market: manifest.input.market,
          bars: manifest.input.replay.bars,
          commands,
        },
        { ...policy, endAt: placementAt },
        codeVersion,
      ),
      pendingIds = new Set(
        prefix.trace
          .filter((t) => t.kind === 'FINALIZE' && t.reason === 'END_OF_RUN_RELEASE')
          .flatMap((t) => t.orderIds),
      ),
      pending = prefix.orders.filter((o) => pendingIds.has(o.order.id)),
      asset = prefix.balances.find(
        (b) => b.asset === manifest.series.asset && b.portfolio === 'BASELINE',
      ),
      held = amount(new D(asset?.free ?? 0).plus(asset?.reserved ?? 0));
    audit.prefixHash = canonicalHash(prefix);
    audit.heldQuantity = held;
    if (pending.length) {
      for (const o of pending) {
        const opposes = target === 'FLAT' ? o.intent.side === 'BUY' : o.intent.side === 'SELL';
        if (opposes && !cancelled.has(o.order.clientOrderId)) {
          const id = deterministicId('market-cancel', {
            candidate: c.id,
            client: o.order.clientOrderId,
          });
          commands.push(
            SpotCommandSchema.parse({
              kind: 'CANCEL',
              id,
              at: placementAt,
              sequence: commands.length + 1,
              portfolio: 'BASELINE',
              clientOrderId: o.order.clientOrderId,
            }),
          );
          cancelled.add(o.order.clientOrderId);
          audit.commandIds.push(id);
        }
      }
      audit.reason = 'WAIT_PENDING';
      decisions.push(audit);
      continue;
    }
    if (attemptedEpoch === epoch) {
      audit.reason = 'NO_RETRY_SAME_TARGET';
      decisions.push(audit);
      continue;
    }
    const meta = evidence.metadata(policy.instrumentKeys[0]!, c.decisionAt, c.decisionAt);
    if (!meta) {
      audit.reason = 'INELIGIBLE_METADATA';
      decisions.push(audit);
      continue;
    }
    const size = sizeMarketTarget({
      schemaVersion: 'market-target-sizing.v1',
      target,
      fixedQuantity: manifest.quantity,
      heldQuantity: held,
      quantityStep: meta.quantityStep,
    });
    audit.side = size.side;
    audit.quantity = size.quantity;
    if (size.side === 'NONE') {
      audit.reason = new D(size.targetQuantity).eq(held) ? 'TARGET_ALREADY_MET' : 'BELOW_LOT';
      attemptedEpoch = epoch;
      decisions.push(audit);
      continue;
    }
    const expires = fromEpoch(
        utcNanoseconds(placementAt) + BigInt(manifest.orderLifetimeSeconds) * 1000000000n,
        'nanoseconds',
      ),
      expiresAt = [expires, c.validUntil, policy.endAt].sort()[0]!;
    if (expiresAt <= placementAt) {
      audit.reason = 'END_OF_WINDOW';
      decisions.push(audit);
      continue;
    }
    const candidate = SignalCandidateSchema.parse({
        ...c,
        id: deterministicId('market-sized-candidate', {
          original: c.id,
          size,
          prefix: audit.prefixHash,
        }),
        decisionAt: placementAt,
        side: size.side === 'BUY' ? 'LONG' : 'SHORT',
        rationaleIds: [...c.rationaleIds, c.id],
        reproducibility: {
          ...c.reproducibility,
          modelVersion: 'market-target-sizing.v1',
          datasetHashes: [...c.reproducibility.datasetHashes, audit.prefixHash],
        },
      }),
      id = deterministicId('market-order', { candidate: c.id, epoch, side: size.side }),
      risk = {
        schemaVersion: 'risk-decision.v1',
        id: deterministicId('market-size-risk', { candidate: c.id, size }),
        candidateId: candidate.id,
        portfolio: 'BASELINE',
        decisionAt: placementAt,
        allowed: true,
        ruleIds: ['market:fixed-target-quantity.v1', 'market:post-receipt-inventory.v1'],
        sizing: {
          quantity: size.quantity,
          maxNotional: manifest.maxOrderNotional,
          currency: policy.quoteCurrency,
        },
        expiresAt,
        stopTargetPolicy: { kind: 'NONE' },
        audit: {
          inputHash: canonicalHash({ candidate, size, prefixHash: audit.prefixHash }),
          configHash: canonicalHash(policy),
          codeVersion: 'market-target-bridge.v1',
          reasons: [
            'Fixed unlevered target gap using only the execution prefix. Pending orders block replacement; executor retains final cash, inventory and notional vetoes.',
          ],
        },
      },
      intent = {
        clientOrderId: id,
        portfolio: 'BASELINE',
        instrumentKey: policy.instrumentKeys[0]!,
        side: size.side,
        orderType: 'MARKET',
        quantity: size.quantity,
        limitPrice: null,
        marketPriceBound: size.side === 'BUY' ? manifest.buyPriceCap : manifest.sellPriceFloor,
        allowPartial: true,
        expiresAt,
        protection: null,
      };
    commands.push(
      SpotCommandSchema.parse({
        kind: 'SUBMIT',
        id,
        at: placementAt,
        sequence: commands.length + 1,
        intent,
        candidate,
        risk,
      }),
    );
    audit.commandIds.push(id);
    audit.reason = 'SUBMIT';
    attemptedEpoch = epoch;
    decisions.push(audit);
    if (commands.length > 200) throw new Error('Market target command work budget');
  }
  return { commands, decisions };
}
