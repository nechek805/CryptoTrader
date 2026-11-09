import { LivePaperStore } from '@crypto/db';
import { verifyLiveRecording } from '@crypto/paper';
import { z } from 'zod';
const args = z
  .tuple([z.enum(['status', 'verify']), z.string().uuid().optional()])
  .parse([process.argv[2] ?? 'status', process.argv[3]]);
const url = process.env.LIVE_PAPER_DATABASE_URL;
if (!url) throw new Error('Set LIVE_PAPER_DATABASE_URL in .env');
const store = new LivePaperStore(url);
try {
  const result =
    args[0] === 'verify' ? await verifyLiveRecording(store, args[1]) : await store.read(args[1]);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  await store.close();
}
