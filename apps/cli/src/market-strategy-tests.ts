import { createMarketStrategyService } from '../../api/src/market-strategy-tests.js';

const service = await createMarketStrategyService('data/market-strategy-tests');
service.start();
let previous = '';
while (service.state().job?.status === 'RUNNING') {
  const message = service.state().job!.message;
  if (message !== previous) {
    process.stdout.write(message + '\n');
    previous = message;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
}
const state = service.state();
process.stdout.write(JSON.stringify(state) + '\n');
if (state.job?.status !== 'DONE') process.exitCode = 1;
else {
  const result = service.matrix()!;
  for (const row of result.matrix.rows)
    process.stdout.write(
      JSON.stringify({
        asset: row.asset,
        status: row.status,
        error: row.error,
        results: row.cells.map((c) => ({
          strategy: c.strategy,
          netPnl: c.summary.netPnl,
          trades: c.summary.closedTrades,
          fees: c.summary.fees,
          slippage: c.summary.slippage,
        })),
      }) + '\n',
    );
  if (process.argv.includes('--verify')) {
    const saved = service.state().fees;
    try {
      for (const on of [true, false]) {
        await service.setFees({ V1: on, V2: on, V3: on });
        for (const row of service.matrix()!.matrix.rows)
          for (const cell of row.cells) {
            const verified = await service.verify({ asset: row.asset, strategy: cell.strategy });
            process.stdout.write(
              `${row.asset} ${cell.strategy} fees ${on ? 'on' : 'off'}: verified ${verified.reportId}\n`,
            );
          }
      }
    } finally {
      await service.setFees(saved);
    }
  }
  if (result.matrix.rows.some((r) => r.status === 'FAILED')) process.exitCode = 1;
}
