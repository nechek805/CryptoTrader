import { it, expect, vi } from 'vitest';
import { buildNewsForwardApi } from '../apps/api/src/news-forward-api.js';
import { NewsForwardService } from '../apps/api/src/news-forward-service.js';
import { forwardFixture, forwardMarket, T } from './helpers/news-forward.js';
import { stageForwardNews, stepNewsForward } from '../packages/paper/src/news-forward-engine.js';
const origin = 'https://paper.example.test';
const security = {
  proxySecret: 'proxy-'.padEnd(40, 'p'),
  readerToken: 'reader-'.padEnd(40, 'r'),
  adminToken: 'admin-'.padEnd(40, 'a'),
  origins: [origin],
};
it('requires authenticated operator and allowed origin for controls; read credentials cannot start trades', async () => {
  const f = forwardFixture(),
    service = new NewsForwardService(
      'postgresql://fixture@127.0.0.1/never_connect',
      f.run.manifest.reportRunId,
      f.run.manifest.reportHash,
    );
  const command = vi.fn().mockResolvedValue({ status: 'RUNNING' }),
    app = buildNewsForwardApi(service, command, security);
  const request = (token: string, from?: string) =>
    app.inject({
      method: 'POST',
      url: '/news-paper/start',
      headers: { authorization: 'Bearer ' + token, ...(from ? { origin: from } : {}) },
      payload: {},
    });
  try {
    expect((await app.inject('/news-paper')).statusCode).toBe(401);
    expect((await request(security.readerToken, origin)).statusCode).toBe(403);
    expect((await request(security.adminToken, 'https://evil.invalid')).statusCode).toBe(403);
    expect((await request(security.adminToken)).statusCode).toBe(403);
    expect(command).not.toHaveBeenCalled();
    expect((await request(security.adminToken, origin)).statusCode).toBe(200);
    expect(command.mock.calls[0]![0]).toBe('START');
  } finally {
    await app.close();
    await service.close();
  }
});
it('validates filters and protects all exported rows against spreadsheet formulas', async () => {
  const f = forwardFixture(),
    service = new NewsForwardService(
      'postgresql://fixture@127.0.0.1/never_connect',
      f.run.manifest.reportRunId,
      f.run.manifest.reportHash,
    );
  const read = vi
    .spyOn(service.store, 'positions')
    .mockResolvedValue({ asOf: T, total: 0, page: 1, pageSize: 0, positions: [] });
  const app = buildNewsForwardApi(service, () => Promise.resolve({}), security);
  const headers = { authorization: 'Bearer ' + security.readerToken };
  try {
    expect(
      (await app.inject({ url: '/news-paper/positions?asset=FAKE', headers })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/news-paper/positions?sort=netPnl%27;DROP', headers })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: '/news-paper/positions?from=20&to=1', headers })).statusCode,
    ).toBe(400);
    for (const format of ['json', 'csv', 'tsv', 'md']) {
      const r = await app.inject({
        url: `/news-paper/export/${format}?asset=ETH&exchange=BINANCE&side=SHORT&sort=netPnl&direction=asc`,
        headers,
      });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-export-rows']).toBe('0');
    }
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({ asset: 'ETH', side: 'SHORT', sort: 'netPnl' }),
      true,
    );
    const position = stepNewsForward(
      stageForwardNews(f.run, [f], T + 2000).run,
      [forwardMarket(T + 3601000)],
      T + 3601000,
    ).positions[0]!;
    read.mockResolvedValue({
      asOf: T,
      total: 1,
      page: 1,
      pageSize: 1,
      positions: [{ ...position, exitReason: '=1+1' }],
    });
    const csv = await app.inject({ url: '/news-paper/export/csv', headers });
    expect(csv.body).toContain('"\'=1+1"');
  } finally {
    await app.close();
    await service.close();
  }
});
