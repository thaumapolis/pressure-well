/**
 * app.js — the browser half: paint a score, hear it, see what it computed.
 *
 * Kept thin on purpose. The synthesis and the score model are pure and tested in
 * node; this file only moves pixels, moves audio buffers, and maps pointer positions
 * onto grid cells. Anything that decides a number belongs in synth.js or score.js
 * where it can be asserted on.
 */
import { Score, COLS, BASE_MIDI, OCTAVES, ROWS, PITCH_ROWS, pitchName } from './score.js';
import {
  renderScore, analyse, Waveform, SAMPLE_RATE, midiToFreq, DEFAULT_ENVELOPE,
  harmonicsBelowNyquist, aliasedEnergyFraction, HARMONIC_CAP,
} from './synth.js';

const el = (id) => document.getElementById(id);
const grid = el('grid');
const scope = el('scope');

/**
 * Preview length for the scope. Rendering the whole 16-beat score per edit is
 * ~0.7 s of audio at 44100 Hz, which is 30k samples -- cheap, but the scope only
 * needs to show waveform character, and a shorter window updates at pointer rate.
 */
const SCOPE_BEATS = 2;

/**
 * Score to open with: the one in the URL if the URL *names* one, otherwise the demo.
 *
 * The distinction that matters is "the parameter is absent" from "the parameter is
 * present and describes no notes", so `readParam` returns null for absent rather than
 * the empty string: an empty string is a legitimate encoded score, and conflating the
 * two means a link can never carry an empty piece. A first version here decoded first
 * and then tested `size > 0`, which silently refilled the demo on every deep link --
 * including the one written by the Clear button, so clearing appeared to do nothing on
 * reload. `Score.decode('')` correctly yields an empty score; the fallback was in the
 * wrong place, after the parse instead of before it.
 *
 * A malformed parameter is not caught: it should fail loudly rather than fall back to
 * the demo, because the author heard one piece and the reader would hear another.
 */
function _initialScore() {
  const encoded = readParam('score');
  return encoded === null ? Score.demo() : Score.decode(encoded);
}

const state = {
  score: _initialScore(),
  waveform: Waveform.Square,
  bandlimit: false,
  bpm: 132,
  playing: false,
  context: null,
  source: null,
  playStartTime: 0,
  loopBeats: COLS,
};

/**
 * A URL query parameter, or null when it is not there at all.
 *
 * null rather than '': the caller has to tell "absent" from "present but empty",
 * and `_initialScore` is exactly where that distinction decides behaviour.
 */
function readParam(name) {
  try { return new URLSearchParams(location.search).get(name); }
  catch { return null; }
}

// ---------- audio ----------

/**
 * Build an AudioBuffer from the pure renderer.
 *
 * The offline renderer already produced Float64 in [-1,1] (clamped in synth.js), so
 * this is a copy, not a conversion. Getting audio from a tested offline path rather
 * than from live oscillator nodes is deliberate: the thing the tests assert on is
 * byte-for-byte the thing you hear.
 */
function buildBuffer(score, { bpm, waveform, bandlimit }) {
  const notes = score.list().map((c) => ({ ...c, beats: 1 }));
  const samples = renderScore(notes, { bpm, waveform, bandlimit });
  const context = state.context;
  const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.copyToChannel(Float32Array.from(samples), 0);
  return buffer;
}

function ensureContext() {
  if (state.context) return state.context;
  const Context = window.AudioContext || window.webkitAudioContext;
  state.context = new Context();
  return state.context;
}

function stopPlayback() {
  if (state.source) {
    try { state.source.stop(); } catch { /* already stopped */ }
    state.source.disconnect();
    state.source = null;
  }
  state.playing = false;
  el('play').textContent = 'Play';
}

function startPlayback() {
  const context = ensureContext();
  // Browsers refuse to start audio outside a user gesture. Every entry point here is
  // a click or a keypress, but resume() is still required after a tab is backgrounded.
  context.resume().catch(() => { /* gesture required; the button press is the gesture */ });
  stopPlayback();
  if (state.score.size === 0) return;

  const buffer = buildBuffer(state.score, state);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(context.destination);
  source.start();
  state.source = source;
  state.playStartTime = context.currentTime;
  state.playing = true;
  el('play').textContent = 'Stop';
}

// ---------- grid drawing ----------

const gctx = grid.getContext('2d');
const sctx = scope.getContext('2d');

function layout(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function gridMetrics(w, h) {
  const labelW = 38;
  const cellW = (w - labelW) / COLS;
  const cellH = h / (PITCH_ROWS);
  return { labelW, cellW, cellH };
}

function drawGrid() {
  const { ctx, w, h } = layout(grid);
  const { labelW, cellW, cellH } = gridMetrics(w, h);
  const total = PITCH_ROWS;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0e141d';
  ctx.fillRect(0, 0, w, h);

  // Row/column lattice: darker on beats, lighter in between, so the 4/4 grouping
  // is legible without counting.
  for (let row = 0; row < total; row += 1) {
    const y = h - (row + 1) * cellH;
    const midi = BASE_MIDI + row;
    const isC = pitchName(midi) === 'C';
    if (isC) {
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.fillRect(labelW, y, w - labelW, cellH);
    }
  }
  for (let beat = 0; beat <= COLS; beat += 1) {
    ctx.fillStyle = beat % 4 === 0 ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.045)';
    ctx.fillRect(labelW + beat * cellW, 0, 1, h);
  }
  for (let row = 0; row <= total; row += 1) {
    const midi = BASE_MIDI + row;
    ctx.fillStyle = pitchName(midi) === 'C' ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.035)';
    ctx.fillRect(labelW, h - row * cellH, w - labelW, 1);
  }

  // Pitch labels every C, so the grid is not a mystery column.
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let row = 0; row < total; row += 1) {
    const midi = BASE_MIDI + row;
    if (pitchName(midi) !== 'C') continue;
    const y = h - (row + 0.5) * cellH;
    ctx.fillStyle = 'rgba(230,237,246,0.5)';
    ctx.fillText(`C${Math.floor(midi / 12) - 1}`, 6, y);
  }

  // Notes.
  for (const cell of state.score.list()) {
    const row = cell.midi - BASE_MIDI;
    const x = labelW + cell.beat * cellW;
    const y = h - (row + 1) * cellH;
    ctx.fillStyle = '#7fd8b8';
    ctx.fillRect(x + 1.5, y + 1.5, Math.max(2, cellW - 3), Math.max(2, cellH - 3));
  }

  // Playhead, only while playing.
  if (state.playing && state.context) {
    const elapsed = state.context.currentTime - state.playStartTime;
    const beat = (elapsed / (60 / state.bpm)) % COLS;
    const x = labelW + beat * cellW;
    ctx.fillStyle = 'rgba(224,179,74,0.75)';
    ctx.fillRect(x, 0, 2, h);
  }
}

// ---------- scope ----------

/**
 * The note whose samples the scope shows.
 *
 * The scope is the honest part of the UI: it draws the same samples that go to the
 * speakers, so a square visibly has corners and band-limiting visibly rounds them.
 * That only works if the window contains the note it claims to. The preview therefore
 * renders exactly one score event -- the first one, which after a paint is the note
 * just painted -- rather than "the first two beats" of the whole score.
 *
 * Taking a fixed leading slice of beats was wrong on the demo score, which has no
 * notes in its first two beats: the slice was empty and the code fell through to a
 * branch that relocated arbitrary notes to beat 0, so the scope drew a fabricated
 * chord and labelled it with the score's highest pitch. It looked plausible and was
 * not what the app was playing.
 */
let scopeNotes = [];
let scopeSamples = new Float64Array(0);

/**
 * The preview: the first score event, rendered long enough to look at.
 *
 * A note is one beat, so a preview built from a single beat of a fast tempo is a few
 * milliseconds of real audio -- at 132 bpm, 455 samples. Choosing a steady-state window
 * inside that buffer landed past the note's release, so the scope drew silence and
 * labelled it "2 cycles of E (220 Hz)": truthful about the samples, useless as a view,
 * and the worst kind of wrong because the number in the corner made it look measured.
 *
 * The preview is therefore held for PREVIEW_BEATS rather than the note's real length.
 * That is a deliberate deviation from what plays, and it is disclosed in the caption.
 * Every sample drawn is still a sample the synthesizer produced for these notes, at
 * this waveform and this band-limit setting -- the shape is the thing under inspection,
 * not the duration.
 */
const PREVIEW_BEATS = 4;

/** The beat the preview is built from: the first occupied one. */
function previewBeat() {
  const list = state.score.list();
  return list.length === 0 ? null : list[0].beat;
}

function refreshScope() {
  const beat = previewBeat();
  if (beat === null) {
    scopeNotes = [];
    scopeSamples = new Float64Array(0);
  } else {
    scopeNotes = state.score.atBeat(beat).map((c) => ({ ...c, beats: PREVIEW_BEATS }));
    scopeSamples = renderScore(scopeNotes, {
      bpm: state.bpm, waveform: state.waveform, bandlimit: state.bandlimit,
    });
  }
  drawScope();
  updateReadout();
}

/**
 * How many cycles of the note to show, and why the window is chosen by frequency.
 *
 * The scope's job is to show waveform *character* -- the corners a square has and a
 * triangle does not, and what band-limiting does to them. A fixed sample window does
 * the opposite: at 2048 samples across the panel a C3 note put about 48 cycles on
 * screen, which is not a waveform but a solid band, and the single most important
 * claim of the app was unreadable. Two cycles is few enough to see the corners and
 * many enough to see that it repeats.
 */
/*
 * 6 cycles, not 2. At two cycles a square wave is two long plateaus and three edges,
 * which at full panel height reads as a rendering glitch rather than a waveform. Six
 * is enough plateaus to be recognised as periodic, and the corners are still wide
 * enough that the difference between a square, a saw and a triangle is obvious --
 * which is the whole point of the panel, so the number was chosen from the rendered
 * image, not from a calculation.
 */
const SCOPE_CYCLES = 6;

/** Vertical space kept free at the bottom of the scope for its caption. */
const CAPTION_RESERVE = 16;

/**
 * Window size, in samples, that shows SCOPE_CYCLES of the note being previewed.
 *
 * Measured off `scopeNotes` -- what is actually in the buffer -- rather than off the
 * whole score. Deriving it from the score's highest pitch while showing a different,
 * lower note produced a window of a small fraction of a cycle, and the scope drew a
 * flat line with notches in it and claimed it was a 392 Hz square wave.
 */
function scopeWindowSamples() {
  if (scopeNotes.length === 0) return 0;
  const freq = Math.max(...scopeNotes.map((c) => midiToFreq(c.midi)));
  const wanted = Math.round((SAMPLE_RATE / freq) * SCOPE_CYCLES);
  return Math.max(16, Math.min(wanted, scopeSamples.length));
}

/**
 * Where to start drawing: just past the attack, so the ramp is not mistaken for the
 * waveform, and always inside the buffer.
 */
function scopeOffset() {
  const windowSize = scopeWindowSamples();
  const pastAttack = Math.floor((DEFAULT_ENVELOPE.attack + DEFAULT_ENVELOPE.decay + 0.01) * SAMPLE_RATE);
  return Math.max(0, Math.min(pastAttack, scopeSamples.length - windowSize));
}

function drawScope() {
  const { ctx, w, h } = layout(scope);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#070a0e';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, (h - CAPTION_RESERVE) / 2); ctx.lineTo(w, (h - CAPTION_RESERVE) / 2); ctx.stroke();

  if (scopeSamples.length === 0) {
    ctx.fillStyle = 'rgba(147,166,188,0.6)';
    ctx.font = '12px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('paint a note to see its samples', w / 2, (h - CAPTION_RESERVE) / 2 - 12);
    return;
  }

  const windowSize = scopeWindowSamples();
  if (windowSize === 0) return;
  const offset = scopeOffset();

  // Vertical scale of the *view*, not of the audio.
  //
  // The signal is quiet by design: VOICE_GAIN is set so that the worst case the grid
  // can produce -- a fully painted column, 12 voices in phase -- still cannot clip. At
  // 0.07 per voice, the three-note chord this score opens with peaks at 0.21, so a
  // scope that drew samples at 1:1 filled a fifth of its own height and showed a
  // nearly flat line with notches in it. That is a truthful drawing of a real buffer
  // and still a misleading picture, which is the failure mode worth avoiding here.
  //
  // So the window is scaled by its own peak to fill the panel, and the peak and the
  // scale are printed in the caption. Nothing about the waveform's *shape* depends on
  // this factor; it is an oscilloscope's volts-per-division, stated rather than hidden.
  const stats = analyse(scopeSamples.subarray(offset, offset + windowSize));
  const mid = (h - CAPTION_RESERVE) / 2;
  const scale = stats.peak > 0 ? (mid - 4) / stats.peak : 0;
  ctx.strokeStyle = '#7fd8b8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < windowSize; i += 1) {
    const x = (i / (windowSize - 1)) * w;
    const y = mid - scopeSamples[offset + i] * scale;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Say what the window is and what the vertical scale is, so the zoom reads as a
  // setting rather than a mystery.
  const hz = Math.max(...scopeNotes.map((c) => midiToFreq(c.midi)));
  const voices = scopeNotes.length > 1 ? `${scopeNotes.length} notes at ` : '';
  ctx.fillStyle = 'rgba(147,166,188,0.55)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(
    `${SCOPE_CYCLES} cycles of ${voices}${pitchName(scopeNotes[0].midi)} (${Math.round(hz)} Hz), held for view` +
      `  ·  ${windowSize} samples  ·  peak ${stats.peak.toFixed(3)}`,
    w - 8, h - 6,
  );
}

function updateReadout() {
  const stats = scopeSamples.length > 0 ? analyse(scopeSamples) : { peak: 0 };
  el('rNotes').textContent = String(state.score.size);
  el('rPeak').textContent = stats.peak.toFixed(3);
  const poly = state.score.list().reduce((m, c) => Math.max(m, state.score.atBeat(c.beat).length), 0);
  el('rPoly').textContent = String(poly);
  el('rWave').textContent = state.waveform + (state.bandlimit ? ' (band-limited)' : '');
  el('rAlias').textContent = aliasLine();
}

/**
 * The number that explains the buzz, computed rather than asserted.
 *
 * Deliberately not a boolean threshold. An earlier version warned when the highest
 * note's second harmonic passed Nyquist, which was false for most of the grid -- a
 * square at C3 needs 168 harmonics and only 168 fit, so it aliases badly long before
 * that test fires, and a warning that never appears is worse than none. What actually
 * varies is how many partials are lost, and it is largest for the highest note in the
 * score, because that is where fewest fit. `harmonicsBelowNyquist` is the same
 * function the DSP cuts off at, so the sentence and the audio cannot disagree.
 */
function aliasLine() {
  const nyquist = SAMPLE_RATE / 2;
  const pitches = state.score.list().map((c) => midiToFreq(c.midi));
  if (pitches.length === 0) return '';
  const highest = Math.max(...pitches);
  const kept = Math.min(HARMONIC_CAP, harmonicsBelowNyquist(highest));
  if (state.bandlimit) {
    return `${kept} harmonics kept under the ${nyquist} Hz limit — nothing folded back`;
  }
  // The claim has to match the measurement. aliasedEnergyFraction is the share of the
  // waveform's energy that cannot be represented: 1.7% for a square at C6, and
  // 0.002% for a triangle, which is why a triangle sounds much the same band-limited
  // or not. Telling someone to listen for buzz from a triangle would be teaching them
  // a thing the app then fails to demonstrate.
  const aliased = aliasedEnergyFraction(state.waveform, highest);
  if (aliased < 0.001) {
    return `${Math.round(highest)} Hz fits ${kept} harmonics; a ${state.waveform} has already used nearly all of them, so there is little to fold back`;
  }
  const percent = aliased < 0.01 ? `${(aliased * 100).toFixed(1)}%` : `${Math.round(aliased * 100)}%`;
  return `${Math.round(highest)} Hz fits ${kept} harmonics; a ${state.waveform} needs more, and the ${percent} above the limit folds back as buzz`;
}

// ---------- input ----------

/** Pointer position -> {midi, beat}, or null outside the grid. */
export function cellAt(clientX, clientY, canvas, rect) {
  const { labelW, cellW, cellH } = gridMetrics(rect.width, rect.height);
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < labelW || y < 0 || y >= rect.height) return null;
  const beat = Math.floor((x - labelW) / cellW);
  const row = Math.floor((rect.height - y) / cellH);
  if (beat < 0 || beat >= COLS || row < 0 || row >= PITCH_ROWS) return null;
  return { midi: BASE_MIDI + row, beat };
}

let painting = null;
function beginPaint(cell) {
  if (!cell) return;
  const had = state.score.has(cell.midi, cell.beat);
  painting = had ? 'erase' : 'paint';
  if (had) state.score.erase(cell.midi, cell.beat);
  else state.score.paint(cell.midi, cell.beat);
  afterEdit();
}

grid.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  grid.setPointerCapture(event.pointerId);
  beginPaint(cellAt(event.clientX, event.clientY, grid, grid.getBoundingClientRect()));
});
grid.addEventListener('pointermove', (event) => {
  if (!painting) return;
  const cell = cellAt(event.clientX, event.clientY, grid, grid.getBoundingClientRect());
  if (!cell) return;
  if (painting === 'paint') state.score.paint(cell.midi, cell.beat);
  else state.score.erase(cell.midi, cell.beat);
  afterEdit();
});
const endPaint = () => { painting = null; };
grid.addEventListener('pointerup', endPaint);
grid.addEventListener('pointercancel', endPaint);

function afterEdit() {
  writeScore();
  refreshScope();
  drawGrid();
  updateReadout();
}

/**
 * Keep the score in the URL, without a history entry per pixel of drag.
 *
 * replaceState rather than pushState: a drag paints hundreds of cells and each
 * would otherwise become a back-button press. This touches history state, not
 * storage, so it stays within the no-storage guarantee the org makes.
 */
function writeScore() {
  const encoded = state.score.encode();
  try {
    const url = new URL(location.href);
    if (encoded) url.searchParams.set('score', encoded);
    else url.searchParams.delete('score');
    history.replaceState(null, '', url);
  } catch { /* file:// can refuse; the app still works, it just is not shareable */ }
}

// ---------- controls ----------

el('play').addEventListener('click', () => {
  if (state.playing) stopPlayback(); else startPlayback();
});
el('bpm').addEventListener('input', (event) => {
  state.bpm = Number(event.target.value);
  el('bpmVal').textContent = String(state.bpm);
  if (state.playing) startPlayback();
  refreshScope();
});
el('wave').addEventListener('change', (event) => {
  state.waveform = event.target.value;
  if (state.playing) startPlayback();
  refreshScope();
});
el('bandlimit').addEventListener('change', (event) => {
  state.bandlimit = event.target.checked;
  if (state.playing) startPlayback();
  refreshScope();
});
el('clear').addEventListener('click', () => {
  state.score = new Score();
  stopPlayback();
  afterEdit();
});
el('rand').addEventListener('click', () => {
  state.score = randomScore(state.score.size > 0 ? state.score.size : 20);
  if (state.playing) startPlayback();
  afterEdit();
});

/** Random but musical: a walk over one pentatonic set, so a random score is listenable. */
function randomScore(count) {
  const scale = [0, 2, 3, 5, 7, 10];
  const root = 48 + Math.floor(Math.random() * 12);
  const score = new Score();
  for (let i = 0; i < count; i += 1) {
    const beat = Math.floor(Math.random() * COLS);
    const degree = scale[Math.floor(Math.random() * scale.length)];
    const octave = 12 * Math.floor(Math.random() * 3);
    score.paint(root + degree + octave, beat);
  }
  return score;
}

function showHelp() {
  el('overlay').classList.remove('hidden');
  el('help').setAttribute('aria-pressed', 'true');
}
function hideHelp() {
  el('overlay').classList.add('hidden');
  el('help').setAttribute('aria-pressed', 'false');
}
el('help').addEventListener('click', () => {
  if (el('overlay').classList.contains('hidden')) showHelp(); else hideHelp();
});
el('overlay').addEventListener('click', (event) => {
  if (event.target === el('overlay') || event.target.dataset.action === 'start') hideHelp();
});

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.code === 'Space') {
    event.preventDefault();
    if (state.playing) stopPlayback(); else startPlayback();
  } else if (event.key === '?') {
    showHelp();
  } else if (event.key === 'Escape') {
    hideHelp();
  }
});

// ---------- boot ----------

let resizeQueued = false;
function relayout() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    drawGrid();
    drawScope();
  });
}
window.addEventListener('resize', relayout);

refreshScope();
drawGrid();

/** Test seam: the suites drive the built page and assert on what it decided. */
window.pressureWell = {
  get score() { return state.score; },
  get waveform() { return state.waveform; },
  get bandlimit() { return state.bandlimit; },
  get bpm() { return state.bpm; },
  get playing() { return state.playing; },
  get scopeSamples() { return scopeSamples; },
  setWaveform(name) { state.waveform = name; el('wave').value = name; if (state.playing) startPlayback(); refreshScope(); drawGrid(); },
  setBandlimit(on) { state.bandlimit = on; el('bandlimit').checked = on; if (state.playing) startPlayback(); refreshScope(); drawGrid(); },
  paint(midi, beat) { state.score.paint(midi, beat); afterEdit(); },
  clear() { state.score = new Score(); stopPlayback(); afterEdit(); },
  cellAt,
  showHelp,
  hideHelp,
  isHelpVisible: () => !el('overlay').classList.contains('hidden'),
};
