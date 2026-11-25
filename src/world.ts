import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';

export interface Trigger {
  name: string;
  tag: string;
  center: [number, number, number];
  /** full-extent box axes (columns of the Unity collider's world matrix) */
  axes: [number, number, number][];
}

interface LightData {
  type: number;
  dir: [number, number, number];
  color: [number, number, number];
  intensity: number;
  shadows: number;
  /** Unity LightmapBakeType: 4 realtime, 2 baked, 1 mixed */
  bake: number;
}

export interface SceneData {
  player: { eye: [number, number, number]; forward: [number, number, number]; fov: number; near: number; far: number };
  triggers: Trigger[];
  lights: LightData[];
}

export interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  collider: MeshBVH;
  data: SceneData;
}

const A = '/assets';

// The Unity "Outside" plane: 500x500 at y=6.6, rendered with the skybox shader (i.e. invisible
// against the sky) but solid, so you can't fall forever if you leave the building.
const GROUND_Y = 6.6;

/** Unity's diffuse term has no 1/π; three's punctual lights do. */
const UNITY_LIGHT_SCALE = Math.PI;
const ENV_INTENSITY = 0.12;

/** Unity material colours are authored in sRGB. */
const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

function loadTexture(loader: THREE.TextureLoader, url: string, srgb: boolean) {
  return loader.loadAsync(url).then((t) => {
    t.flipY = false; // UVs were exported in glTF convention
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  });
}

export async function createWorld(canvas: HTMLCanvasElement, onProgress: (p: number) => void): Promise<World> {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // The original camera had no post-processing: no tone mapping, highlights clip to white.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Nothing in the room moves, so shadow maps are rendered once instead of every frame.
  renderer.shadowMap.autoUpdate = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);

  // ---- progress over the parallel downloads ----
  const weights: Record<string, number> = { glb: 2200, col: 200, tex: 900, sky: 340 };
  const done: Record<string, number> = {};
  const tick = (k: string, f = 1) => {
    done[k] = f;
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    onProgress(Object.entries(done).reduce((a, [kk, v]) => a + weights[kk] * v, 0) / total);
  };

  const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const tl = new THREE.TextureLoader();

  const [data, visual, collision, tex, sky] = await Promise.all([
    fetch(`${A}/scene.json`).then((r) => r.json() as Promise<SceneData>),
    gltf.loadAsync(`${A}/exhibition.glb`, (e) => e.total && tick('glb', e.loaded / e.total)).then((g) => (tick('glb'), g)),
    gltf.loadAsync(`${A}/collision.glb`).then((g) => (tick('col'), g)),
    Promise.all([
      loadTexture(tl, `${A}/tex/metal_base.webp`, true),
      loadTexture(tl, `${A}/tex/metal_orm.webp`, false),
      loadTexture(tl, `${A}/tex/detail_normal.webp`, false),
      loadTexture(tl, `${A}/tex/glass.webp`, true),
    ]).then((t) => (tick('tex'), t)),
    new THREE.CubeTextureLoader()
      .setPath(`${A}/sky/`)
      .loadAsync(['px.webp', 'nx.webp', 'py.webp', 'ny.webp', 'pz.webp', 'nz.webp'])
      .then((t) => (tick('sky'), t)),
  ]);

  // ---- sky ----
  // Unity drew this cubemap as the skybox, but the scene's lighting was never baked: the ambient
  // probe is all zeros and the default reflection probe is black. That is what makes the sculptures
  // read as dark chrome. We keep a faint sky reflection so they're not pure black between highlights.
  sky.colorSpace = THREE.SRGBColorSpace;
  scene.background = sky;
  scene.backgroundIntensity = 0.9; // material _Exposure
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromCubemap(sky).texture;
  pmrem.dispose();

  // ---- materials, recreated from the Unity Standard shader values ----
  const [metalBase, metalOrm, detailNormal, glassTex] = tex;
  for (const t of [metalBase, metalOrm]) t.repeat.set(-0.66, 0.66); // _MainTex tiling
  const materials: Record<string, THREE.Material> = {
    '[free] Aluminum common': new THREE.MeshStandardMaterial({
      name: 'aluminium',
      color: srgb(0.941, 0.94, 0.934),
      map: metalBase,
      metalness: 1,
      metalnessMap: metalOrm,
      roughness: 1,
      roughnessMap: metalOrm,
      aoMap: metalOrm,
      normalMap: detailNormal,
      normalScale: new THREE.Vector2(0.19, 0.19), // _DetailNormalMapScale
      // Black reflection probe in the original: the chrome only catches the suns' highlights.
      // Even a few % of the bright pastel sky turns it rust/teal, so it gets none.
      envMapIntensity: 0,
    }),
    '[free] Glass generic slightly dusty': new THREE.MeshStandardMaterial({
      name: 'glass',
      color: srgb(1, 0.963, 0.963),
      map: glassTex,
      metalness: 0,
      roughness: 0.02,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    'Black Matte': new THREE.MeshStandardMaterial({ name: 'black', color: 0x000000, roughness: 1, metalness: 0 }),
    'New Material': new THREE.MeshStandardMaterial({
      name: 'wall',
      color: 0xffffff,
      emissive: srgb(0.66, 0.66, 0.66),
      metalness: 0.16,
      roughness: 0.2,
    }),
    'New Material 1': new THREE.MeshStandardMaterial({
      name: 'wall-2',
      color: srgb(0.811, 0.811, 0.811),
      emissive: srgb(0.519, 0.519, 0.519),
      metalness: 0.16,
      roughness: 0.2,
    }),
  };

  // Unity renders shadow casters with back-face culling, so the single-sided walls and ceiling
  // (faces pointing into the room) never blocked the sun: light came "through" them and only the
  // window frames threw shadows. three defaults to the opposite; FrontSide reproduces Unity.
  for (const k of ['New Material', 'New Material 1']) materials[k].shadowSide = THREE.FrontSide;
  for (const m of Object.values(materials) as THREE.MeshStandardMaterial[]) {
    if (m.envMapIntensity === 0) continue;
    m.envMap = envMap;
    if (m.envMapIntensity === 1) m.envMapIntensity = ENV_INTENSITY;
  }

  // GLTFLoader sanitizes node names ("[free] Glass generic…" -> "free_Glass_generic…"),
  // so match against sanitized material names.
  const bySanitized = new Map(Object.entries(materials).map(([k, m]) => [THREE.PropertyBinding.sanitizeNodeName(k), m]));

  const bounds = new THREE.Box3();
  // bake node matrices (quantization stores offsets on nodes) before freezing them
  visual.scene.updateMatrixWorld(true);
  visual.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const matName = mesh.name.split('__')[1];
    const mat = bySanitized.get(matName);
    if (!mat) console.warn('No material for', mesh.name);
    mesh.material = mat ?? materials['New Material'];
    // Unity's built-in pipeline never lets transparent materials cast shadows
    const isGlass = mesh.material === materials['[free] Glass generic slightly dusty'];
    mesh.castShadow = !isGlass;
    mesh.receiveShadow = !isGlass;
    if (isGlass) mesh.renderOrder = 1;
    mesh.matrixAutoUpdate = false;
    bounds.expandByObject(mesh);
  });
  visual.scene.matrixAutoUpdate = false;
  scene.add(visual.scene);

  // ---- lights: only Unity's realtime lights contributed at runtime ----
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  for (const l of data.lights.filter((l) => l.bake === 4 || l.bake === 1)) {
    const light = new THREE.DirectionalLight(srgb(...l.color), l.intensity * UNITY_LIGHT_SCALE);
    const dir = new THREE.Vector3(...l.dir).normalize();
    light.position.copy(center).addScaledVector(dir, -radius * 1.5);
    light.target.position.copy(center);
    light.castShadow = l.shadows > 0;
    const s = light.shadow;
    s.mapSize.set(2048, 2048);
    s.bias = -0.0002;
    s.normalBias = 0.12; // grazing sun (15°) needs a generous normal offset to avoid acne
    s.radius = 3;
    const cam = s.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 0.5;
    cam.far = radius * 3.2;
    scene.add(light, light.target);
  }
  renderer.shadowMap.needsUpdate = true;

  // ---- collision: building exact, sculptures simplified, plus the ground plane ----
  const geoms: THREE.BufferGeometry[] = [];
  collision.scene.updateMatrixWorld(true);
  collision.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Dequantize to float32 *before* applying the node transform: positions are stored as
    // normalized int16 (KHR_mesh_quantization) and writing world coords back would clamp to [-1, 1].
    const p = mesh.geometry.getAttribute('position');
    const f = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) f.set([p.getX(i), p.getY(i), p.getZ(i)], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(f, 3));
    g.setIndex(mesh.geometry.getIndex()!.clone());
    g.applyMatrix4(mesh.matrixWorld);
    geoms.push(g);
  });
  const ground = new THREE.PlaneGeometry(500, 500).rotateX(-Math.PI / 2).translate(6.2, GROUND_Y, -65.2);
  ground.deleteAttribute('normal');
  ground.deleteAttribute('uv');
  ground.setIndex(Array.from(ground.getIndex()!.array)); // same index type as the rest
  geoms.push(ground);
  const merged = mergeGeometries(geoms, false)!;
  const collider = new MeshBVH(merged);

  // warm up shaders so the first frame in the room doesn't hitch
  camera.position.set(...data.player.eye);
  await renderer.compileAsync(scene, camera);

  return { renderer, scene, camera, collider, data };
}
