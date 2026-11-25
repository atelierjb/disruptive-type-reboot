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
  // Unity's menu canvas scaled with screen width (1280 reference). On portrait phones (which the
  // original didn't support) fit the ~960px of actual artwork instead, for usable tap targets.
  const w = window.innerWidth;
  const h = window.innerHeight;
  const s = w >= h ? w / 1280 : Math.min(w / 960, h / 800);
  const root = document.documentElement.style;
  root.setProperty('--ui', String(s));
  root.setProperty('--dpr', String(window.devicePixelRatio || 1));
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

// requestPointerLock returns a promise in modern browsers and rejects when the lock is refused
// (iframes, embeds, Safari right after Esc). Fall back to drag-to-look instead of erroring.
function lockPointer() {
  const result = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
  result?.catch?.(() => {
    dragLook = true;
  });
}

// ---------- state ----------
let dragLook = false;
type Mode = 'menu' | 'exhibition' | 'paused';
let mode: Mode = 'menu';

async function enter() {
  footsteps.unlock(); // inside the click gesture
  if (!isTouch) lockPointer();
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
  if (!isTouch) lockPointer();
  resume();
});
$('btn-menu').addEventListener('click', toMenu);

// ---------- desktop input ----------
// If the browser refuses pointer lock (iframes, embeds, Safari right after Esc),
// fall back to click-and-drag looking instead of trapping the visitor on the pause screen.
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
  // ignore momentary flickers (screenshots, OS overlays); a real tab switch stays hidden
  if (document.hidden) setTimeout(() => document.hidden && doPause(), 200);
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

// Adaptive resolution, driven by measured GPU time where the browser exposes it. Frame intervals
// alone can't tell a struggling GPU from a browser capping the frame rate (background pane,
// battery saver), and dropping resolution in the latter just makes the room blurrier.
let gpuTimer: { gl: WebGL2RenderingContext; ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } } | null = null;
let pendingQuery: WebGLQuery | null = null;
const samples: number[] = [];
let headroom = 0;

ready.then((w) => {
  const gl = w.renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (ext) gpuTimer = { gl, ext };
});

function setRatio(next: number) {
  ratio = next;
  resize();
  headroom = 0;
}

/** cost of one frame in ms: GPU time if measurable, otherwise the frame interval */
function judge(costMs: number, budgetMs: number, cheapMs: number) {
  samples.push(costMs);
  if (samples.length < 15) return;
  const median = [...samples].sort((a, b) => a - b)[7];
  samples.length = 0;
  if (median > budgetMs && ratio > 0.75) setRatio(Math.max(0.75, ratio - 0.25));
  else if (median < cheapMs && ratio < maxRatio && ++headroom > 8) setRatio(Math.min(maxRatio, ratio + 0.25));
}

function renderTimed(w: World, dt: number) {
  const t = gpuTimer;
  if (!t) {
    w.renderer.render(w.scene, w.camera);
    judge(dt * 1000, 20, 12);
    return;
  }
  const { gl, ext } = t;
  if (pendingQuery && gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT_AVAILABLE)) {
    if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) judge(gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT) / 1e6, 12, 4);
    gl.deleteQuery(pendingQuery);
    pendingQuery = null;
  }
  if (pendingQuery) {
    w.renderer.render(w.scene, w.camera);
    return;
  }
  pendingQuery = gl.createQuery();
  gl.beginQuery(ext.TIME_ELAPSED_EXT, pendingQuery!);
  w.renderer.render(w.scene, w.camera);
  gl.endQuery(ext.TIME_ELAPSED_EXT);
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
  renderTimed(world, dt);
  requestAnimationFrame(frame);
}
