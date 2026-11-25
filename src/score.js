/**
 * score.js -- the editable state: a set of cells, each one pitch at one beat.
 *
 * This is the whole data model, and it is deliberately a Set of (pitch, beat) rather
 * than a grid or a timeline of objects. The reason is that the UI's only operations
 * are "paint a cell", "erase a cell", "what sounds at this beat", and "serialise for
 * the URL" -- and a Map keyed by pitch*COLS+beat does all four exactly, with
 * idempotent painting falling out for free (painting a cell that exists is a no-op,
 * which the test pins, because a painter that duplicates on every drag event would
 * turn one gesture into a hundred voices and clip the mix).
 *
 * Note lengths are uniform (one beat) in this version. That is a limitation, not an
 * oversight: varying note length needs a second UI dimension, and the mechanism being
 * demonstrated is mixing and aliasing, not duration.
 */

export const COLS = 16;          // beats per bar
export const ROWS = 12;          // semitones per octave
export const OCTAVES = 3;        // whole octaves, so the top row is a C
// The pitch range is derived rather than written twice. `OCTAVES` counts octaves
// from BASE_MIDI, so the grid is C3..C6 inclusive: 12*OCTAVES + 1 rows, not 12*
// OCTAVES. A height of exactly 36 would end on A5, which makes the top of the grid
// an arbitrary cutoff and puts the "highest row" at a note no scale starts on -- and
// it silently rejects a paint at C6, the pitch the aliasing story is told about.
export const BASE_MIDI = 48;     // C3: the bottom row
export const PITCH_ROWS = ROWS * OCTAVES + 1;

/** Highest MIDI number the grid accepts. */
export const TOP_MIDI = BASE_MIDI + PITCH_ROWS - 1;

export function keyFor(midi, beat) {
  return (midi - BASE_MIDI) * COLS + beat;
}

export function midiAt(row) {
  return BASE_MIDI + row;
}

/** Pitch class name for a MIDI number, e.g. 60 -> 'C'. */
export function pitchName(midi) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return names[((midi % 12) + 12) % 12];
}

export class Score {
  constructor(cells = []) {
    /** @type {Map<number, {midi:number, beat:number}>} */
    this.cells = new Map();
    for (const cell of cells) this.paint(cell.midi, cell.beat);
  }

  paint(midi, beat) {
    if (!this.inRange(midi, beat)) return false;
    this.cells.set(keyFor(midi, beat), { midi, beat });
    return true;
  }

  erase(midi, beat) {
    return this.cells.delete(keyFor(midi, beat));
  }

  toggle(midi, beat) {
    if (this.cells.has(keyFor(midi, beat))) return this.erase(midi, beat) ? 'erased' : 'noop';
    return this.paint(midi, beat) ? 'painted' : 'noop';
  }

  has(midi, beat) {
    return this.cells.has(keyFor(midi, beat));
  }

  inRange(midi, beat) {
    return midi >= BASE_MIDI && midi <= TOP_MIDI && beat >= 0 && beat < COLS;
  }

  /** Cells sounding at a given beat, ordered low to high. */
  atBeat(beat) {
    return this.list().filter((c) => c.beat === beat).sort((a, b) => a.midi - b.midi);
  }

  /** All cells in (beat, midi) order -- the order the playhead consumes them. */
  list() {
    return [...this.cells.values()].sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  }

  get size() { return this.cells.size; }

  /**
   * Compact URL form: "48.0-52.3-55.7". Chosen over JSON because the whole point is
   * a link you can send, and this is ~5 chars per note. Round-trips exactly, which
   * the test asserts, since a deep link that loses a note silently misinforms.
   */
  encode() {
    return this.list().map((c) => `${c.midi}.${c.beat}`).join('-');
  }

  static decode(text) {
    if (typeof text !== 'string' || text.length === 0) return new Score();
    const cells = [];
    for (const part of text.split('-')) {
      // Validated by pattern, not by coercion. Destructuring `part.split('.')` and
      // then Number()-ing the first two fields accepts nonsense: '60.1.5' yields
      // midi 60, beat 1 and the stray '5' is dropped silently, so a hand-edited or
      // truncated link would play a different piece than the author heard.
      if (!/^\d+\.\d+$/.test(part)) throw new Error(`malformed score cell: ${part}`);
      const [midiText, beatText] = part.split('.');
      const midi = Number(midiText);
      const beat = Number(beatText);
      if (!Number.isSafeInteger(midi) || !Number.isSafeInteger(beat)) {
        throw new Error(`malformed score cell: ${part}`);
      }
      cells.push({ midi, beat });
    }
    return new Score(cells);
  }

  /** Deterministic, so a shared score and a recorded golden can never disagree. */
  static demo() {
    // A minor pentatonic riff with a chord on the downbeat of each half-bar:
    // enough to demonstrate polyphony, mixing and aliasing without being noise.
    const riff = [57, 60, 64, 65, 67, 64, 60, 57, 55, 57, 60, 62, 64, 60, 57, 55];
    const cells = riff.map((midi, beat) => ({ midi, beat }));
    for (const beat of [0, 8]) {
      cells.push({ midi: 45, beat }, { midi: 52, beat }, { midi: 57, beat });
    }
    return new Score(cells);
  }
}
