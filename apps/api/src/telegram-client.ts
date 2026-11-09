import { z } from 'zod';
import { TelegramUpdate } from '../../../packages/contracts/src/telegram.js';
export class TelegramFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}
const responseSchema = z.looseObject({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
  parameters: z
    .looseObject({ retry_after: z.number().int().min(0).max(86400).optional() })
    .optional(),
});
export class TelegramClient {
  constructor(
    private readonly token: string,
    readonly userId: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  private async call(
    method: 'getMe' | 'getWebhookInfo' | 'getChat' | 'getUpdates' | 'sendMessage',
    payload: Record<string, unknown> = {},
  ) {
    try {
      const r = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 25000 : 15000),
      });
      const reader = r.body?.getReader();
      if (!reader) throw new TelegramFailure('TELEGRAM_INVALID_RESPONSE');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const x = await reader.read();
          if (x.done) break;
          const chunk: unknown = x.value;
          if (!(chunk instanceof Uint8Array))
            throw new TelegramFailure('TELEGRAM_INVALID_RESPONSE');
          length += chunk.byteLength;
          if (length > 2_000_000) throw new TelegramFailure('TELEGRAM_RESPONSE_LIMIT');
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const parsed = responseSchema.safeParse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      );
      if (!parsed.success) throw new TelegramFailure('TELEGRAM_INVALID_RESPONSE');
      if (!r.ok || !parsed.data.ok)
        throw new TelegramFailure(
          `TELEGRAM_HTTP_${parsed.data.error_code ?? r.status}`,
          parsed.data.parameters?.retry_after === undefined
            ? undefined
            : Math.max(1000, parsed.data.parameters.retry_after * 1000),
        );
      return parsed.data.result;
    } catch (e) {
      if (e instanceof TelegramFailure) throw e;
      throw new TelegramFailure('TELEGRAM_NETWORK_OR_RESPONSE_ERROR');
    }
  }
  async identity() {
    return z
      .looseObject({
        id: z.number().int().positive(),
        is_bot: z.literal(true),
        username: z.string(),
      })
      .parse(await this.call('getMe'));
  }
  async webhookConfigured() {
    return z.looseObject({ url: z.string() }).parse(await this.call('getWebhookInfo')).url !== '';
  }
  async ownerChatAccessible() {
    try {
      const c = z
        .looseObject({ id: z.number().int(), type: z.string() })
        .parse(await this.call('getChat', { chat_id: this.userId }));
      return c.type === 'private' && String(c.id) === this.userId;
    } catch (e) {
      if (
        e instanceof TelegramFailure &&
        ['TELEGRAM_HTTP_400', 'TELEGRAM_HTTP_403'].includes(e.code)
      )
        return false;
      throw e;
    }
  }
  async updates(offset: number) {
    return z
      .array(TelegramUpdate)
      .max(100)
      .parse(
        await this.call('getUpdates', {
          offset,
          timeout: 10,
          limit: 50,
          allowed_updates: ['message'],
        }),
      );
  }
  async send(text: string) {
    if (!text || text.length > 4000) throw new TelegramFailure('TELEGRAM_MESSAGE_LENGTH');
    const m = z
      .looseObject({
        message_id: z.number().int(),
        chat: z.looseObject({ id: z.number().int(), type: z.string() }),
      })
      .parse(
        await this.call('sendMessage', {
          chat_id: this.userId,
          text,
          link_preview_options: { is_disabled: true },
        }),
      );
    if (String(m.chat.id) !== this.userId || m.chat.type !== 'private')
      throw new TelegramFailure('TELEGRAM_RECIPIENT_MISMATCH');
    return m.message_id;
  }
}
