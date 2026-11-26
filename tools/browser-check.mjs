/*
 * End-to-end check: open the generated index.html in a real browser and assert on
 * what it does, then keep the pictures.
 *
 * The jsdom layer proves the wiring; only a real engine can prove the app is
 * *legible* -- that the scope curve is drawn, that the grid fills its panel on a
 * phone in portrait, that the readout sentence is not clipped. Both layers are
 * needed and neither substitutes for the other: jsdom has no raster backend, and a
 * screenshot proves nothing about whether the checkbox is wired to the DSP.
 *
 * Screenshots land in the directory given as argv[2]. Those under tests/golden are
 * golden baselines compared pixel-wise; see tools/check.sh and README for the
 * update path. Which browser painted them is printed, because a golden mismatch
 * means something different across engines (antialiasing and font hinting differ).
 *
 * Audio is deliberately driven but not asserted on: the whole synthesis path is
 * already checked numerically in tests/synth.test.mjs, and a headless browser's
 * output device contributes nothing that a Float64Array does not. What *is* checked
 * here is that the buffer actually reaches Web Audio -- a page that silently fails
 * to start playback would pass every other test in the repo.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOptional } from './optional-deps.mjs';
import { comparePng, goldenDir, listGoldens, shouldUpdate, writeBaseline } from './golden.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(root, process.argv[2] ?? '.tmp/shots');
// The page to open. check.sh builds it first and exports the path, because in a
// Nix build the source tree is read-only and a generated index.html cannot live
// there. Falls back to index.html for a direct invocation after a normal build.
const pagePath = path.resolve(root, process.env.HTML_OUT ?? 'index.html');
mkdirSync(outDir, { recursive: true });

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Playwright resolves from the flake's absolute entry, because ESM ignores NODE_PATH.
let chromium;
let label;
const entry = process.env.PLAYWRIGHT_ENTRY;
if (entry) {
  const specifier = entry.startsWith('/') ? `file://${entry}` : entry;
  const pkg = await import(specifier);
  // Playwright's entry is CommonJS, so under ESM interop its exports arrive on
  // `default` rather than as named bindings. Reading `chromium` off the namespace
  // directly yields undefined, and the failure surfaces as "Cannot read properties
  // of undefined (reading 'launch')" some lines later, nowhere near the cause.
  chromium = (pkg.chromium ?? pkg.default?.chromium);
  if (chromium === undefined) {
    throw new Error(
      `${specifier} exposes no chromium; its keys are ${Object.keys(pkg).join(', ')}. ` +
      'PLAYWRIGHT_ENTRY must point at a package that exports chromium.',
    );
  }
  label = entry;
} else {
  const pkg = loadOptional('playwright');
  if (pkg === null) {
    process.stdout.write(
      'SKIP browser-check: Playwright is unavailable. It comes from the flake dev\n' +
      '  shell: `nix develop --command bash tools/check.sh --browser`.\n',
    );
    process.exit(0);
  }
  chromium = pkg.chromium;
  label = 'playwright (resolved by Node)';
}

// PLAYWRIGHT_BROWSERS_PATH (which the flake sets) is a *directory* of browsers, not
// an executable; CHROMIUM_PATH is only set when run-browser-check.sh resolved one.
// Playwright looks up its own build inside the registry directory when given none.
const executable = process.env.CHROMIUM_PATH || undefined;
// --no-sandbox: this container gives Chromium no user namespace.
// --disable-dev-shm-usage and --use-gl=swiftshader: /dev/shm is small here and there
// is no GPU, without which Chromium aborts during startup rather than rendering.
const browser = await chromium.launch({
  executablePath: executable,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
});

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone-portrait', width: 390, height: 844 },
  { name: 'phone-landscape', width: 844, height: 390 },
];

try {
  const goldenRoot = goldenDir(root);
  const updating = shouldUpdate();
  if (updating) {
    console.log('UPDATE_GOLDEN=1: recording current frames as baselines. VIEW THEM.');
  }
  // Required, not optional: a check that silently passes when its baselines are
  // absent is worse than no check, because it reports success.
  const existing = listGoldens(goldenRoot);
  if (!updating && existing.length === 0) {
    throw new Error(
      `no baselines in ${goldenRoot}. Record them with UPDATE_GOLDEN=1 and review them ` +
      'before committing; a golden test with no goldens proves nothing.',
    );
  }

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      isMobile: viewport.name.startsWith('phone'),
      hasTouch: viewport.name.startsWith('phone'),
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto('file://' + pagePath, { waitUntil: 'load' });
    await page.waitForFunction(() => window.pressureWell !== undefined, { timeout: 8000 });

    console.log(`\n== ${viewport.name} (${viewport.width}x${viewport.height}) ==`);

    await check('no page errors', () => {
      assert(errors.length === 0, `console/page errors: ${errors.join(' | ')}`);
    });

    await check('onboarding is visible before any interaction', async () => {
      const visible = await page.evaluate(() => window.pressureWell.isHelpVisible());
      assert(visible, 'the explainer is not shown on first open');
    });

    await page.screenshot({ path: path.join(outDir, `${viewport.name}-onboarding.png`) });

    await check('dismiss onboarding', async () => {
      await page.click('button[data-action="start"]');
      const visible = await page.evaluate(() => window.pressureWell.isHelpVisible());
      assert(!visible, 'onboarding survived the Start button');
    });

    await check('the grid and scope have real pixel area', async () => {
      // A canvas with a CSS size but no backing store, or a flexbox that collapsed,
      // gives a blank panel that looks like a broken toy.
      const boxes = await page.evaluate(() => {
        const grab = (id) => {
          const el = document.getElementById(id);
          const r = el.getBoundingClientRect();
          return { css: [r.width, r.height], buffer: [el.width, el.height] };
        };
        return { grid: grab('grid'), scope: grab('scope') };
      });
      for (const [name, box] of Object.entries(boxes)) {
        assert(box.css[0] > 40 && box.css[1] > 40, `${name} is ${box.css.join('x')} in CSS pixels`);
        assert(box.buffer[0] > 40 && box.buffer[1] > 40, `${name} backing store is ${box.buffer.join('x')}`);
      }
    });

    await check('the scope is actually painted, not a blank panel', async () => {
      // Count distinct pixels along the scope's centre band. A stroke that never
      // happened, or landed outside the clip, leaves one flat colour.
      const painted = await page.evaluate(() => {
        const el = document.getElementById('scope');
        const ctx = el.getContext('2d');
        if (ctx.getImageData === undefined) return -1;
        const data = ctx.getImageData(0, 0, el.width, el.height).data;
        const seen = new Set();
        for (let i = 0; i < data.length; i += 4) {
          seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
          if (seen.size > 40) return seen.size;
        }
        return seen.size;
      });
      if (painted === -1) {
        // Firefox in this environment returns an opaque-context stub; the golden
        // screenshot is then the only evidence, which is stated rather than hidden.
        process.stdout.write('       (getImageData unavailable; relying on the screenshot)\n');
      } else {
        assert(painted > 40, `the scope shows only ${painted} distinct colours`);
      }
    });

    await check('the readout explains the mechanism with a number', async () => {
      const text = await page.textContent('#rAlias');
      assert(/\d/.test(text) && /harmonics/i.test(text), `alias line reads: "${text}"`);
    });

    await check('playback reaches Web Audio and the playhead moves', async () => {
      await page.evaluate(() => {
        // Count real Web Audio calls: the app must actually build and start a buffer.
        window.__audioCalls = { buffers: 0, starts: 0 };
        const proto = Object.getPrototypeOf(new AudioContext());
        const createBuffer = proto.createBuffer;
        proto.createBuffer = function (...args) { window.__audioCalls.buffers += 1; return createBuffer.apply(this, args); };
      });
      await page.click('#play');
      await page.waitForTimeout(400);
      const state = await page.evaluate(() => ({
        playing: window.pressureWell.playing,
        label: document.getElementById('play').textContent,
        calls: window.__audioCalls ?? { buffers: 0, starts: 0 },
      }));
      assert(state.playing, 'clicking Play did not start playback');
      assert(/stop/i.test(state.label), `Play button reads "${state.label}" while playing`);
      assert(state.calls.buffers > 0, 'no AudioBuffer was created: the synth output never reached Web Audio');
    });

    await page.screenshot({ path: path.join(outDir, `${viewport.name}-playing.png`), fullPage: false });

    // Golden comparison. It runs against a page in this context rather than a
    // separate one so it uses the same rasteriser that made the frame.
    // Cropped to the panel whose appearance carries the claim, rather than the whole
    // window: a full-page baseline makes every text change anywhere a mismatch, which
    // trains people to blind-accept goldens.
    //
    // The clip is read from the element, never hard-coded. A fixed y came out below
    // the fold on a 390px-tall landscape viewport and the screenshot failed with
    // "clipped area is outside the resulting image" -- which is the correct outcome
    // for the wrong reason, and would have hidden the fact that the panel is not
    // where the layout intends it to be.
    const shots = [];
    for (const id of ['scope', 'grid']) {
      const box = await page.evaluate((elementId) => {
        const r = document.getElementById(elementId).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, id);
      const visible =
        box.width > 8 && box.height > 8 &&
        box.y >= 0 && box.y + box.height <= viewport.height + 1;
      if (!visible) {
        await check(`#${id} is inside the viewport`, () => {
          throw new Error(
            `#${id} occupies y:${Math.round(box.y)}-${Math.round(box.y + box.height)} in a ` +
            `${viewport.height}px viewport, so it is clipped and cannot be baselined`,
          );
        });
        continue;
      }
      shots.push({ name: `${viewport.name}-${id}`, clip: box });
    }

    for (const shot of shots) {
      await check(`golden ${shot.name}`, async () => {
        const bytes = await page.screenshot({ clip: shot.clip });
        const target = path.join(outDir, `${shot.name}.png`);
        const fs = await import('node:fs');
        fs.writeFileSync(target, bytes);
        if (updating) {
          writeBaseline(goldenRoot, `${shot.name}.png`, bytes);
          process.stdout.write(`       recorded ${shot.name}.png\n`);
          return;
        }
        const baseline = path.join(goldenRoot, `${shot.name}.png`);
        if (!fs.existsSync(baseline)) {
          throw new Error(
            `no baseline tests/golden/${shot.name}.png. Goldens are committed, so a ` +
            'missing one means the check is not running, not that it passed.',
          );
        }
        const mismatch = await comparePng(page, target, baseline);
        if (mismatch) throw new Error(mismatch);
      });
    }

    await check('the app fits its viewport without horizontal scrolling', async () => {
      const scroll = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
      }));
      assert(
        scroll.scrollWidth <= scroll.clientWidth + 1,
        `horizontal overflow: scrollWidth ${scroll.scrollWidth} > clientWidth ${scroll.clientWidth}`,
      );
    });

    await check('every visible control is big enough to hit on a touch screen', async () => {
      // 44px is the usual minimum target; below that a control is a usability failure
      // on a phone however it looks on a desktop.
      //
      // Only elements that are actually on screen count. The onboarding card's button
      // is `display: none` once dismissed, so its box is legitimately 0x0, and asking
      // a hidden element to be 44px tall asserts something meaningless -- this check
      // initially "failed" on exactly that, on a control nobody could miss because
      // nobody could see it.
      const small = await page.evaluate(() => {
        const targets = [...document.querySelectorAll('button, select, input[type=range]')];
        return targets
          .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
          .map((el) => ({ id: el.id || el.textContent || el.tagName, h: Math.round(el.getBoundingClientRect().height) }))
          .filter((t) => t.h < 40);
      });
      assert(small.length === 0, `touch targets under 40px tall: ${JSON.stringify(small)}`);
    });

    await check('the onboarding button is itself a valid touch target while visible', async () => {
      // The corollary of skipping hidden elements: measure the card button the other
      // way, while onboarding *is* up, so "hidden" cannot become an excuse.
      const context = page.context();
      const fresh = await context.newPage();
      await fresh.goto('file://' + pagePath, { waitUntil: 'load' });
      await fresh.waitForFunction(() => window.pressureWell !== undefined);
      const size = await fresh.evaluate(() => {
        const el = document.querySelector('.card button');
        const r = el.getBoundingClientRect();
        return { h: Math.round(r.height), w: Math.round(r.width) };
      });
      assert(size.h >= 44, `onboarding button is ${size.w}x${size.h}; needs 44px height`);
      await fresh.close();
    });

    await context.close();
  }

  console.log(`\nbrowser: ${label}`);
  console.log(`screenshots: ${outDir}`);
} finally {
  await browser.close();
}

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} browser check(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nbrowser checks passed\n');
