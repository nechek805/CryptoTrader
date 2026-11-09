import { z } from 'zod';
import { LivePositionSchema } from './live-paper.js';
import { NewsPosition } from './news-forward.js';
export const TelegramSettings = z.strictObject({
  enabled: z.boolean(),
  token: z.string().regex(/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/),
  userId: z
    .string()
    .regex(/^[1-9]\d{0,15}$/)
    .refine((v) => Number.isSafeInteger(Number(v))),
  databaseUrl: z.string().url(),
  redisUrl: z.string().url(),
  dashboardUrl: z.string().url(),
});
export type TelegramConfig = z.infer<typeof TelegramSettings>;
export function telegramSettings(env: NodeJS.ProcessEnv): TelegramConfig {
  const parsed = TelegramSettings.safeParse({
    enabled: env.TELEGRAM_ENABLED === '1',
    token: env.TELEGRAM_BOT_TOKEN,
    userId: env.TELEGRAM_USER_ID,
    databaseUrl: env.TELEGRAM_DATABASE_URL,
    redisUrl: env.REDIS_URL,
    dashboardUrl: env.TELEGRAM_DASHBOARD_URL ?? 'http://127.0.0.1:3100/live-paper',
  });
  if (!parsed.success) throw new Error('INVALID_TELEGRAM_PRIVATE_CONFIGURATION');
  return parsed.data;
}
export const TelegramUpdate = z.looseObject({
  update_id: z.number().int().nonnegative(),
  message: z
    .looseObject({
      from: z.looseObject({ id: z.number().int(), is_bot: z.boolean() }).optional(),
      chat: z.looseObject({ id: z.number().int(), type: z.string() }),
      text: z.string().max(10000).optional(),
    })
    .optional(),
});
export type BotUpdate = z.infer<typeof TelegramUpdate>;
export function authorizedTelegramUpdate(update: BotUpdate, userId: string) {
  const m = update.message;
  return (
    !!m &&
    m.chat.type === 'private' &&
    String(m.chat.id) === userId &&
    m.from?.is_bot === false &&
    String(m.from.id) === userId
  );
}
const money = (n: string) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const utc = (n: number) => new Date(n).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
export function positionTelegramText(kind: 'OPEN' | 'CLOSE', input: unknown, dashboardUrl: string) {
  const p = z.union([LivePositionSchema, NewsPosition]).parse(input),
    first = p.fills[0]!,
    last = p.fills.at(-1)!;
  if (kind === 'CLOSE' && (p.lifecycle !== 'CLOSED' || p.closedAt === null))
    throw new Error('POSITION_NOT_CLOSED');
  return [
    `SIMULATED · POSITION ${kind === 'OPEN' ? 'OPENED' : 'CLOSED'}`,
    `${p.asset}/USDT · ${p.side} · ${p.exchange}`,
    `Strategy: ${p.strategy}`,
    `Entry value: ${money(p.notional)} USDT`,
    `Quantity: ${p.quantity} ${p.asset}`,
    `Entry price: ${p.entry} USDT`,
    ...(kind === 'OPEN'
      ? [
          `Stop: ${p.stop} · target: ${p.target}`,
          `Entry fee: ${money(first.fee)} USDT`,
          `Opened: ${utc(p.openedAt)}`,
        ]
      : [
          `Last exit fill: ${last.price} USDT`,
          `Result: ${p.status}`,
          `Net P&L: ${money(p.netPnl)} USDT`,
          `Fees: ${money(p.fees)} · borrowing: ${money(p.financing)} USDT`,
          `Exit reason: ${p.exitReason ?? 'EXIT'}`,
          `Closed: ${utc(p.closedAt!)}`,
        ]),
    `Position: ${p.id}`,
    `Run: ${p.runId}`,
    dashboardUrl,
  ].join('\n');
}
