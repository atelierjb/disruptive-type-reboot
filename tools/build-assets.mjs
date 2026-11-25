// Turns the raw Unity extraction (.cache/extract) into web-ready assets in public/assets.
//   node tools/build-assets.mjs
// Geometry: weld + simplify the sculptures, meshopt-compress, quantize.
// Collision: building kept exact, sculptures simplified hard (you only bump into them).
// Textures -> webp, audio -> mp3, Unity cubemap faces -> three.js cube order.
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { weld, simplifyPrimitive, prune, dedup, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SRC = '.cache/extract';
const OUT = 'public/assets';
for (const d of ['', 'ui', 'tex', 'sky', 'audio']) fs.mkdirSync(path.join(OUT, d), { recursive: true });

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
});

const triCount = (doc) =>
  doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().reduce((a, p) => a + p.getIndices().getCount() / 3, 0), 0);

function keepNodes(doc, pred) {
  for (const node of doc.getRoot().listNodes()) if (!pred(node.getName())) node.dispose();
}

/** Simplify only meshes whose node name matches `pred`. */
function simplifyWhere(doc, pred, ratio, error) {
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !pred(node.getName())) continue;
    for (const prim of mesh.listPrimitives()) {
      simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio, error, lockBorder: false });
    }
  }
}

// ---------- visual geometry ----------
{
  const doc = await io.read(path.join(SRC, 'exhibition.raw.glb'));
  keepNodes(doc, (n) => !n.startsWith('collision'));
  const before = triCount(doc);
  await doc.transform(weld());
  simplifyWhere(doc, (n) => n.startsWith('sculpture'), 0.2, 0.0004);
  await doc.transform(prune({ keepAttributes: true }), dedup(), quantize({ quantizeNormal: 10 }), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  await io.write(path.join(OUT, 'exhibition.glb'), doc);
  console.log('visual tris', before, '->', triCount(doc), (fs.statSync(path.join(OUT, 'exhibition.glb')).size / 1e6).toFixed(2) + 'MB');
}

// ---------- collision geometry ----------
{
  const doc = await io.read(path.join(SRC, 'exhibition.raw.glb'));
  keepNodes(doc, (n) => n.startsWith('collision'));
  await doc.transform(weld());
  simplifyWhere(doc, (n) => n === 'collision__sculpture', 0.05, 0.002);
  await doc.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  await io.write(path.join(OUT, 'collision.glb'), doc);
  console.log('collision tris', triCount(doc), (fs.statSync(path.join(OUT, 'collision.glb')).size / 1e6).toFixed(2) + 'MB');
}

// ---------- scene data ----------
fs.copyFileSync(path.join(SRC, 'scene.json'), path.join(OUT, 'scene.json'));

// ---------- UI images ----------
for (const f of fs.readdirSync(path.join(SRC, 'ui'))) {
  const name = f.replace(/\.png$/, '');
  await sharp(path.join(SRC, 'ui', f)).webp({ quality: 90, alphaQuality: 100 }).toFile(path.join(OUT, 'ui', name + '.webp'));
}

// ---------- material textures ----------
// Unity Standard: _MetallicGlossMap R=metal A=smoothness, _OcclusionMap G=AO.
// glTF/three:      roughnessMap G, metalnessMap B, aoMap R.  Pack into one ORM image.
{
  const src = path.join(SRC, 'tex', 'copper common metalness.png');
  const size = 1024;
  const { data, info } = await sharp(src).resize(size, size).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const orm = Buffer.alloc(size * size * 3);
  const glossMapScale = 0.885;
  for (let i = 0; i < size * size; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], a = data[i * 4 + 3];
    orm[i * 3] = g; // AO
    orm[i * 3 + 1] = Math.round(255 * (1 - (a / 255) * glossMapScale)); // roughness
    orm[i * 3 + 2] = r; // metalness
  }
  await sharp(orm, { raw: { width: size, height: size, channels: 3 } }).webp({ quality: 90 }).toFile(path.join(OUT, 'tex', 'metal_orm.webp'));
  await sharp(src).resize(size, size).removeAlpha().webp({ quality: 88 }).toFile(path.join(OUT, 'tex', 'metal_base.webp'));
  await sharp(path.join(SRC, 'tex', 'glass generic slightly dusty diffuse.png')).resize(1024, 1024).webp({ quality: 85, alphaQuality: 90 }).toFile(path.join(OUT, 'tex', 'glass.webp'));
  await sharp(path.join(SRC, 'tex', 'common huge bumps normal.png')).resize(512, 512).removeAlpha().webp({ quality: 90 }).toFile(path.join(OUT, 'tex', 'detail_normal.webp'));
}

// ---------- sky cubemap ----------
// Unity faces: +X -X +Y -Y +Z -Z, decoded bottom-up. We mirrored the world in X, so +X/-X swap
// and every face is mirrored horizontally; the vertical flip undoes the bottom-up storage.
{
  const order = { px: 1, nx: 0, py: 2, ny: 3, pz: 4, nz: 5 };
  for (const [k, i] of Object.entries(order)) {
    await sharp(path.join(SRC, 'cube', `face${i}.png`)).flip().flop().resize(1024, 1024).webp({ quality: 92 }).toFile(path.join(OUT, 'sky', `${k}.webp`));
  }
}

// ---------- footsteps ----------
for (const f of fs.readdirSync(path.join(SRC, 'audio'))) {
  const out = path.join(OUT, 'audio', f.replace(/\.wav$/, '.mp3').toLowerCase());
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(SRC, 'audio', f), '-b:a', '96k', out]);
}

console.log('done');
