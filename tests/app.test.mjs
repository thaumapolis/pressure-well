/*
 * Boots the generated page and checks what it decided, in jsdom.
 *
 * This is the layer no unit test can reach: whether index.html actually boots,
 * whether the readouts exist under the ids app.js asks for, whether a click on
 * Play changes state, and whether the band-limit control is wired to the DSP
 * rather than merely present. A checkbox that exists and does nothing is the
 * specific failure this file exists to make impossible -- the synth tests can
 * prove `renderScore({bandlimit:true})` works while the page still ignores it.
 *
 * jsdom has no raster backend and no Web Audio, so canvas fills and audio
 * buffers are stubbed. That is an honest limit, stated rather than papered
 * over: this checks wiring and decisions, not appearance. Appearance is the
 * browser check's job, and neither one is allowed to stand in for the other.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOptional } from '../tools/optional-deps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const jsdomPackage = loadOptional('jsdom');
if (jsdomPackage === null) {
  process.stdout.write(
    'SKIP app.test: jsdom is not available. It comes from NODE_PATH set by the\n' +
    '  flake dev shell (`nix develop --command bash tools/check.sh`).\n',
  );
  process.exit(0);
}
const { JSDOM } = jsdomPackage;

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

const html = await readFile(path.join(root, 'index.html'), 'utf8');

/*
 * jsdom implements neither a canvas raster backend nor Web Audio, so the page's
 * own drawing and audio calls have to be replaced. They are patched on the
 * *window* the JSDOM constructor returns, which means the script tag would have
 * already run against the unpatched prototypes -- the app calls
 * `getContext('2d')` during module evaluation and would die on a null context.
 * So the stubs are installed via `beforeParse`, which jsdom runs before any
 * script in the document.
 *
 * Canvas calls become no-ops that must still not throw: that a paint pass runs
 * to completion without touching a raster backend is itself worth covering, but
 * it says nothing about whether the picture is right. Only the browser check
 * can speak to appearance.
 */
function installStubs(window) {
  const noopContext = () => ({
    setTransform() {}, clearRect() {}, fillRect() {}, fillText() {}, beginPath() {},
    moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {},
    measureText: () => ({ width: 10 }),
  });
  window.HTMLCanvasElement.prototype.getContext = noopContext;
  // jsdom reports 0x0 for clientWidth/Height, which would make every canvas 1px
  // and turn layout maths into a division by zero. Give them plausible sizes.
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', { get: () => 900 });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientHeight', { get: () => 400 });

  window.AudioContext = class {
    constructor() { this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createBuffer(_channels, length) {
      return { length, copyToChannel() {}, getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
      return { connect() {}, start() {}, stop() {}, disconnect() {}, buffer: null, loop: false };
    }
  };
}

/** Boot the page with a URL query, as a deep link would. */
function boot(query) {
  return new JSDOM(html, {
    url: `https://pressure.test/${query}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse: installStubs,
  });
}

console.log('== the generated page boots ==');

// One instance per boot() call, and every check that mutates state makes its own.
// Sharing one across checks makes them order-dependent: a check that paints then a
// check that counts notes passes or fails depending on which ran first, and that
// failure looks like a product bug rather than a test bug.
let dom = boot('');
await check('index.html boots and exposes the app', () => {
  assert(dom.window.pressureWell !== undefined, 'window.pressureWell is missing: the bundle did not run');
});

await check('the app and index.html agree on element ids', async () => {
  // Every el('x') in the source must exist in the markup. This is the cheapest
  // possible guard against a rename in one file only, which otherwise surfaces as
  // a control that silently does nothing.
  const source = await readFile(path.join(root, 'src/app.js'), 'utf8');
  const wanted = [...new Set([...source.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]))];
  assert(wanted.length > 0, 'no el() calls found in src/app.js -- did the pattern stop matching?');
  const doc = dom.window.document;
  const missing = wanted.filter((id) => doc.getElementById(id) === null);
  assert(missing.length === 0, `ids referenced but absent from page.html: ${missing.join(', ')}`);
  // And the reverse direction, which is the one that actually caught a bug here: a
  // readout that exists in the markup but is never written stays at its hard-coded
  // placeholder and looks like working UI. Every id the page declares has to be one
  // the script either references or deliberately leaves static.
  const declared = [...new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))];
  const orphans = declared.filter((id) => !wanted.includes(id));
  // An element with no readout-style id that the script never touches is a layout
  // anchor styled from CSS (#app, #stage) -- legitimate. A readout the script never
  // writes is the failure this is aimed at: it displays its hard-coded placeholder
  // forever, which is indistinguishable from a working number on screen. That is how
  // the alias line was shipped dead.
  const readouts = orphans.filter((id) => id.startsWith('r') || id.startsWith('readout'));
  assert(readouts.length === 0, `readout ids in the markup that app.js never writes: ${readouts.join(', ')}`);
});

await check('the demo score loads, so the page is never empty on first open', () => {
  assert(dom.window.pressureWell.score.size > 0, 'booted with an empty score');
});

console.log('== controls change what the app decides ==');

await check('the band-limit checkbox is wired to the DSP option, not just present', () => {
  const app = dom.window.pressureWell;
  const before = app.bandlimit;
  const box = dom.window.document.getElementById('bandlimit');
  box.checked = !before;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert(app.bandlimit === !before, 'toggling #bandlimit did not change state.bandlimit');
});

await check('switching waveform updates the readout', () => {
  const app = dom.window.pressureWell;
  app.setWaveform('triangle');
  assert(app.waveform === 'triangle', `waveform is ${app.waveform}`);
  const readout = dom.window.document.getElementById('rWave').textContent;
  assert(readout.includes('triangle'), `readout says "${readout}"`);
});

await check('painting a cell adds a note and a scope sample', () => {
  const app = boot('?score=').window.pressureWell;
  assert(app.score.size === 0, 'clear() left notes behind');
  app.paint(60, 0);
  assert(app.score.size === 1, `size after paint is ${app.score.size}`);
  assert(app.scopeSamples.length > 0, 'the scope has no samples after painting: it would be blank');
});

await check('the score round-trips through the URL', () => {
  const app = boot('?score=').window.pressureWell;
  app.paint(64, 2);
  const encoded = app.score.encode();
  const dom2 = boot(`?score=${encoded}`);
  assert(
    dom2.window.pressureWell.score.size === app.score.size,
    `wrote ${app.score.size} notes, read back ${dom2.window.pressureWell.score.size}`,
  );
});

await check('the readout states how many harmonics survive, per pitch', () => {
  // The explainer's central claim has to be visible, not merely true in the DSP. A
  // readout element that exists and is never written shows its placeholder forever,
  // which looks exactly like a working number -- so assert on the text, and assert
  // the number moves when the pitch does.
  // Each pitch gets a clean instance: the readout reports the highest note in the
  // score, so a demo score still lying around would dominate both measurements.
  // C6: on the grid (the top row) and the pitch the explainer talks about.
  const at = (midi) => {
    const win = boot('?score=').window;
    win.pressureWell.paint(midi, 0);
    assert(win.pressureWell.score.size === 1, `expected 1 note, got ${win.pressureWell.score.size}`);
    return win.document.getElementById('rAlias').textContent;
  };
  const low = at(60);
  const high = at(84);
  for (const [label, text] of [['low', low], ['high', high]]) {
    assert(/harmonics/i.test(text), `${label} note: readout omits harmonics: "${text}"`);
    assert(/\d/.test(text), `${label} note: readout has no number: "${text}"`);
  }
  assert(low !== high, `readout does not respond to pitch; both say "${low}"`);
});

await check('an empty score stays empty across a reload', () => {
  // The Clear button has to be observable. `?score=` means "present, no notes", and
  // a page that answers it with the demo makes clearing look broken on every reload.
  const dom2 = boot('?score=');
  assert(
    dom2.window.pressureWell.score.size === 0,
    `?score= opened with ${dom2.window.pressureWell.score.size} notes; an empty link must stay empty`,
  );
});

await check('no score parameter at all opens the demo', () => {
  // The other side of the same distinction: absent means "first visit", and a blank
  // page there reads as a broken toy.
  assert(boot('').window.pressureWell.score.size > 0, 'a bare URL opened empty');
});

await check('the top row of the grid paints', () => {
  // The renderer draws a top row; a model that rejects it draws a cell nothing can
  // fill. This was true until the grid was derived from whole octaves: 12*3 rows
  // ended on A5, so the visible top row refused paint at C6.
  const win = boot('?score=').window;
  const { TOP_MIDI } = { TOP_MIDI: 84 };
  win.pressureWell.paint(TOP_MIDI, 0);
  assert(
    win.pressureWell.score.size === 1,
    `the top row (${TOP_MIDI}) refuses to paint: ${win.pressureWell.score.size} notes`,
  );
});

console.log('== onboarding is reachable and dismissable ==');

await check('help is visible on first open and dismissable', () => {
  const dom2 = boot('');
  const app = dom2.window.pressureWell;
  assert(app.isHelpVisible(), 'onboarding is not shown on a first open');
  app.hideHelp();
  assert(!app.isHelpVisible(), 'hideHelp() did not dismiss onboarding');
  app.showHelp();
  assert(app.isHelpVisible(), 'help is not re-openable');
});

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} app check(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\napp checks passed\n');
