import './style.css';
import * as THREE from 'three';
import { createWorld, type World } from './world';
import { Player, TUNING } from './player';
import { Exhibits } from './exhibits';
import { Footsteps } from './footsteps';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('world');
const menu = $('menu');
const menuMain = $('menu-main');
const menuInfo = $('menu-info');
const btnStart = $<HTMLButtonElement>('btn-start');
const hud = $('hud');
const pause = $('pause');
const load = $('load');
const joystick = $('joystick');
const stick = $('stick');

const isTouch = matchMedia('(pointer: coarse)').matches;

// ---------- menu scaling (Unity CanvasScaler: 1280x800 reference) ----------
function fitMenu() {
  // Unity matched width on a 1280x800 canvas. The artwork's content sits inside ~960px of it
  // (the rest is white margin), so fit that to give phones bigger tap targets.
  const s = Math.min(window.innerWidth / 960, window.innerHeight / 800);
  document.documentElement.style.setProperty('--ui', String(s));
}
fitMenu();
addEventListener('resize', fitMenu);

$('btn-info').addEventListener('click', () => {
  menuMain.hidden = true;
  menuInfo.hidden = false;
  $('btn-back').focus();
});
$('btn-back').addEventListener('click', () => {
  menuInfo.hidden = true;
  menuMain.hidden = false;
  $('btn-info').focus();
});

// ---------- world: starts loading while the visitor reads the menu ----------
let world: World | null = null;
let player: Player;
let exhibits: Exhibits;
const footsteps = new Footsteps();

btnStart.setAttribute('aria-busy', 'true');
const ready = createWorld(canvas, (p) => load.style.setProperty('--p', p.toFixed(3)))
  .then((w) => {
    world = w;
    player = new Player(w.camera, w.collider);
    player.placeAt(w.data.player.eye, w.data.player.forward);
    w.camera.fov = w.data.player.fov;
    exhibits = new Exhibits(w.data.triggers, $<HTMLImageElement>('tag'));
    load.classList.add('done');
    btnStart.removeAttribute('aria-busy');
    if (import.meta.env.DEV) Object.assign(window, { __ex: { world: w, player, exhibits, THREE } });
    return w;
  })
  .catch((err) => {
    console.error(err);
    load.textContent = 'Could not load the exhibition. Please reload.';
    throw err;
  });

// ---------- state ----------
type Mode = 'menu' | 'exhibition' | 'paused';
let mode: Mode = 'menu';

async function enter() {
  footsteps.unlock(); // inside the click gesture
  if (!isTouch) canvas.requestPointerLock?.();
  await ready;
  menu.classList.add('leaving');
  setTimeout(() => (menu.hidden = true), 500);
  hud.hidden = false;
  resume();
}

function resume() {
  pause.hidden = true;
  mode = 'exhibition';
  footsteps.unlock();
  last = performance.now();
  requestAnimationFrame(frame);
}

function doPause() {
  if (mode !== 'exhibition') return;
  mode = 'paused';
  player.keys.clear();
  player.moveAxis.set(0, 0);
  footsteps.suspend();
  world?.renderer.render(world.scene, world.camera); // keep the room visible behind the overlay
  pause.hidden = false;
  $('btn-resume').focus();
}

function toMenu() {
  mode = 'menu';
  pause.hidden = true;
  hud.hidden = true;
  exhibits.reset();
  player.respawn();
  menu.hidden = false;
  menu.classList.remove('leaving');
  menuInfo.hidden = true;
  menuMain.hidden = false;
  btnStart.focus();
}

btnStart.addEventListener('click', enter);
$('btn-resume').addEventListener('click', () => {
  if (!isTouch) canvas.requestPointerLock?.();
  resume();
});
$('btn-menu').addEventListener('click', toMenu);

// ---------- desktop input ----------
// If the browser refuses pointer lock (iframes, embeds, Safari right after Esc),
// fall back to click-and-drag looking instead of trapping the visitor on the pause screen.
let dragLook = false;
let hadLock = false;
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    hadLock = true;
    dragLook = false;
  } else if (hadLock) {
    hadLock = false;
    doPause();
  }
});
document.addEventListener('pointerlockerror', () => {
  if (!isTouch) dragLook = true;
});
document.addEventListener('mousemove', (e) => {
  if (mode !== 'exhibition') return;
  if (document.pointerLockElement === canvas || (dragLook && e.buttons & 1)) player.look(e.movementX, e.movementY);
});
addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && dragLook) doPause();
});
addEventListener('keydown', (e) => {
  if (mode !== 'exhibition') return;
  if (e.code === 'Space') player.jumpQueued = true;
  else player.keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => player?.keys.delete(e.code));
addEventListener('blur', () => player?.keys.clear());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) doPause();
});

// ---------- touch: left half = move joystick, right half = look, tap right = jump ----------
if (isTouch) {
  let moveId = -1;
  const origin = new THREE.Vector2();
  const looks = new Map<number, { x: number; y: number; t: number; moved: boolean }>();
  const R = 50;
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'exhibition') return;
    canvas.setPointerCapture(e.pointerId);
    if (e.clientX < innerWidth / 2 && moveId < 0) {
      moveId = e.pointerId;
      origin.set(e.clientX, e.clientY);
      joystick.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      stick.style.transform = '';
      joystick.classList.add('on');
    } else {
      looks.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: false });
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId === moveId) {
      const dx = THREE.MathUtils.clamp(e.clientX - origin.x, -R, R);
      const dy = THREE.MathUtils.clamp(e.clientY - origin.y, -R, R);
      stick.style.transform = `translate(${dx}px, ${dy}px)`;
      player.moveAxis.set(dx / R, -dy / R);
    } else {
      const l = looks.get(e.pointerId);
      if (!l) return;
      const dx = e.clientX - l.x;
      const dy = e.clientY - l.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) l.moved = true;
      player.look(dx, dy, TUNING.touchLookSensitivity);
      l.x = e.clientX;
      l.y = e.clientY;
    }
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId === moveId) {
      moveId = -1;
      player.moveAxis.set(0, 0);
      joystick.classList.remove('on');
    }
    const l = looks.get(e.pointerId);
    if (l && !l.moved && performance.now() - l.t < 250) player.jumpQueued = true;
    looks.delete(e.pointerId);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

// ---------- resize + adaptive resolution ----------
const maxRatio = Math.min(devicePixelRatio, 2);
let ratio = maxRatio;
function resize() {
  if (!world) return;
  world.renderer.setPixelRatio(ratio);
  world.renderer.setSize(innerWidth, innerHeight, false);
  world.camera.aspect = innerWidth / innerHeight;
  world.camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
ready.then(resize);

let slowFrames = 0;
let fastFrames = 0;
function adapt(dt: number) {
  // drop resolution if we're consistently under ~50fps, recover slowly when there's headroom
  if (dt > 0.02) slowFrames++;
  else if (dt < 0.012) fastFrames++;
  if (slowFrames > 45 && ratio > 0.75) {
    ratio = Math.max(0.75, ratio - 0.25);
    resize();
    slowFrames = fastFrames = 0;
  } else if (fastFrames > 600 && ratio < maxRatio) {
    ratio = Math.min(maxRatio, ratio + 0.25);
    resize();
    slowFrames = fastFrames = 0;
  }
  if (slowFrames + fastFrames > 600) slowFrames = fastFrames = 0;
}

// ---------- loop ----------
let last = performance.now();
function frame(now: number) {
  if (mode !== 'exhibition' || !world) return;
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  player.update(dt);
  exhibits.update(player.position);
  footsteps.update(player.stride);
  world.renderer.render(world.scene, world.camera);
  adapt(dt);
  requestAnimationFrame(frame);
}
