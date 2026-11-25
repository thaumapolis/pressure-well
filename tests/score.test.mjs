import assert from 'node:assert/strict';
import { Score, COLS, ROWS, BASE_MIDI, OCTAVES, keyFor, pitchName } from '../src/score.js';

const failures = [];
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures.push(name); process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

process.stdout.write('== editing ==\n');

check('painting the same cell twice is idempotent', () => {
  const s = new Score();
  s.paint(60, 0); s.paint(60, 0); s.paint(60, 0);
  assert.equal(s.size, 1);
});

check('toggle paints then erases', () => {
  const s = new Score();
  assert.equal(s.toggle(60, 3), 'painted');
  assert.equal(s.has(60, 3), true);
  assert.equal(s.toggle(60, 3), 'erased');
  assert.equal(s.has(60, 3), false);
});

check('out-of-range edits are refused, not silently stored', () => {
  const s = new Score();
  assert.equal(s.paint(BASE_MIDI - 1, 0), false);
  assert.equal(s.paint(BASE_MIDI + ROWS * OCTAVES, 0), false);
  assert.equal(s.paint(60, -1), false);
  assert.equal(s.paint(60, COLS), false);
  assert.equal(s.size, 0);
});

process.stdout.write('== playback order ==\n');

check('cells are consumed in beat then pitch order', () => {
  const s = new Score([{ midi: 67, beat: 2 }, { midi: 60, beat: 0 }, { midi: 64, beat: 2 }]);
  assert.deepEqual(s.list().map((c) => `${c.midi}@${c.beat}`), ['60@0', '64@2', '67@2']);
});

check('polyphony at a beat counts voices, low to high', () => {
  const s = new Score([{ midi: 67, beat: 4 }, { midi: 52, beat: 4 }, { midi: 60, beat: 4 }, { midi: 55, beat: 5 }]);
  assert.deepEqual(s.atBeat(4).map((c) => c.midi), [52, 60, 67]);
  assert.equal(s.atBeat(5).length, 1);
  assert.equal(s.atBeat(6).length, 0);
});

process.stdout.write('== deep links ==\n');

check('a score round-trips through the URL form exactly', () => {
  const s = Score.demo();
  const back = Score.decode(s.encode());
  assert.equal(back.size, s.size);
  assert.deepEqual(back.list(), s.list());
});

check('an empty score round-trips', () => {
  assert.equal(Score.decode('').size, 0);
  assert.equal(new Score().encode(), '');
});

check('a malformed cell throws instead of being dropped', () => {
  // A silently dropped note would make a shared link play something other than
  // what the author heard, which is worse than an error.
  assert.throws(() => Score.decode('60.1-nonsense'), /malformed score cell/);
  assert.throws(() => Score.decode('60.1.5'), /malformed score cell/);
});

check('the demo score is a sane size for a URL', () => {
  const enc = Score.demo().encode();
  assert.ok(enc.length < 400, `demo score encodes to ${enc.length} chars`);
  assert.ok(Score.demo().size >= 16);
});

process.stdout.write('== keying ==\n');

check('keys are unique across the whole grid', () => {
  const seen = new Set();
  for (let midi = BASE_MIDI; midi < BASE_MIDI + ROWS * OCTAVES; midi += 1) {
    for (let beat = 0; beat < COLS; beat += 1) {
      const k = keyFor(midi, beat);
      assert.ok(!seen.has(k), `key collision at midi ${midi} beat ${beat}`);
      seen.add(k);
    }
  }
  assert.equal(seen.size, ROWS * OCTAVES * COLS);
});

check('pitch names are octave-independent and correct', () => {
  assert.equal(pitchName(60), 'C');   // middle C
  assert.equal(pitchName(48), 'C');   // one octave below
  assert.equal(pitchName(61), 'C#');
  assert.equal(pitchName(59), 'B');
});

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} score check(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nscore checks passed\n');
