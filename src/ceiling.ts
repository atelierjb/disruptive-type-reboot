import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

/**
 * A faint planar reflection of the sculptures in the ceiling. Not in the original: an addition.
 *
 * The mirror camera only sees MIRROR_LAYER: the sculptures, the lights (three culls lights by
 * layer too) and depth-only copies of the walls so sculptures in the next room stay hidden.
 * Everything else is cleared to transparent, so the overlay only darkens the ceiling where a
 * sculpture is mirrored and leaves the original ceiling colour untouched elsewhere.
 */
export const MIRROR_LAYER = 1;

const STRENGTH = 0.09; // reflection opacity looking straight up...
const GRAZING = 0.2; // ...rising toward grazing angles (a cheap Fresnel)
const RESOLUTION = 0.25; // reflection texture size relative to the drawing buffer
/** mip level the reflection is read from: each step halves the detail (3.5 ≈ 1/11 of the texture) */
const BLUR_LOD = 3.5;
const LOD = BLUR_LOD.toFixed(2);
const SPREAD = (2 ** BLUR_LOD).toFixed(2); // tap distance in base-level texels, matching the mip

const shader = {
  name: 'CeilingReflection',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    texel: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorldPosition;
    void main() {
      vUv = textureMatrix * vec4( position, 1.0 );
      vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 texel;
    varying vec4 vUv;
    varying vec3 vWorldPosition;
    void main() {
      vec2 uv = vUv.xy / vUv.w;
      // Read from a coarse mip (already a box-filtered average of the whole neighbourhood), then
      // soften its blockiness with two rings of taps spaced at that mip's texel size.
      vec2 a = texel * ${SPREAD} * 0.5;
      vec2 b = texel * ${SPREAD} * 1.33;
      vec4 r = textureLod( tDiffuse, uv, ${LOD} ) * 0.2
        + ( textureLod( tDiffuse, uv + vec2( a.x, a.y ), ${LOD} ) + textureLod( tDiffuse, uv + vec2( -a.x, a.y ), ${LOD} )
          + textureLod( tDiffuse, uv + vec2( a.x, -a.y ), ${LOD} ) + textureLod( tDiffuse, uv + vec2( -a.x, -a.y ), ${LOD} ) ) * 0.12
        + ( textureLod( tDiffuse, uv + vec2( b.x, 0.0 ), ${LOD} ) + textureLod( tDiffuse, uv + vec2( -b.x, 0.0 ), ${LOD} )
          + textureLod( tDiffuse, uv + vec2( 0.0, b.y ), ${LOD} ) + textureLod( tDiffuse, uv + vec2( 0.0, -b.y ), ${LOD} ) ) * 0.08;
      float facing = abs( normalize( cameraPosition - vWorldPosition ).y );
      // premultiplied: the cleared texels (a = 0) leave the ceiling exactly as it was
      gl_FragColor = r * mix( ${GRAZING.toFixed(3)}, ${STRENGTH.toFixed(3)}, facing );
    }`,
};

export interface CeilingMirror {
  mesh: Reflector;
  /** call with the drawing-buffer size (CSS size × pixel ratio) */
  setSize(width: number, height: number): void;
}

/** `ceiling`: world bounds of the ceiling slab; the mirror sits on its underside. */
export function createCeilingMirror(ceiling: THREE.Box3, camera: THREE.Camera): CeilingMirror {
  const size = ceiling.getSize(new THREE.Vector3());
  const center = ceiling.getCenter(new THREE.Vector3());
  const mesh = new Reflector(new THREE.PlaneGeometry(size.x, size.z), { shader, multisample: 0, textureWidth: 1, textureHeight: 1 });
  mesh.name = 'ceiling-mirror';
  mesh.rotation.x = Math.PI / 2; // plane normal +Z -> facing down into the room
  mesh.position.set(center.x, ceiling.min.y - 0.01, center.z);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;

  const material = mesh.material as THREE.ShaderMaterial;
  material.transparent = true;
  material.premultipliedAlpha = true;
  material.depthWrite = false;

  mesh.getReflectionCamera(camera).layers.set(MIRROR_LAYER);

  // Mipmapped so the shader can read a pre-blurred level. 8-bit is plenty for a faint overlay
  // (the gamma workflow never exceeds 1.0 anyway) and mipmaps on 8-bit work on every GPU.
  const texture = mesh.getRenderTarget().texture;
  texture.type = THREE.UnsignedByteType;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;

  // The room never moves, so the reflection only changes when the camera does.
  const reflect = mesh.onBeforeRender;
  const lastWorld = new THREE.Matrix4();
  const lastProjection = new THREE.Matrix4();
  let dirty = true;
  mesh.onBeforeRender = function (renderer, scene, cam, ...rest) {
    if (!dirty && lastWorld.equals(cam.matrixWorld) && lastProjection.equals(cam.projectionMatrix)) return;
    dirty = false;
    lastWorld.copy(cam.matrixWorld);
    lastProjection.copy(cam.projectionMatrix);
    // clear to transparent with no sky, so only the sculptures end up in the texture
    const background = scene.background;
    const clearAlpha = renderer.getClearAlpha();
    scene.background = null;
    renderer.setClearAlpha(0);
    reflect.call(this, renderer, scene, cam, ...rest);
    scene.background = background;
    renderer.setClearAlpha(clearAlpha);
  };

  return {
    mesh,
    setSize(width, height) {
      const w = Math.max(1, Math.round(width * RESOLUTION));
      const h = Math.max(1, Math.round(height * RESOLUTION));
      mesh.getRenderTarget().setSize(w, h);
      material.uniforms.texel.value.set(1 / w, 1 / h);
      dirty = true;
    },
  };
}
