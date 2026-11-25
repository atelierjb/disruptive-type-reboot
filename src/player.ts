import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

/**
 * First-person controller tuned to the values serialized on the original
 * FirstPersonAIO component (walk 7, sprint 10, jump 8, 150° vertical range,
 * capsule r=0.4 h=2, head joint +0.9).
 */
export const TUNING = {
  walkSpeed: 7,
  sprintSpeed: 10,
  // Jumps are set by how high they go; the launch speed is derived from gravity.
  // The original (jump 8 against heavy gravity) only cleared ~1.5 units; this is boosted.
  jumpHeight: 3.75, // world units (the player is 2 tall)
  gravity: -15, // lighter than before (-21.6) for a floatier arc
  radius: 0.4,
  halfSegment: 0.6, // (height 2 - 2*radius) / 2
  eyeHeight: 0.9,
  pitchLimit: THREE.MathUtils.degToRad(75), // verticalRotationRange 150 / 2
  mouseSensitivity: 0.0022,
  touchLookSensitivity: 0.005,
  accel: 14, // how fast velocity reaches target speed (1/s)
  headbobFrequency: 1.5,
  headbobHeight: 0.06,
  headbobSide: 0.03,
};

const tmpBox = new THREE.Box3();
const tmpSeg = new THREE.Line3();
const triPoint = new THREE.Vector3();
const capPoint = new THREE.Vector3();
const delta = new THREE.Vector3();
const wish = new THREE.Vector3();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const before = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

export class Player {
  /** capsule centre */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  onGround = false;
  /** distance walked on the ground; drives head-bob and footsteps */
  stride = 0;
  private bob = 0;
  private spawn = new THREE.Vector3();
  private spawnYaw = 0;

  // input state
  readonly keys = new Set<string>();
  readonly moveAxis = new THREE.Vector2(); // touch joystick, x right, y forward
  jumpQueued = false;

  private camera: THREE.PerspectiveCamera;
  private collider: MeshBVH;

  constructor(camera: THREE.PerspectiveCamera, collider: MeshBVH) {
    this.camera = camera;
    this.collider = collider;
  }

  placeAt(eye: THREE.Vector3Tuple, forward: THREE.Vector3Tuple) {
    this.spawn.set(eye[0], eye[1] - TUNING.eyeHeight, eye[2]);
    this.spawnYaw = Math.atan2(-forward[0], -forward[2]);
    this.respawn();
  }

  respawn() {
    this.position.copy(this.spawn);
    this.velocity.set(0, 0, 0);
    this.yaw = this.spawnYaw;
    this.pitch = 0;
    this.updateCamera(0);
  }

  look(dx: number, dy: number, sensitivity = TUNING.mouseSensitivity) {
    this.yaw -= dx * sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sensitivity, -TUNING.pitchLimit, TUNING.pitchLimit);
  }

  update(dt: number) {
    // fixed sub-steps keep the capsule from tunnelling on slow frames
    const steps = Math.min(8, Math.max(1, Math.ceil(dt / (1 / 120))));
    const h = Math.min(dt, 0.1) / steps;
    for (let i = 0; i < steps; i++) this.step(h);
    if (this.position.y < -20) this.respawn();
    this.updateCamera(dt);
  }

  private step(dt: number) {
    const k = this.keys;
    let ix = this.moveAxis.x;
    let iz = this.moveAxis.y;
    if (k.has('KeyW') || k.has('ArrowUp')) iz += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) iz -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) ix += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) ix -= 1;

    fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    right.set(-fwd.z, 0, fwd.x);
    wish.set(0, 0, 0).addScaledVector(fwd, iz).addScaledVector(right, ix);
    if (wish.lengthSq() > 1) wish.normalize();
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    wish.multiplyScalar(sprint ? TUNING.sprintSpeed : TUNING.walkSpeed);

    // horizontal velocity eases toward input (a touch of air control)
    const a = 1 - Math.exp(-(this.onGround ? TUNING.accel : TUNING.accel * 0.3) * dt);
    this.velocity.x += (wish.x - this.velocity.x) * a;
    this.velocity.z += (wish.z - this.velocity.z) * a;

    if (this.jumpQueued && this.onGround) {
      this.velocity.y = Math.sqrt(2 * -TUNING.gravity * TUNING.jumpHeight);
      this.onGround = false;
    }
    this.jumpQueued = false;
    this.velocity.y += TUNING.gravity * dt;

    before.copy(this.position);
    this.position.addScaledVector(this.velocity, dt);

    // capsule vs BVH: push the segment out of every triangle closer than the radius
    tmpSeg.start.set(this.position.x, this.position.y + TUNING.halfSegment, this.position.z);
    tmpSeg.end.set(this.position.x, this.position.y - TUNING.halfSegment, this.position.z);
    tmpBox.makeEmpty().expandByPoint(tmpSeg.start).expandByPoint(tmpSeg.end);
    tmpBox.min.addScalar(-TUNING.radius);
    tmpBox.max.addScalar(TUNING.radius);

    this.collider.shapecast({
      intersectsBounds: (box) => box.intersectsBox(tmpBox),
      intersectsTriangle: (tri) => {
        const dist = tri.closestPointToSegment(tmpSeg, triPoint, capPoint);
        if (dist < TUNING.radius) {
          const depth = TUNING.radius - dist;
          const dir = capPoint.sub(triPoint).normalize();
          tmpSeg.start.addScaledVector(dir, depth);
          tmpSeg.end.addScaledVector(dir, depth);
        }
      },
    });

    // resolved centre = midpoint of the pushed segment
    delta.addVectors(tmpSeg.start, tmpSeg.end).multiplyScalar(0.5).sub(this.position);
    const pushedUp = delta.y > Math.abs(dt * this.velocity.y * 0.25);
    this.position.add(delta);

    if (pushedUp && this.velocity.y <= 0) {
      this.onGround = true;
      this.velocity.y = 0;
    } else {
      this.onGround = false;
      if (delta.lengthSq() > 1e-10) {
        // remove the velocity component going into the surface
        delta.normalize();
        this.velocity.addScaledVector(delta, -delta.dot(this.velocity));
      }
    }

    if (this.onGround) {
      const moved = Math.hypot(this.position.x - before.x, this.position.z - before.z);
      this.stride += moved;
    }
  }

  private updateCamera(dt: number) {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    // head-bob fades in with speed and out in the air
    const target = this.onGround ? Math.min(speed / TUNING.walkSpeed, 1.3) : 0;
    this.bob += (target - this.bob) * (1 - Math.exp(-8 * dt));
    const phase = this.stride * TUNING.headbobFrequency * 0.5;
    const bobY = Math.abs(Math.sin(phase)) * TUNING.headbobHeight * this.bob;
    const bobX = Math.sin(phase) * TUNING.headbobSide * this.bob;

    this.camera.position.set(this.position.x, this.position.y + TUNING.eyeHeight + bobY, this.position.z);
    right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.camera.position.addScaledVector(right, bobX);
    this.camera.quaternion.setFromEuler(euler.set(this.pitch, this.yaw, 0));
  }
}
