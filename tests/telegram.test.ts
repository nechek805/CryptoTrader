import { it, expect, vi } from 'vitest';
import {
  authorizedTelegramUpdate,
  TelegramUpdate,
  telegramSettings,
  positionTelegramText,
} from '../packages/contracts/src/telegram.js';
import { TelegramClient, TelegramFailure } from '../apps/api/src/telegram-client.js';
import { telegramFixture } from './helpers/telegram.js';
const token = '123456:synthetic_telegram_token_000000000000',
  user = '7';
const update = (from = 7, chat = 7, type = 'private') =>
  TelegramUpdate.parse({
    update_id: 1,
    message: { from: { id: from, is_bot: false }, chat: { id: chat, type }, text: '/positions' },
  });
const response = (result: unknown) =>
  new Response(JSON.stringify({ ok: true, result }), { status: 200 });
it('allows only the configured sender in that user’s private chat', () => {
  expect(authorizedTelegramUpdate(update(), user)).toBe(true);
  for (const u of [
    update(8, 8),
    update(8, 7),
    update(7, -3, 'group'),
    update(7, -3, 'supergroup'),
    { ...update(), message: undefined },
    TelegramUpdate.parse({
      update_id: 2,
      message: { from: { id: 7, is_bot: true }, chat: { id: 7, type: 'private' }, text: '/start' },
    }),
  ])
    expect(authorizedTelegramUpdate(u, user)).toBe(false);
});
it('reads credentials from environment and returns only a safe configuration error', () => {
  const env = {
    TELEGRAM_ENABLED: '1',
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_USER_ID: user,
    TELEGRAM_DATABASE_URL: 'postgresql://fixture@localhost/fixture',
    REDIS_URL: 'redis://localhost/0',
  };
  expect(telegramSettings(env).userId).toBe(user);
  expect(() => telegramSettings({ ...env, TELEGRAM_USER_ID: '-5' })).toThrow(
    'INVALID_TELEGRAM_PRIVATE_CONFIGURATION',
  );
  expect(() => telegramSettings({ ...env, TELEGRAM_BOT_TOKEN: 'secret-invalid' })).toThrow(
    'INVALID_TELEGRAM_PRIVATE_CONFIGURATION',
  );
});
it('formats distinct open/final close alerts with authoritative money, side, venue, time and position identity', () => {
  const { position, closed } = telegramFixture(),
    p = closed.positions[0]!;
  const opening = positionTelegramText('OPEN', p, 'https://example.test/live-paper');
  expect(opening).toContain('POSITION OPENED');
  expect(opening).toContain('SOL/USDT · LONG · BINANCE');
  expect(opening).not.toContain('Net P&L');
  expect(opening).toContain('Entry fee:');
  expect(opening).toContain(position.id);
  const closing = positionTelegramText('CLOSE', p, 'https://example.test/live-paper');
  expect(closing).toContain('POSITION CLOSED');
  expect(closing).toContain('Result: LOSS');
  expect(closing).toContain('Net P&L:');
  expect(closing).toContain('Fees:');
  expect(closing).toContain('SIMULATED');
  expect(() => positionTelegramText('CLOSE', position, 'https://example.test')).toThrow(
    'POSITION_NOT_CLOSED',
  );
});
it('sends only to the configured private recipient with plaintext and redirects forbidden', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response({ message_id: 11, chat: { id: 7, type: 'private' } }));
  const client = new TelegramClient(token, user, request);
  expect(await client.send('Synthetic notification')).toBe(11);
  const options = request.mock.calls[0]![1]!;
  const body = JSON.parse(options.body as string) as Record<string, unknown>;
  expect(body.chat_id).toBe(user);
  expect(body).not.toHaveProperty('parse_mode');
  expect(options.redirect).toBe('error');
});
it('redacts the bot credential from network and API failures, and honors flood-control retry-after', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('secret URL: ' + token))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: token,
          parameters: { retry_after: 3 },
        }),
        { status: 429 },
      ),
    );
  const client = new TelegramClient(token, user, request);
  await expect(client.send('Synthetic')).rejects.toThrow('TELEGRAM_NETWORK_OR_RESPONSE_ERROR');
  try {
    await client.send('Synthetic');
    throw Error('Expected failure');
  } catch (e) {
    expect(e).toBeInstanceOf(TelegramFailure);
    expect((e as TelegramFailure).retryAfterMs).toBe(3000);
    expect((e as Error).message).not.toContain(token);
  }
});
it('rejects unexpected recipients and oversized responses without disclosing response bodies', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ message_id: 1, chat: { id: 8, type: 'private' } }))
    .mockResolvedValueOnce(new Response('x'.repeat(2_000_001)));
  const client = new TelegramClient(token, user, request);
  await expect(client.send('Synthetic')).rejects.toThrow('TELEGRAM_RECIPIENT_MISMATCH');
  await expect(client.send('Synthetic')).rejects.toThrow('TELEGRAM_RESPONSE_LIMIT');
});
it('polls only message updates with a confirmed durable offset and a bounded long-poll timeout', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(response([update()]));
  const client = new TelegramClient(token, user, request);
  expect(await client.updates(55)).toHaveLength(1);
  expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
    offset: 55,
    timeout: 10,
    limit: 50,
    allowed_updates: ['message'],
  });
});
