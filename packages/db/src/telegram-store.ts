import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LivePositionSchema } from '../../contracts/src/live-paper.js';
import { NewsPosition } from '../../contracts/src/news-forward.js';
import { positionTelegramText, authorizedTelegramUpdate } from '../../contracts/src/telegram.js';
import type { BotUpdate } from '../../contracts/src/telegram.js';
const fillEvent = z.looseObject({
  kind: z.string(),
  positionId: z.string().uuid().optional(),
  fill: z.looseObject({ at: z.number().int() }).optional(),
});
const payload = z.looseObject({
  event: z.looseObject({ kind: z.string(), events: z.array(fillEvent).max(100).optional() }),
});
type Delivery = { id: string; text: string; attempts: number; status: string };
export class TelegramStore {
  readonly pool: Pool;
  private lease: PoolClient | null = null;
  constructor(
    url: string,
    readonly channel: string,
    readonly dashboardUrl: string,
    readonly schema = 'crypto_telegram_v1',
    readonly ledger = 'crypto_live_paper_v1',
  ) {
    if (
      !/^(crypto_telegram_v1|crypto_telegram_test_[a-f0-9]{32})$/.test(schema) ||
      !/^(crypto_live_paper_v1|crypto_live_test_[a-f0-9]{32}|crypto_news_forward_v1|crypto_news_forward_test_[a-f0-9]{32})$/.test(
        ledger,
      )
    )
      throw Error('INVALID_TELEGRAM_NAMESPACE');
    this.pool = new Pool({
      connectionString: url,
      max: 3,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      idle_in_transaction_session_timeout: 15000,
    });
    this.pool.on('error', () => {});
  }
  async migrate() {
    // PostgreSQL checks database CREATE even for CREATE SCHEMA IF NOT EXISTS.
    // Production provisions this schema separately; the notifier has no database CREATE.
    const existing = await this.pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [
      this.schema,
    ]);
    if (!existing.rowCount) await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.schema}.channels(channel text PRIMARY KEY,initialized_at bigint NOT NULL,update_offset bigint NOT NULL DEFAULT 0,ready boolean NOT NULL DEFAULT false);
    CREATE TABLE IF NOT EXISTS ${this.schema}.cursors(channel text NOT NULL REFERENCES ${this.schema}.channels,run_id uuid NOT NULL,revision integer NOT NULL,PRIMARY KEY(channel,run_id));
    CREATE TABLE IF NOT EXISTS ${this.schema}.outbox(id uuid PRIMARY KEY,sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,channel text NOT NULL REFERENCES ${this.schema}.channels,event_key text NOT NULL,text text NOT NULL,
      created_at bigint NOT NULL,status text NOT NULL DEFAULT 'PENDING',attempts integer NOT NULL DEFAULT 0,message_id bigint,last_error text,sent_at bigint,UNIQUE(channel,event_key));
    CREATE INDEX IF NOT EXISTS telegram_pending ON ${this.schema}.outbox(channel,status,created_at);`);
  }
  async acquire() {
    const c = await this.pool.connect();
    const r = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [
      'telegram:' + this.channel,
    ]);
    if (!r.rows[0]!.ok) {
      c.release();
      throw Error('TELEGRAM_ALREADY_RUNNING');
    }
    this.lease = c;
    return c;
  }
  async initialize() {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const inserted = await c.query(
        `INSERT INTO ${this.schema}.channels(channel,initialized_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING channel`,
        [this.channel, Date.now()],
      );
      if (inserted.rowCount)
        await c.query(
          `INSERT INTO ${this.schema}.cursors(channel,run_id,revision)
        SELECT $1,r.id,COALESCE(max(e.revision),-1) FROM ${this.ledger}.runs r LEFT JOIN ${this.ledger}.events e ON e.run_id=r.id GROUP BY r.id`,
          [this.channel],
        );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  private async enqueue(c: PoolClient, key: string, text: string) {
    await c.query(
      `INSERT INTO ${this.schema}.outbox(id,channel,event_key,text,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(channel,event_key) DO NOTHING`,
      [randomUUID(), this.channel, key, text, Date.now()],
    );
  }
  async collect() {
    const c = await this.pool.connect();
    let added = 0;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await c.query(`SELECT channel FROM ${this.schema}.channels WHERE channel=$1 FOR UPDATE`, [
        this.channel,
      ]);
      await c.query(
        `INSERT INTO ${this.schema}.cursors(channel,run_id,revision) SELECT $1,id,-1 FROM ${this.ledger}.runs ON CONFLICT DO NOTHING`,
        [this.channel],
      );
      const cursors = await c.query<{ run_id: string; revision: number }>(
        `SELECT run_id,revision FROM ${this.schema}.cursors WHERE channel=$1 ORDER BY run_id`,
        [this.channel],
      );
      for (const cursor of cursors.rows) {
        const rows = await c.query<{ revision: number; data: unknown }>(
          `SELECT revision,data FROM ${this.ledger}.events WHERE run_id=$1 AND revision>$2 ORDER BY revision LIMIT 100`,
          [cursor.run_id, cursor.revision],
        );
        for (const row of rows.rows) {
          if (row.revision !== cursor.revision + 1) throw Error('TELEGRAM_LEDGER_GAP');
          const e = payload.parse(row.data);
          for (const f of e.event.events ?? []) {
            if (!['OPEN_FILL', 'CLOSE_FILL'].includes(f.kind) || !f.positionId || !f.fill) continue;
            const p = await c.query<{ data: unknown }>(
              `SELECT data FROM ${this.ledger}.positions WHERE id=$1 AND run_id=$2`,
              [f.positionId, cursor.run_id],
            );
            if (!p.rows[0]) throw Error('TELEGRAM_POSITION_MISSING');
            const position = z.union([LivePositionSchema, NewsPosition]).parse(p.rows[0].data),
              kind = f.kind === 'OPEN_FILL' ? 'OPEN' : 'CLOSE';
            if (
              kind === 'CLOSE' &&
              (position.lifecycle !== 'CLOSED' || position.closedAt !== f.fill.at)
            )
              continue;
            await this.enqueue(
              c,
              `${kind}:${position.id}`,
              positionTelegramText(kind, position, this.dashboardUrl),
            );
            added++;
          }
          cursor.revision = row.revision;
        }
        await c.query(
          `UPDATE ${this.schema}.cursors SET revision=$3 WHERE channel=$1 AND run_id=$2`,
          [this.channel, cursor.run_id, cursor.revision],
        );
      }
      await c.query('COMMIT');
      return added;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async setReady(ready: boolean) {
    await this.pool.query(`UPDATE ${this.schema}.channels SET ready=$2 WHERE channel=$1`, [
      this.channel,
      ready,
    ]);
  }
  async ready() {
    return (
      await this.pool.query<{ ready: boolean }>(
        `SELECT ready FROM ${this.schema}.channels WHERE channel=$1`,
        [this.channel],
      )
    ).rows[0]!.ready;
  }
  async welcome() {
    const c = await this.pool.connect();
    try {
      await this.enqueue(
        c,
        'WELCOME',
        'Crypto Trader notifications connected.\nSIMULATED positions only.\nAlerts for new opens and completed closes are enabled.\nCommands: /status /positions /help\n' +
          this.dashboardUrl,
      );
    } finally {
      c.release();
    }
  }
  async offset() {
    return Number(
      (
        await this.pool.query<{ update_offset: string }>(
          `SELECT update_offset FROM ${this.schema}.channels WHERE channel=$1`,
          [this.channel],
        )
      ).rows[0]!.update_offset,
    );
  }
  async command(update: BotUpdate, userId: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const current = await c.query<{ update_offset: string }>(
        `SELECT update_offset FROM ${this.schema}.channels WHERE channel=$1 FOR UPDATE`,
        [this.channel],
      );
      if (update.update_id < Number(current.rows[0]!.update_offset)) {
        await c.query('COMMIT');
        return;
      }
      if (authorizedTelegramUpdate(update, userId)) {
        const command = update.message!.text?.trim().split(/\s/)[0]?.split('@')[0]?.toLowerCase();
        let text =
          'Crypto Trader · SIMULATED\n/status — current paper run\n/positions — open positions\n/help — commands\n' +
          this.dashboardUrl;
        if (command === '/status') {
          const run = (
            await c.query<{ status: string; started_at: string }>(
              `SELECT status,started_at FROM ${this.ledger}.runs ORDER BY started_at DESC LIMIT 1`,
            )
          ).rows[0];
          const counts = await c.query<{ open: string; closed: string }>(
            `SELECT count(*) FILTER(WHERE data->>'lifecycle'<>'CLOSED') AS open,count(*) FILTER(WHERE data->>'lifecycle'='CLOSED') AS closed FROM ${this.ledger}.positions`,
          );
          text = `Crypto Trader · SIMULATED\nLatest run: ${run?.status ?? 'No run'}\nOpen positions: ${counts.rows[0]!.open}\nClosed positions: ${counts.rows[0]!.closed}\n${this.dashboardUrl}`;
        } else if (command === '/positions') {
          const rows = await c.query<{ data: unknown }>(
            `SELECT data FROM ${this.ledger}.positions WHERE data->>'lifecycle'<>'CLOSED' ORDER BY (data->>'openedAt')::bigint DESC LIMIT 10`,
          );
          text =
            'SIMULATED · OPEN POSITIONS\n' +
            (rows.rows.length
              ? rows.rows
                  .map((r) => {
                    const p = z.union([LivePositionSchema, NewsPosition]).parse(r.data);
                    return `${p.exchange} · ${p.asset} ${p.side}\n${p.notional} USDT · entry ${p.entry}\nStatus: ${p.lifecycle} · marked net P&L ${p.netPnl} USDT`;
                  })
                  .join('\n\n')
              : 'No open positions.') +
            '\n' +
            this.dashboardUrl;
        }
        await this.enqueue(c, 'COMMAND:' + update.update_id, text.slice(0, 4000));
        await c.query(`UPDATE ${this.schema}.channels SET ready=true WHERE channel=$1`, [
          this.channel,
        ]);
        if (command === '/start')
          await c.query(
            `UPDATE ${this.schema}.outbox SET status='PENDING',attempts=0,last_error=null WHERE channel=$1 AND status='FAILED'`,
            [this.channel],
          );
      }
      await c.query(`UPDATE ${this.schema}.channels SET update_offset=$2 WHERE channel=$1`, [
        this.channel,
        update.update_id + 1,
      ]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async pending() {
    return (
      await this.pool.query<{ id: string }>(
        `SELECT p.id FROM ${this.schema}.outbox p WHERE p.channel=$1 AND p.status IN ('PENDING','SENDING')
        AND (p.event_key NOT LIKE 'CLOSE:%' OR NOT EXISTS(SELECT 1 FROM ${this.schema}.outbox o
          WHERE o.channel=p.channel AND o.event_key='OPEN:'||split_part(p.event_key,':',2) AND o.status<>'SENT'))
        ORDER BY p.sequence LIMIT 100`,
        [this.channel],
      )
    ).rows;
  }
  async beginSend(id: string) {
    return (
      (
        await this.pool.query<Delivery>(
          `UPDATE ${this.schema}.outbox SET status='SENDING',attempts=attempts+1 WHERE id=$1 AND channel=$2 AND status IN ('PENDING','SENDING') RETURNING id,text,attempts,status`,
          [id, this.channel],
        )
      ).rows[0] ?? null
    );
  }
  async sent(id: string, messageId: number) {
    await this.pool.query(
      `UPDATE ${this.schema}.outbox SET status='SENT',message_id=$3,sent_at=$4,last_error=null WHERE id=$1 AND channel=$2`,
      [id, this.channel, messageId, Date.now()],
    );
  }
  async failed(id: string, code: string, final = false) {
    await this.pool.query(
      `UPDATE ${this.schema}.outbox SET status=$3,last_error=$4 WHERE id=$1 AND channel=$2 AND status<>'SENT'`,
      [id, this.channel, final ? 'FAILED' : 'PENDING', code],
    );
  }
  async close() {
    this.lease?.release();
    this.lease = null;
    await this.pool.end();
  }
}
