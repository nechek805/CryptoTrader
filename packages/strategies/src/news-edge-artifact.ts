import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { canonicalHash, canonicalJson } from '@crypto/core';
import type { NewsEdgeModel } from '@crypto/contracts';
import { trainNewsEdge, validateNewsEdgeModel } from './news-edge.js';
const limit = 32 * 1024 * 1024;
export async function verifyNewsEdgeModel(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.size > limit) throw new Error('Invalid news edge artifact');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('News edge artifact byte limit');
  const model = validateNewsEdgeModel(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ),
    hash = canonicalHash(model);
  if (basename(path) !== `news-edge_${hash.slice(7)}.json`)
    throw new Error('News edge artifact identity mismatch');
  return { path, hash, model };
}
export async function writeNewsEdgeModel(input: unknown, outputRoot: string, codeVersion: string) {
  const model = trainNewsEdge(input, codeVersion),
    hash = canonicalHash(model),
    text = `${canonicalJson(model)}\n`;
  if (Buffer.byteLength(text) > limit) throw new Error('News edge artifact byte limit');
  await mkdir(outputRoot, { recursive: true });
  const root = await realpath(outputRoot),
    path = join(root, `news-edge_${hash.slice(7)}.json`),
    stage = join(root, `.news-edge-stage-${randomUUID()}`);
  const h = await open(stage, 'wx');
  try {
    try {
      await h.writeFile(text);
      await h.sync();
    } finally {
      await h.close();
    }
    try {
      await link(stage, path);
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
      const old = await verifyNewsEdgeModel(path);
      if (old.hash !== hash || !(await readFile(path)).equals(Buffer.from(text)))
        throw new Error('Existing immutable news edge artifact mismatch', { cause: e });
    }
  } finally {
    await unlink(stage);
  }
  return { path, hash, model };
}
export function newsEdgeMarkdown(m: NewsEdgeModel) {
  return `# Conditional news return hypotheses\n\nExecution DISABLED. ${m.synthetic ? 'SYNTHETIC diagnostic evidence only.' : 'Observational evidence; no promotion or execution authorization.'}\n\nData vintage ${m.dataVintage}; available ${m.availableAt}; input ${m.inputHash}; plan ${m.planHash}; software ${m.codeVersion}.\n\n| Hypothesis | Horizon seconds | TRAIN side | Selected on TRAIN | TRAIN units | VALIDATION units | TRAIN margin | VALIDATION margin | Reasons |\n| --- | ---: | --- | --- | ---: | ---: | --- | --- | --- |\n${m.fits.map((f) => `| ${f.hypothesisId} | ${f.horizonSeconds} | ${f.side} | ${f.selectedOnTraining} | ${f.training.independentUnits} | ${f.validation.independentUnits} | ${f.trainingMargin ?? 'MISSING'} | ${f.validationMargin ?? 'MISSING'} | ${f.reasons.join(', ')} |`).join('\n')}\n\nAll rows, exclusions, source/price/control IDs, matched baseline distributions and both conditional mean intervals are retained in the machine-readable model. Margin subtracts assumed costs and the fixed uncertainty buffer from the worse directional gross/excess interval bound. No individual return interval or event-truth probability is estimated.\n\n${m.warnings.map((w) => `- ${w}`).join('\n')}\n`;
}
