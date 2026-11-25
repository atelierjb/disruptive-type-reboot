import * as THREE from 'three';
import type { Trigger } from './world';
import { TUNING } from './player';

/**
 * Port of the original `UIAppear` script: each sculpture has an invisible box
 * trigger; while the player's capsule overlaps it, that sculpture's tag image is shown.
 */
interface Box {
  name: string;
  url: string;
  center: THREE.Vector3;
  axes: THREE.Vector3[]; // unit axes
  half: number[]; // half extents along each axis
}

const local = new THREE.Vector3();

export class Exhibits {
  private boxes: Box[];
  private inside = new Set<Box>();
  private shown: Box | null = null;
  private img: HTMLImageElement;

  constructor(triggers: Trigger[], img: HTMLImageElement) {
    this.img = img;
    this.boxes = triggers.map((t) => {
      const axes = t.axes.map((a) => new THREE.Vector3(...a));
      return {
        name: t.name,
        url: `/assets/ui/${t.tag}.webp`,
        center: new THREE.Vector3(...t.center),
        half: axes.map((a) => a.length() / 2),
        axes: axes.map((a) => a.normalize()),
      };
    });
    // warm the image cache so tags pop in instantly
    const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 200));
    idle(() => this.boxes.forEach((b) => (new Image().src = b.url)));
  }

  update(capsuleCenter: THREE.Vector3) {
    for (const b of this.boxes) {
      local.subVectors(capsuleCenter, b.center);
      // capsule vs oriented box, approximated by expanding the box by the capsule size
      const hit = b.axes.every((ax, i) => {
        const pad = i === 1 ? TUNING.radius + TUNING.halfSegment : TUNING.radius;
        return Math.abs(local.dot(ax)) <= b.half[i] + pad;
      });
      if (hit && !this.inside.has(b)) {
        this.inside.add(b);
        this.show(b); // OnTriggerEnter: most recently entered wins
      } else if (!hit && this.inside.has(b)) {
        this.inside.delete(b);
        if (this.shown === b) {
          const next = [...this.inside].pop() ?? null; // OnTriggerExit
          this.show(next);
        }
      }
    }
  }

  reset() {
    this.inside.clear();
    this.show(null);
  }

  private show(b: Box | null) {
    this.shown = b;
    if (b) {
      this.img.src = b.url;
      this.img.alt = `Exhibit ${b.name.replace(/\s*trig(ger)?\s*$/i, '')}`;
      this.img.classList.add('on');
    } else {
      this.img.classList.remove('on');
    }
  }
}
