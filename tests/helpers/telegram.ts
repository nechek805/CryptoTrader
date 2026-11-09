import { stepLiveRun } from '@crypto/paper';
import { liveTestRun, liveTestMarket, LIVE_TEST_TIME as T } from './live-paper.js';
export function telegramFixture() {
  const { run } = liveTestRun();
  run.pending['BINANCE:SOL'] = {
    side: 'LONG',
    createdAt: T,
    expiresAt: T + 90000,
    atr: '1',
    stopAtr: '2.5',
    targetAtr: '5',
    volume: '10000',
    decision: { origin: 'SYNTHETIC' },
  };
  const opened = stepLiveRun(run, [liveTestMarket(T + 1000)], T + 1000);
  const closed = stepLiveRun(
    opened.state,
    [liveTestMarket(T + 3000, 'BINANCE', 'SOL', 94)],
    T + 3000,
  );
  return { run, opened, closed, position: opened.positions[0]! };
}
