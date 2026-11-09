import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { UnrecoverableError } from 'bullmq';
import { LiveRunSchema } from '@crypto/contracts';
import type { LiveRun } from '@crypto/contracts';
import type { LivePaperStore } from '@crypto/db';
export const PaperQueueCommandSchema = z.strictObject({
  id: z.string().uuid(),
  action: z.enum(['START', 'PAUSE', 'RESUME', 'STOP']),
  expectedRunId: z.string().uuid().nullable(),
  requestedAt: z.number().int().nonnegative(),
});
export type PaperQueueCommand = z.infer<typeof PaperQueueCommandSchema>;
export async function prepareQueueJournal(store: LivePaperStore, adapterHash: string) {
  const namespace = store.schema + '_queue';
  await store.pool.query(`CREATE SCHEMA IF NOT EXISTS ${namespace};
    CREATE TABLE IF NOT EXISTS ${namespace}.version(version integer PRIMARY KEY CHECK(version=1));
    INSERT INTO ${namespace}.version VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS ${namespace}.boots(id uuid PRIMARY KEY, at bigint NOT NULL, run_id uuid, engine_hash text, adapter_hash text NOT NULL, ledger_head text);
    CREATE UNIQUE INDEX IF NOT EXISTS queue_command_identity ON ${store.schema}.events ((data#>>'{event,queueCommandId}')) WHERE data#>>'{event,queueCommandId}' IS NOT NULL`);
  const run = await store.read();
  await store.pool.query(`INSERT INTO ${namespace}.boots VALUES($1,$2,$3,$4,$5,$6)`, [
    randomUUID(),
    Date.now(),
    run?.id ?? null,
    run?.engineHash ?? null,
    adapterHash,
    run?.lastEventHash ?? null,
  ]);
}
async function receipt(store: LivePaperStore, id: string) {
  const row = (
    await store.pool.query<{ revision: number; hash: string; data: unknown }>(
      `SELECT revision,hash,data FROM ${store.schema}.events WHERE data#>>'{event,queueCommandId}'=$1`,
      [id],
    )
  ).rows[0];
  if (!row) return null;
  const payload = z
    .object({
      event: z.object({ queueCommand: PaperQueueCommandSchema, queueResponse: LiveRunSchema }),
    })
    .parse(row.data);
  return {
    command: payload.event.queueCommand,
    state: LiveRunSchema.parse({
      ...payload.event.queueResponse,
      revision: row.revision,
      lastEventHash: row.hash,
    }),
  };
}
/** The single queue worker decorates only a command's transaction. Financial engine
 * sources remain frozen. Command identity and its response commit inside the same
 * immutable ledger event, so a retry after Redis/worker failure cannot act twice. */
export async function executePaperQueueCommand(
  store: LivePaperStore,
  input: unknown,
  operation: () => Promise<LiveRun | null>,
) {
  const command = PaperQueueCommandSchema.parse(input),
    previous = await receipt(store, command.id);
  if (previous) {
    if (previous.command.action !== command.action)
      throw new UnrecoverableError('Command identity reused with different input');
    return previous.state;
  }
  if (command.action !== 'STOP' && Date.now() - command.requestedAt > 120000)
    throw new UnrecoverableError('Queued command expired');
  if (command.requestedAt > Date.now() + 2000)
    throw new UnrecoverableError('Command clock is in the future');
  // Capture for restoration on this same object; calls use the bound copy below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalMethod = store.change,
    original = originalMethod.bind(store);
  let changed = false;
  store.change = (fn) =>
    original(async (current) => {
      if ((current?.id ?? null) !== command.expectedRunId)
        throw new UnrecoverableError('Queued command belongs to a different run');
      const next = await fn(current);
      if (!next) throw new UnrecoverableError('Command did not produce a transition');
      const event = z.record(z.string(), z.unknown()).parse(next.event);
      if (!['START', 'CONTROL'].includes(String(event.kind)))
        throw new UnrecoverableError('Unexpected queued command transition');
      changed = true;
      return {
        ...next,
        event: {
          ...event,
          queueCommandId: command.id,
          queueCommand: command,
          queueResponse: next.state,
        },
      };
    }, true);
  try {
    await operation();
  } finally {
    store.change = originalMethod;
  }
  const saved = await receipt(store, command.id);
  if (!changed || !saved) throw new Error('Queue command commit could not be confirmed');
  return saved.state;
}
