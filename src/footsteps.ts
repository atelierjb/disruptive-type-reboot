/**
 * Footsteps from the original FirstPersonAIO setup. None of the scene's colliders had a
 * physic material assigned, so AIO always fell back to its default list: the grass set.
 * Concrete and carpet sets were also shipped; switch SET to use them.
 */
const SETS = {
  grass: ['grass_01', 'grass_02', 'grass_03', 'grass_04'],
  concrete: ['concrete-01', 'concrete-02', 'concrete-03', 'concrete-04', 'concrete-05'],
  carpet: ['carpet-01', 'carpet-02', 'carpet-03', 'carpet-04', 'carpet-05'],
};
const SET: keyof typeof SETS = 'grass';
const STEP_LENGTH = 2.1; // world units between footfalls
const VOLUME = 0.45;

export class Footsteps {
  private ctx: AudioContext | null = null;
  private buffers: AudioBuffer[] = [];
  private last = -1;
  private nextAt = STEP_LENGTH;

  /** Must be called from a user gesture (browser autoplay rules). */
  async unlock() {
    if (this.ctx) return void this.ctx.resume();
    this.ctx = new AudioContext();
    const ctx = this.ctx;
    this.buffers = await Promise.all(
      SETS[SET].map((n) =>
        fetch(`/assets/audio/${n}.mp3`)
          .then((r) => r.arrayBuffer())
          .then((b) => ctx.decodeAudioData(b)),
      ),
    );
  }

  suspend() {
    this.ctx?.suspend();
  }

  /** Feed the player's cumulative ground distance. */
  update(stride: number) {
    if (stride < this.nextAt) return;
    this.nextAt = stride + STEP_LENGTH;
    this.play();
  }

  private play() {
    const ctx = this.ctx;
    if (!ctx || !this.buffers.length || ctx.state !== 'running') return;
    let i = Math.floor(Math.random() * this.buffers.length);
    if (i === this.last) i = (i + 1) % this.buffers.length; // never the same clip twice
    this.last = i;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[i];
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const gain = ctx.createGain();
    gain.gain.value = VOLUME;
    src.connect(gain).connect(ctx.destination);
    src.start();
  }
}
