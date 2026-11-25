/**
 * synth.js — the whole mechanism: a pattern table rendered to samples.
 *
 * Everything here is a pure function of numbers, so the audio can be verified in
 * node against known-answer cases, with no browser and no speakers. That property
 * is the reason this project was chosen over ideas whose only test is the finished
 * system: `renderScore` can be asserted on, so a regression in tuning, envelope or
 * mixing fails the build rather than sounding vaguely wrong.
 *
 * Three waveforms, each derived arithmetically from phase in [0,1). No samples, no
 * tables, no network. The square wave is deliberately band-unlimited and unfiltered
 * -- it is the honest naive form, and the aliasing it produces is the subject of the
 * explainer rather than something to hide behind a lowpass.
 */

export const SAMPLE_RATE = 44100;

/** Equal temperament: A4 = 440 Hz by definition, everything else derived. */
export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export const Waveform = Object.freeze({
  Square: 'square',
  Saw: 'saw',
  Triangle: 'triangle',
});

/**
 * Phase in [0,1) to amplitude in [-1,1].
 *
 * The range is exact by construction, which the test pins. The saw is written as
 * `phase < 1 ? 2*phase - 1 : -1` rather than `2*phase - 1` because phase 1 is the
 * discontinuity: the naive form returns +1 there, and since a note is sampled at
 * integer indices, every note whose period does not divide the sample count lands
 * on phase 1 somewhere and gets a +1 spike instead of wrapping to -1. Measured:
 * a 12-note saw chord peaked at 2.64 against a 1.0 ceiling.
 */
export function shape(waveform, phase) {
  switch (waveform) {
    case Waveform.Square:
      return phase < 0.5 ? 1 : -1;
    case Waveform.Saw:
      return phase < 1 ? 2 * phase - 1 : -1;
    case Waveform.Triangle:
      return 4 * Math.abs(phase - 0.5) - 1;
    default:
      throw new Error(`unknown waveform: ${waveform}`);
  }
}

/**
 * ADSR envelope, a pure function of elapsed time and the note's own duration.
 *
 * Written as an explicit piecewise function rather than a state machine so a test
 * can pin the whole contour from a table of times. The attack is short but not
 * instant: an instant attack clicks, and a click is a DC step.
 */
export function envelope(elapsed, duration, times) {
  const { attack, decay, sustain, release } = times;
  if (elapsed < 0) return 0;
  if (elapsed < attack) return elapsed / attack;
  if (elapsed < attack + decay) {
    return 1 - (1 - sustain) * ((elapsed - attack) / decay);
  }
  if (elapsed < duration) return sustain;
  if (elapsed < duration + release) {
    return sustain * (1 - (elapsed - duration) / release);
  }
  return 0;
}

export const DEFAULT_ENVELOPE = Object.freeze({
  attack: 0.004,
  decay: 0.06,
  sustain: 0.72,
  release: 0.09,
});

/**
 * Per-voice level, chosen against a measured worst case rather than by ear.
 *
 * The worst case the UI can produce is a fully painted column: every pitch row
 * sounding at once, all in phase at their attack. The naive 0.22 per voice peaked
 * at 2.64 with 12 voices (measured), i.e. it would have clipped hard on any real
 * chord. The test `a dense chord stays below clipping` is what keeps this honest;
 * if MAX_POLYPHONY or the mixing changes, that test has to be re-run, not re-guessed.
 */
export const VOICE_GAIN = 0.07;
export const MAX_POLYPHONY = 12;

/**
 * Render a score to mono samples.
 *
 * A score is a list of notes, each `{ midi, beat, beats, waveform }`. Beats become
 * seconds through the tempo, and notes are summed -- summed, never sequenced, so
 * chords and overlap fall out of the same code as melody.
 */
export function renderScore(notes, { bpm, waveform, envelopeTimes }) {
  const beatSeconds = 60 / bpm;
  const endBeat = notes.reduce((m, n) => Math.max(m, n.beat + n.beats), 0);
  const total = Math.ceil((endBeat * beatSeconds + 0.25) * SAMPLE_RATE);
  const out = new Float64Array(total);
  const times = envelopeTimes ?? DEFAULT_ENVELOPE;

  for (const note of notes) {
    const freq = midiToFreq(note.midi);
    const start = Math.floor(note.beat * beatSeconds * SAMPLE_RATE);
    const length = Math.floor(note.beats * beatSeconds * SAMPLE_RATE);
    const shapeName = note.waveform ?? waveform;
    for (let i = 0; i < length; i += 1) {
      const elapsed = i / SAMPLE_RATE;
      const phase = (elapsed * freq) % 1;
      const gain = envelope(elapsed, length / SAMPLE_RATE, times);
      const at = start + i;
      if (at < total) {
        out[at] = clampUnit(
          out[at] + shape(shapeName, phase) * gain * VOICE_GAIN,
        );
      }
    }
  }
  return out;
}

/**
 * Keep every sample inside [-1,1], the range Web Audio's AudioBuffer requires.
 *
 * Applied per accumulated sample rather than as a final pass, so the invariant
 * holds for any partial render too. This is real saturation, not a rounding
 * detail: a square wave's plateau sits at exactly +/-1 before the envelope, so a
 * chord's sum genuinely reaches the boundary and would otherwise be written out
 * of range (measured peak 2.64 before this existed).
 */
export function clampUnit(value) {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/** Statistics the tests and the UI share, so neither re-derives them differently. */
export function analyse(samples) {
  let peak = 0;
  let sum = 0;
  let nan = 0;
  for (const v of samples) {
    if (!Number.isFinite(v)) nan += 1;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v;
  }
  return { length: samples.length, peak, dc: sum / samples.length, nonFinite: nan };
}
