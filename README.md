# DISRUPTIVE TYPE [2020 EXHIBITION]

A walkable virtual exhibition of "disruptive" type design: a sunlit white hall with 38 brushed-metal
letterform sculptures. Walk up to a sculpture and its info tag appears, naming the letterform, the
typeface and its designer.

It runs in the browser on **Vite + TypeScript + three.js**, with **three-mesh-bvh** for collision.
The exhibition first launched in 2020 as a Unity WebGL build; this version is a rebuild, and all of
its geometry, textures, UI art, sounds and layout were extracted from that original.

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # static site in dist/, deploy anywhere
npm run preview   # serve the production build locally
```

## Controls

| | Desktop | Touch |
|---|---|---|
| Walk | W A S D or arrow keys | drag on the left half of the screen |
| Look | mouse (click Start to lock the pointer) | drag on the right half |
| Sprint | Shift | |
| Jump | Space | tap on the right half |
| Pause | Esc | |

If the browser refuses pointer lock (iframes, embeds, Safari right after Esc), looking falls back to
click-and-drag.

## How it works

**Loading.** The world starts loading as soon as the page opens, while the visitor reads the menu.
The room is about 4 MB: meshopt-compressed geometry, WebP textures and a small sky cubemap. Another
~0.8 MB of tag images is fetched in idle time once the room is ready. Shaders are compiled and one
frame is rendered behind the menu, so entering the room doesn't stutter.

**Rendering.** All geometry is merged per material, so the whole hall is only a handful of draw
calls. The materials are three's `MeshStandardMaterial`, patched to behave like Unity's Standard
shader (see [Rendering notes](#rendering-notes)). Three directional suns cast shadows. The scene is
static, so their 2048² shadow maps are rendered once at load and never again, and shadows fade out
40 units from the camera.

**Ceiling reflection.** The ceiling carries a faint, heavily blurred mirror image of the sculptures
(`src/ceiling.ts`). A planar reflection camera renders only the sculptures, with depth-only copies of
the walls so sculptures in the next room stay hidden. It renders at quarter resolution and is read
back from a coarse mipmap, so the sculptures show only as soft patches. While the camera is still,
the reflection isn't re-rendered.

**Adaptive resolution.** The pixel ratio steps in quarters between 0.75 and the device's ratio
(capped at 2), according to measured GPU time
(`EXT_disjoint_timer_query_webgl2`). Where the timer is unavailable, it uses the frame interval.
Measuring GPU time means a browser capping the frame rate (a background pane, battery saver) doesn't
blur the room for nothing.

**Movement.** The first-person controller moves a capsule against a BVH of the collision mesh. That
mesh keeps the building exact and simplifies the sculptures, about 150k triangles in total.
Sub-stepping at 120 Hz keeps it from tunnelling through walls on slow frames. Head-bob and footsteps
are driven by distance walked, not time.

**Exhibits.** Each sculpture has an invisible oriented trigger box. While the player's capsule
overlaps one, that sculpture's tag image is shown; the most recently entered box wins.

## Tuning

| What | Where |
|---|---|
| Walk/sprint speed, jump height, gravity, mouse and touch sensitivity, head-bob | `TUNING` in `src/player.ts` |
| Ceiling reflection: opacity (`STRENGTH`, `GRAZING`), blur (`BLUR_LOD`), resolution | top of `src/ceiling.ts` |
| Ceiling brightness | `CEILING_GLOW` in `src/world.ts` |
| Footstep sound set (grass, concrete, carpet), step length, volume | top of `src/footsteps.ts` |
| Adaptive resolution budgets | `judge()` / `renderTimed()` in `src/main.ts` |

## Project structure

- `src/main.ts`: menu flow, input (mouse, keyboard, touch), adaptive resolution, render loop
- `src/world.ts`: renderer, materials, sky, lights and shadows, collision BVH
- `src/ceiling.ts`: the blurred sculpture reflection in the ceiling
- `src/player.ts`: first-person capsule controller
- `src/exhibits.ts`: trigger boxes and the sculpture tags
- `src/footsteps.ts`: stride-based footsteps via Web Audio
- `public/assets/`: generated web assets, committed so the site builds without Python
- `tools/`: the pipeline that produced those assets (see [Asset pipeline](#asset-pipeline))

## Rendering notes

The lighting was tuned against screenshots of the original build taken at known camera poses,
minimising the per-pixel difference. Columns, left to right: the original, a first untuned render,
the tuned result. The image predates the brighter ceiling.

![Original vs rebuild](docs/visual-match.jpg)

Several things in `src/world.ts` look odd but are there on purpose:

- **Gamma colour space.** Lighting runs on raw sRGB values, as it did in the original. Textures and
  colours are never decoded and the output is never encoded.
- **Square-rooted specular, 0.22 dielectric reflectance.** This is what Unity's Standard shader does
  in Gamma space, and it gives the sculptures their broad, grey brushed-metal sheen. `BRDF_GGX` is
  patched to match.
- **No environment lighting.** The sculptures only catch the suns, never the sky. That is why they
  read as dark chrome with crisp highlights.
- **Four dim fill lights as spherical harmonics.** They lift the ceiling and window sills above plain
  emission grey.
- **Walls don't block the sun** (`shadowSide = FrontSide`). The walls are single-sided and only the
  window frames throw shadows into the room.
- **The ground outside is invisible.** It exists only as collision, so you can't fall off the world.
- **HUD sizing.** The top bar scales with screen width; the tags and crosshair are a constant size in
  device pixels.

The ceiling is the one deliberate departure from the original look: it is brighter (emission 0.75
instead of 0.519) and carries the sculpture reflection.

## Asset pipeline

`public/assets/` is generated from the original Unity WebGL build. You only need to re-run this if
the source changes. It requires Python 3, Node and ffmpeg.

```bash
python3 -m venv .cache/venv && .cache/venv/bin/pip install UnityPy numpy pygltflib Pillow texture2ddecoder

# 1. un-gzip the .unityweb files and split the UnityWebData container
BUILD="path/to/exhibition10/Build"
mkdir -p .cache/raw .cache/unpacked
gzip -dc "$BUILD/exhibition10.data.unityweb" > .cache/raw/exhibition10.data
python3 -I tools/extract/unpack.py .cache/raw/exhibition10.data .cache/unpacked

# 2. scene -> merged glTF + scene.json (player, triggers, lights); textures, UI, audio, cubemap
.cache/venv/bin/python -I tools/extract/export_scene.py  .cache/unpacked/data.unity3d .cache/extract
.cache/venv/bin/python -I tools/extract/export_assets.py .cache/unpacked/data.unity3d .cache/extract

# 3. simplify, compress and convert into public/assets
node tools/build-assets.mjs
```

`tools/build-assets.mjs` welds and simplifies the sculptures (0.55M triangles), quantizes and
meshopt-compresses the geometry, converts textures and UI to WebP and the footsteps to MP3.
`tools/extract/tagmap.json` maps each trigger box to its tag image.
