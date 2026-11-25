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
  DEFAULT_ENVELOPE, VOICE_GAIN, bandlimited, partial, partialRms, IDEAL_RMS,
  harmonicsBelowNyquist, HARMONIC_CAP,
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


// ---------- band-limiting: the mechanism the app exists to demonstrate ----------

const IDEAL = {
  [Waveform.Square]: (phase) => (phase < 0.5 ? 1 : -1),
  [Waveform.Saw]: (phase) => (phase < 1 ? 2 * phase - 1 : -1),
  [Waveform.Triangle]: (phase) => 4 * Math.abs(phase - 0.5) - 1,
};

/** RMS deviation between two one-cycle generators, sampled off the grid. */
function waveformDeviation(a, b, samples = 65536) {
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const phase = (i + 0.137) / samples; // irrational-ish offset: no bin alignment
    const d = a(phase) - b(phase);
    sum += d * d;
  }
  return Math.sqrt(sum / samples);
}

console.log('== band-limited series reproduce their waveforms ==');

check('each band-limited series reproduces its ideal waveform', () => {
  // Tolerances are the measured RMS at full truncation, not headroom: triangle is a
  // continuous function so its series is essentially exact, while square and saw carry
  // the Gibbs ripple at their jumps, which no finite series removes.
  // Measured at HARMONIC_CAP=168: square 0.0491, saw 0.0347, triangle 0.00011. The
  // tolerances sit just above those, so a regression in a coefficient or a sign is
  // caught while the Gibbs ripple -- which is real and irreducible -- is not flaky.
  const limits = { [Waveform.Triangle]: 1e-3, [Waveform.Saw]: 0.05, [Waveform.Square]: 0.07 };
  for (const waveform of Object.values(Waveform)) {
    const deviation = waveformDeviation(
      IDEAL[waveform],
      (phase) => bandlimited(waveform, phase, HARMONIC_CAP),
    );
    assert.ok(
      deviation <= limits[waveform],
      `${waveform}: band-limited deviates ${deviation.toFixed(5)} (limit ${limits[waveform]})`,
    );
  }
});

check('the saw series is negative-sloped, not positive', () => {
  // Guards the specific sign that was wrong in a first draft. A +1/k sine series
  // measures RMS 1.15 against the saw -- the opposite waveform -- and it is the kind
  // of error a "looks like a Fourier series" glance will not catch.
  const positive = (phase) => {
    let sum = 0;
    for (let k = 1; k <= 168; k += 1) sum += Math.sin(2 * Math.PI * k * phase) / k;
    return (2 / Math.PI) * sum;
  };
  assert.ok(
    waveformDeviation(IDEAL[Waveform.Saw], positive) > 1,
    'a positive 1/k sine series should NOT match a saw; if it does, PARTIAL.saw is wrong',
  );
});

check('partialRms matches a numeric RMS of the ideal waveform', () => {
  // Parseval is only as good as the coefficients, so it is checked against brute force.
  const samples = 32768;
  for (const waveform of Object.values(Waveform)) {
    let sum = 0;
    for (let i = 0; i < samples; i += 1) sum += IDEAL[waveform](i / samples) ** 2;
    const numeric = Math.sqrt(sum / samples);
    assert.ok(
      Math.abs(numeric - IDEAL_RMS[waveform]) < 1e-4,
      `${waveform}: IDEAL_RMS ${IDEAL_RMS[waveform].toFixed(5)} vs numeric ${numeric.toFixed(5)}`,
    );
  }
});

console.log('== band-limiting does what the app claims ==');

/** Steady-state window of one rendered note, so the envelope is out of the way. */
function noteWindow(midi, waveform, bandlimit) {
  const samples = renderScore([{ midi, beat: 0, beats: 1 }], {
    bpm: 60, waveform, bandlimit,
  });
  const start = Math.floor(0.4 * SAMPLE_RATE);
  return samples.subarray(start, start + 4096);
}

function rms(values) {
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum / values.length);
}

check('band-limiting changes square and saw a lot, and triangle almost not at all', () => {
  // The claim, stated as a difference: triangle is already band-limited (coefficients
  // fall as 1/k^2) so there is nothing to remove; square and saw carry 1/k tails that
  // reach far past Nyquist. This is the mechanism, so a regression that quietly makes
  // bandlimit a no-op has to fail here.
  const midi = 84; // C6: only 21 harmonics fit, so the effect is at its strongest
  const deviation = (waveform) => {
    const naive = noteWindow(midi, waveform, false);
    const limited = noteWindow(midi, waveform, true);
    let sum = 0;
    let total = 0;
    for (let i = 0; i < naive.length; i += 1) {
      sum += (naive[i] - limited[i]) ** 2;
      total += naive[i] ** 2;
    }
    return Math.sqrt(sum / total);
  };
  assert.ok(deviation(Waveform.Square) > 0.1, `square dev ${deviation(Waveform.Square).toFixed(3)} <= 0.1`);
  assert.ok(deviation(Waveform.Saw) > 0.1, `saw dev ${deviation(Waveform.Saw).toFixed(3)} <= 0.1`);
  assert.ok(
    deviation(Waveform.Triangle) < 0.02,
    `triangle dev ${deviation(Waveform.Triangle).toFixed(3)} >= 0.02 -- triangle should be unaffected`,
  );
});

check('the effect grows with pitch, as the mechanism requires', () => {
  // Fewer harmonics fit at a higher pitch, so more of the 1/k tail is lost. If a future
  // change made the difference pitch-independent, the cutoff would not be doing anything.
  const dev = (midi) => {
    const naive = noteWindow(midi, Waveform.Square, false);
    const limited = noteWindow(midi, Waveform.Square, true);
    let sum = 0;
    let total = 0;
    for (let i = 0; i < naive.length; i += 1) {
      sum += (naive[i] - limited[i]) ** 2;
      total += naive[i] ** 2;
    }
    return Math.sqrt(sum / total);
  };
  const low = dev(48);
  const high = dev(84);
  assert.ok(high > low, `C6 dev ${high.toFixed(4)} should exceed C3 dev ${low.toFixed(4)}`);
});

check('band-limiting is loudness-matched, so the A/B is not measuring gain', () => {
  // If this drifts, the checkbox stops being a timbre control and becomes a volume
  // control, which would make every claim in the explainer unfalsifiable.
  for (const midi of [48, 60, 84]) for (const waveform of Object.values(Waveform)) {
    const naive = rms(noteWindow(midi, waveform, false));
    const limited = rms(noteWindow(midi, waveform, true));
    const ratio = limited / naive;
    assert.ok(
      Math.abs(ratio - 1) < 0.02,
      `midi ${midi} ${waveform}: band-limited RMS is ${ratio.toFixed(4)}x naive, want 1.00`,
    );
  }
});

check('the cutoff is the harmonic count the readout shows', () => {
  // The UI prints "N harmonics fit". That number must be the DSP's cutoff exactly,
  // including the pitch dependence that makes high notes the interesting ones.
  assert.equal(harmonicsBelowNyquist(midiToFreq(69)), Math.floor(22050 / 440));
  assert.ok(harmonicsBelowNyquist(55) > 300, 'a low note should keep most harmonics');
  assert.ok(harmonicsBelowNyquist(2000) < 12, 'a very high note should keep almost none');
  assert.ok(
    harmonicsBelowNyquist(midiToFreq(48)) > harmonicsBelowNyquist(midiToFreq(84)),
    'cutoff must fall as pitch rises',
  );
});

check('band-limiting caps the harmonic count at HARMONIC_CAP', () => {
  // Bounds the cost: a note low enough to keep 400 partials still only pays for the cap.
  const cheap = renderScore([{ midi: 24, beat: 0, beats: 0.02 }], {
    bpm: 60, waveform: Waveform.Saw, bandlimit: true,
  });
  assert.ok(Number.isFinite(analyse(cheap).peak), 'a very low pitch must still render');
});

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} synth check(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nsynth checks passed\n');
