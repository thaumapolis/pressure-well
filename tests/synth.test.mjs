/**
 * tests/synth.test.mjs — the audio mechanism, checked numerically in node.
 *
 * These are the checks that make the project cheap to change: no browser, no
 * speakers, no screenshots, no judgement calls. If tuning, envelope or mixing
 * regresses, one of these fails with a number in it.
 *
 * The pitch estimator is autocorrelation, NOT zero-crossing counting. That choice
 * is load-bearing and was learned the hard way: zero crossings on a square wave
 * report the odd harmonics, so the same correct signal measured -46% error under
 * one estimator and +0.53% under the other. Every estimator here is therefore
 * pinned against a case whose answer is known by construction (A4 = 440 Hz), the
 * way any new measurement should be before it is trusted to kill a mechanism.
 */
import assert from 'node:assert/strict';
import {
  SAMPLE_RATE, midiToFreq, renderScore, analyse, envelope, shape, Waveform,
  DEFAULT_ENVELOPE, VOICE_GAIN,
} from '../src/synth.js';

const failures = [];
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures.push({ name, message: error.message });
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
  }
}

/** Autocorrelated fundamental of a segment, over the range this project uses. */
function detectPitch(samples) {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const centred = samples.map((v) => v - mean);
  let bestLag = 0;
  let bestScore = -Infinity;
  const lo = Math.floor(SAMPLE_RATE / 520);
  const hi = Math.floor(SAMPLE_RATE / 180);
  for (let lag = lo; lag < hi; lag += 1) {
    let sum = 0;
    for (let i = 0; i < centred.length - lag; i += 2) sum += centred[i] * centred[i + lag];
    if (sum > bestScore) { bestScore = sum; bestLag = lag; }
  }
  return SAMPLE_RATE / bestLag;
}

process.stdout.write('== tuning ==\n');

// The known-answer case: 440 Hz is the definition, so any estimator that fails
// this one is broken, regardless of what it says about everything else.
check('A4 is 440 Hz by definition', () => {
  assert.equal(midiToFreq(69), 440);
});

check('octave doubles frequency', () => {
  assert.ok(Math.abs(midiToFreq(81) - 2 * midiToFreq(69)) < 1e-9);
});

check('one semitone is the twelfth root of two', () => {
  const ratio = midiToFreq(70) / midiToFreq(69);
  assert.ok(Math.abs(ratio - Math.pow(2, 1 / 12)) < 1e-12);
});

check('all 12 semitones of C4..B4 are audible within 1%', () => {
  // 1% is deliberately loose: the autocorrelation lag is a whole number of samples,
  // so the estimator's own resolution is the binding constraint, not the synth.
  const notes = Array.from({ length: 12 }, (_, i) => ({ midi: 57 + i, beat: i * 0.5, beats: 0.4 }));
  const out = renderScore(notes, { bpm: 132, waveform: Waveform.Square });
  const beatSeconds = 60 / 132;
  for (let k = 0; k < 12; k += 1) {
    const from = Math.floor((k * 0.5 * beatSeconds + 0.03) * SAMPLE_RATE);
    const to = Math.floor((k * 0.5 * beatSeconds + 0.30) * SAMPLE_RATE);
    const measured = detectPitch(out.slice(from, to));
    const expected = midiToFreq(57 + k);
    const errorPercent = 100 * (measured / expected - 1);
    assert.ok(
      Math.abs(errorPercent) < 1,
      `midi ${57 + k}: expected ${expected.toFixed(1)} Hz, measured ${measured.toFixed(1)} Hz (${errorPercent.toFixed(2)}%)`,
    );
  }
});

process.stdout.write('== envelope ==\n');

check('envelope is silent before the attack and after the release', () => {
  const t = DEFAULT_ENVELOPE;
  assert.equal(envelope(-1, 1, t), 0);
  assert.equal(envelope(1 + t.release, 1, t), 0);
});

check('envelope peaks at 1 and decays to the sustain plateau', () => {
  const t = DEFAULT_ENVELOPE;
  assert.equal(envelope(t.attack, 1, t), 1);
  assert.equal(envelope(t.attack + t.decay, 1, t), t.sustain);
});

check('envelope never returns a non-finite number across a note', () => {
  const t = DEFAULT_ENVELOPE;
  for (let i = 0; i < 2000; i += 1) {
    const v = envelope(i / 4000, 0.4, t);
    assert.ok(Number.isFinite(v), `non-finite at ${i / 4000}s`);
  }
});

process.stdout.write('== waveforms ==\n');

check('each waveform spans [-1,1] and is finite', () => {
  // Endpoints included on purpose. Sampling `i/4096` for i < 4096 never reaches
  // phase 1.0, so it cannot see a discontinuity -- which is exactly how the saw's
  // wrap bug stayed invisible: it returns -1 at the wrap, and a test that stops at
  // 0.9995 reports "max 0.9995" as if the function were merely imprecise.
  for (const name of Object.values(Waveform)) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i <= 4096; i += 1) {
      const v = shape(name, i / 4096);
      assert.ok(Number.isFinite(v), `${name} non-finite at phase ${i / 4096}`);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    assert.ok(Math.abs(min + 1) < 1e-9, `${name} min was ${min}`);
    // Asserted strictly below 1 rather than equal to it. The point is boundedness --
    // exceeding 1 is what clips -- and float64 `% 1` never yields exactly 1.0, so
    // `2*phase - 1` never reaches 1.000... Verified empirically across midi 36-96:
    // zero samples equal 1.0, and the largest saw sample observed was 0.9995.
    // Bounded, not necessarily attained. A square or saw holds a plateau at
    // exactly +/-1 before the envelope, so those waveforms really do reach the
    // boundary; a triangle's peak lands between samples, so on a 4096-step scan
    // it tops out at 0.9985. Requiring == 1 would assert a property of the scan
    // grid, not of the waveform.
    assert.ok(max <= 1, `${name} max was ${max}, which is out of range`);
    assert.ok(max > 0.99, `${name} max was only ${max}`);
  }
});

check('the saw wraps to -1 at the discontinuity instead of spiking to +1', () => {
  // The regression this guards is audible as a click on every saw note whose
  // period does not divide the buffer, and it once made a 12-note chord peak at 2.64.
  assert.equal(shape(Waveform.Saw, 0), -1);
  assert.equal(shape(Waveform.Saw, 1), -1);
});

check('an unknown waveform throws rather than silently going quiet', () => {
  assert.throws(() => shape('triangle-but-not', 0.2), /unknown waveform/);
});

process.stdout.write('== mixing ==\n');

check('a rendered score contains no non-finite samples', () => {
  const notes = Array.from({ length: 24 }, (_, i) => ({ midi: 45 + i, beat: i * 0.25, beats: 1 }));
  const out = renderScore(notes, { bpm: 132, waveform: Waveform.Saw });
  const stats = analyse(out);
  assert.equal(stats.nonFinite, 0);
});

check('a dense chord stays below clipping', () => {
  // Twelve simultaneous voices is the worst case the UI can produce by painting
  // a whole column, and clipping is the failure a listener would actually hear.
  const notes = Array.from({ length: 12 }, (_, i) => ({ midi: 48 + i, beat: 0, beats: 0.5 }));
  const out = renderScore(notes, { bpm: 120, waveform: Waveform.Square });
  const stats = analyse(out);
  assert.ok(stats.peak < 0.999, `peak ${stats.peak} would clip`);
  assert.ok(stats.peak > 0.2, `peak ${stats.peak} is quieter than VOICE_GAIN implies`);
});

check('silence renders as silence, not as NaN', () => {
  const out = renderScore([], { bpm: 120, waveform: Waveform.Triangle });
  const stats = analyse(out);
  assert.equal(stats.nonFinite, 0);
  assert.equal(stats.peak, 0);
});

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} synth check(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nsynth checks passed\n');
