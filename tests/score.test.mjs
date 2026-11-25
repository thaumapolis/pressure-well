import assert from 'node:assert/strict';
import {
  Score,
  COLS,
  ROWS,
  BASE_MIDI,
  OCTAVES,
  keyFor,
  pitchName,
  PITCH_ROWS,
  TOP_MIDI,
} from '../src/score.js';

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
  // TOP_MIDI + 1, not BASE_MIDI + ROWS * OCTAVES: the grid now spans whole octaves
  // to C6, so that old first-rejected-pitch happens to be the top accepted row.
  assert.equal(s.paint(TOP_MIDI, 0), true, 'the top row must paint');
  assert.equal(s.erase(TOP_MIDI, 0), true);
  assert.equal(s.paint(TOP_MIDI + 1, 0), false);
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

check('the grid spans whole octaves and ends on a C', () => {
  // Derived, not hand-written: 12 semitones x 3 octaves plus the top C, so the grid
  // runs C3..C6. A 36-row grid would end on A5, making the top row an arbitrary
  // cutoff and silently rejecting a paint at C6 -- which is the pitch the whole
  // aliasing explanation uses, so "paint the highest cell you can see" would have
  // worked for everything except the example.
  assert.equal(PITCH_ROWS, ROWS * OCTAVES + 1);
  assert.equal(pitchName(BASE_MIDI), 'C');
  assert.equal(pitchName(TOP_MIDI), 'C');
});

check('every cell the grid can draw is a cell the grid accepts', () => {
  // The renderer draws PITCH_ROWS rows; the model must accept exactly those rows, at
  // both edges and in between. A mismatch is a row of the grid that cannot be painted.
  for (const beat of [0, 7, COLS - 1]) {
    assert.equal(new Score().inRange(BASE_MIDI, beat), true, 'bottom row rejected');
    assert.equal(new Score().inRange(TOP_MIDI, beat), true, 'top row rejected');
    assert.equal(new Score().inRange(BASE_MIDI - 1, beat), false, 'accepted below the grid');
    assert.equal(new Score().inRange(TOP_MIDI + 1, beat), false, 'accepted above the grid');
  }
});

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
