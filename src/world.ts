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

// The Unity "Outside" plane: 500x500 at y=6.6. It used a skybox material, and skybox shaders don't
// write depth, so the real skybox painted over it: invisible, but solid. We keep it as collision only.
const GROUND_Y = 6.6;

/**
 * The Unity project used the *Gamma* colour space: lighting maths ran directly on sRGB values.
 * We reproduce that by never decoding textures/colours and never encoding the output, so three's
 * shading runs on the same numbers Unity's did.
 */
const raw = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

/**
 * Unity → three light scales. three's diffuse carries a 1/π that Unity's doesn't, and Unity's
 * WebGL Standard BRDF differs in detail, so these were fitted by rendering the exact camera poses
 * of two screenshots of the running original and minimising per-pixel error.
 */
const UNITY_LIGHT_SCALE = 2.66; // the three realtime suns
const UNITY_SPEC_SCALE = 0.526; // specular term relative to three's light intensity
const UNITY_FILL_SCALE = 2.9; // the four fill lights Unity folded into spherical harmonics

/**
 * Unity "High" quality (the WebGL default for this build): shadows only exist within 40 units of
 * the camera and fade out towards that distance. That is why far walls look sunlit while the floor
 * around you sits in the roof's shadow, and it changes as you walk around. three has no such
 * setting, so we patch the directional shadow term to fade with view distance.
 */
const SHADOW_DISTANCE = 40;
const SHADOW_FADE_START = SHADOW_DISTANCE * 0.85;
const SHADOW_LINE =
  'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';

/**
 * Patches three's MeshStandardMaterial to behave like Unity's Standard shader in Gamma colour space:
 *  - shadow distance fade (see above)
 *  - specular term square-rooted, exactly as UnityStandardBRDF.cginc does under
 *    UNITY_COLORSPACE_GAMMA. This gives metals their broad grey sheen instead of tight
 *    highlights on black, and gives the glossy white walls their soft glare.
 *  - dielectric reflectance of 0.22 (unity_ColorSpaceDielectricSpec in gamma) instead of 0.04
 */
const GGX_RETURN = '\n\treturn F * ( V * D );';
const DIELECTRIC = 'material.specularColor = vec3( 0.04 );';

function unityStandard(material: THREE.Material) {
  material.onBeforeCompile = (shader) => {
    const lights = THREE.ShaderChunk.lights_fragment_begin;
    const brdf = THREE.ShaderChunk.lights_physical_pars_fragment;
    const phys = THREE.ShaderChunk.lights_physical_fragment;
    if (!lights.includes(SHADOW_LINE) || !brdf.includes(GGX_RETURN) || !phys.includes(DIELECTRIC)) {
      console.warn('three shader chunks changed; Unity shading patch not applied');
      return;
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <shadowmap_pars_fragment>',
        `#include <shadowmap_pars_fragment>
        float unityShadowFade() {
          return smoothstep( ${SHADOW_FADE_START.toFixed(1)}, ${SHADOW_DISTANCE.toFixed(1)}, length( vViewPosition ) );
        }`,
      )
      .replace(
        '#include <lights_fragment_begin>',
        // Fade computed once per fragment; past the shadow distance the ternary skips the shadow
        // lookups entirely (GLSL only evaluates the chosen branch) instead of sampling and discarding.
        'float unityFadeAmount = unityShadowFade();\n' +
          lights.replace(
            SHADOW_LINE,
            SHADOW_LINE.replace('( directLight.visible && receiveShadow )', '( directLight.visible && receiveShadow && unityFadeAmount < 1.0 )')
              .replace('? getShadow(', '? mix( getShadow(')
              .replace(') : 1.0;', '), 1.0, unityFadeAmount ) : 1.0;'),
          ),
      )
      .replace(
        '#include <lights_physical_pars_fragment>',
        // Unity: spec = sqrt(V*D*PI) * F * light. three multiplies by its (rescaled) light intensity
        brdf.replace(GGX_RETURN, `\n\treturn F * sqrt( max( 1e-4, V * D * PI ) ) * ${UNITY_SPEC_SCALE.toFixed(4)};`),
      )
      .replace('#include <lights_physical_fragment>', phys.replace(DIELECTRIC, 'material.specularColor = vec3( 0.220916301 );'));
  };
  material.customProgramCacheKey = () => 'unity-standard-gamma';
  return material;
}

function loadTexture(loader: THREE.TextureLoader, url: string) {
  return loader.loadAsync(url).then((t) => {
    t.flipY = false; // UVs were exported in glTF convention
    t.colorSpace = THREE.NoColorSpace; // gamma workflow: sample raw values
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  });
}

export async function createWorld(canvas: HTMLCanvasElement, onProgress: (p: number) => void): Promise<World> {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // gamma workflow, see `raw`
  // The original camera had no post-processing: no tone mapping, highlights clip to white.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // radius 3 below; fitted against the original
  // Nothing in the room moves, so shadow maps are rendered once instead of every frame.
  renderer.shadowMap.autoUpdate = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);

  // ---- progress over the parallel downloads ----
  const weights: Record<string, number> = { glb: 3300, col: 450, tex: 310, sky: 340 };
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
      loadTexture(tl, `${A}/tex/metal_base.webp`),
      loadTexture(tl, `${A}/tex/metal_orm.webp`),
      loadTexture(tl, `${A}/tex/glass.webp`),
    ]).then(
      (t) => (tick('tex'), t),
    ),
    new THREE.CubeTextureLoader()
      .setPath(`${A}/sky/`)
      .loadAsync(['px.webp', 'nx.webp', 'py.webp', 'ny.webp', 'pz.webp', 'nz.webp'])
      .then((t) => (tick('sky'), t)),
  ]);

  // ---- sky ----
  // The faces already contain the decoded HDR sky with the skybox material's tint and exposure.
  sky.colorSpace = THREE.NoColorSpace;
  scene.background = sky;

  // ---- materials, recreated from the Unity Standard shader values ----
  // Lighting was never baked in the original: the ambient probe is all zeros and the reflection
  // probe is black. So there is no environment lighting at all, only emission and the three suns.
  // That is what makes the sculptures read as black chrome with crisp highlights.
  const [metalBase, metalOrm, glassTex] = tex;
  for (const t of [metalBase, metalOrm]) t.repeat.set(-0.66, 0.66); // _MainTex tiling
  const materials: Record<string, THREE.Material> = {
    '[free] Aluminum common': new THREE.MeshStandardMaterial({
      name: 'aluminium',
      color: raw(0.941, 0.94, 0.934),
      map: metalBase,
      // Unity _MetallicGlossMap: R = metallic, A = smoothness * _GlossMapScale (packed as ORM)
      metalness: 1,
      metalnessMap: metalOrm,
      roughness: 0.7, // fitted against the original; scales the map's roughness
      roughnessMap: metalOrm,
    }),
    '[free] Glass generic slightly dusty': new THREE.MeshStandardMaterial({
      name: 'glass',
      color: raw(1, 0.963, 0.963),
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
      color: raw(1, 1, 1),
      emissive: raw(0.66, 0.66, 0.66),
      metalness: 0.16,
      roughness: 0.2,
    }),
    'New Material 1': new THREE.MeshStandardMaterial({
      name: 'wall-2',
      color: raw(0.811, 0.811, 0.811),
      emissive: raw(0.519, 0.519, 0.519),
      metalness: 0.16,
      roughness: 0.2,
    }),
  };

  // Unity renders shadow casters with back-face culling, so the single-sided walls and ceiling
  // (faces pointing into the room) never blocked the sun: light came "through" them and only the
  // window frames threw shadows. three defaults to the opposite; FrontSide reproduces Unity.
  for (const k of ['New Material', 'New Material 1']) materials[k].shadowSide = THREE.FrontSide;
  for (const m of Object.values(materials)) unityStandard(m);

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

  // ---- lights ----
  // The scene was never lightmapped, so Unity treated its "Baked" lights as realtime too.
  // The three 1.1-intensity suns were per-pixel with shadows; the four dim 0.2 fill lights (all
  // pointing upwards) fell outside the pixel-light budget and were folded into spherical harmonics.
  // They are what lifts the ceiling and window sills off pure emission grey.
  const sh = new THREE.SphericalHarmonics3();
  const basis: number[] = new Array(9).fill(0);
  for (const l of data.lights.filter((l) => l.bake === 2)) {
    const toLight = new THREE.Vector3(...l.dir).normalize().negate();
    THREE.SphericalHarmonics3.getBasisAt(toLight, basis);
    for (let i = 0; i < 9; i++) {
      sh.coefficients[i].add(new THREE.Vector3(...l.color).multiplyScalar(l.intensity * UNITY_FILL_SCALE * basis[i]));
    }
  }
  scene.add(new THREE.LightProbe(sh, 1));

  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  for (const l of data.lights.filter((l) => l.bake === 4 || l.bake === 1)) {
    const light = new THREE.DirectionalLight(raw(...l.color), l.intensity * UNITY_LIGHT_SCALE);
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
    for (let i = 0; i < p.count; i++) {
      f[i * 3] = p.getX(i);
      f[i * 3 + 1] = p.getY(i);
      f[i * 3 + 2] = p.getZ(i);
    }
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
  // compileAsync only builds programs. Render once now (hidden behind the opaque menu) so the
  // geometry/texture uploads and the one-time shadow passes don't land on the menu fade-out.
  renderer.render(scene, camera);

  return { renderer, scene, camera, collider, data };
}
