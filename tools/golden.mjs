/*
 * Golden screenshot comparison, with no dependencies beyond Node.
 *
 * A golden is compared per pixel with a tolerance, and a failure reports *where*
 * the images differ rather than just that they do, because "9.1% of pixels differ"
 * tells you nothing about whether that is one shifted label or a whole blank panel.
 * Decoding PNG without a library is not worth doing here, so the comparison runs on
 * the browser's own canvas: the screenshot bytes are handed to a page, drawn, and
 * read back with getImageData. That also makes the comparison the same operation in
 * CI and locally, on the same rasteriser.
 *
 * UPDATE_GOLDEN=1 records the current frames instead of comparing them. Every new or
 * changed baseline must be looked at before it is accepted -- a golden that records a
 * regression has only made the regression official.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const GOLDEN_DIR_DEFAULT = 'tests/golden';

export function goldenDir(root) {
  return path.resolve(root, process.env.GOLDEN_DIR ?? GOLDEN_DIR_DEFAULT);
}

export function shouldUpdate() {
  return process.env.UPDATE_GOLDEN === '1';
}

/**
 * Compare one PNG against its baseline. Returns null when they agree within
 * tolerance, otherwise a description of the mismatch.
 *
 * `maxDiffFraction` exists because Chromium's font hinting and antialiasing are not
 * bit-stable across runs on the same machine, so a zero tolerance would be a flaky
 * test that nobody trusts. It is not a licence to accept a big change: the fraction
 * is deliberately small, and the region report says where to look.
 */
export async function comparePng(page, currentPath, baselinePath, { maxDiffFraction = 0.002 } = {}) {
  const current = readFileSync(currentPath).toString('base64');
  const baseline = readFileSync(baselinePath).toString('base64');
  const result = await page.evaluate(async ([a, b]) => {
    const load = (data) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('could not decode PNG'));
      img.src = `data:image/png;base64,${data}`;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { sizeMismatch: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
    }
    const grab = (img) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, img.width, img.height).data;
    };
    const da = grab(ia); const db = grab(ib);
    // A channel difference of 2 per channel is invisible and covers subpixel text
    // hinting; anything larger is a change in what was drawn.
    const threshold = 2;
    let differing = 0;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let i = 0, p = 0; i < da.length; i += 4, p += 1) {
      const d = Math.max(
        Math.abs(da[i] - db[i]),
        Math.abs(da[i + 1] - db[i + 1]),
        Math.abs(da[i + 2] - db[i + 2]),
      );
      if (d > threshold) {
        differing += 1;
        const x = p % ia.width;
        const y = Math.floor(p / ia.width);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return { differing, total: da.length / 4, box: differing ? [minX, minY, maxX, maxY] : null };
  }, [current, baseline]);

  if (result.sizeMismatch) {
    return `size differs: ${result.sizeMismatch}`;
  }
  const fraction = result.differing / result.total;
  if (fraction <= maxDiffFraction) return null;
  const [x0, y0, x1, y1] = result.box ?? [];
  return (
    `${result.differing}/${result.total} pixels differ (${(fraction * 100).toFixed(2)}%, ` +
    `tolerance ${(maxDiffFraction * 100).toFixed(2)}%)` +
    (result.box ? `; changed region x:${x0}-${x1} y:${y0}-${y1}` : '')
  );
}

/** Every baseline that exists, for the "no baselines committed" guard. */
export function listGoldens(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : [];
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function readBaseline(dir, name) {
  const file = path.join(dir, name);
  return existsSync(file) ? readFileSync(file) : null;
}

export function writeBaseline(dir, name, bytes) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), bytes);
}
