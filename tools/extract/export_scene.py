"""Export the Unity 'level1' exhibition scene into a merged glTF + scene.json.

Unity is left-handed (+Z forward); glTF is right-handed. We convert by
negating X on positions/normals and reversing triangle winding.
"""
import UnityPy, sys, struct, json, os, math
import numpy as np
from UnityPy.helpers.MeshHelper import MeshHandler
import pygltflib as G

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
env = UnityPy.load(SRC)
files = list(env.files.values())[0].files
lvl = files['level1']
shared = files['sharedassets1.assets']
ext = [e.path.split('/')[-1] for e in lvl.externals]


def resolve(pptr):
    fid, pid = pptr['m_FileID'], pptr['m_PathID']
    if pid == 0:
        return None
    if fid == 0:
        return lvl.objects.get(pid)
    name = ext[fid - 1]
    for k, f in files.items():
        if k.endswith(name) and hasattr(f, 'objects'):
            return f.objects.get(pid)
    # unity default resources lives outside the bundle
    for k, f in env.files.items():
        if 'unity_default_resources' in k and hasattr(f, 'objects'):
            return f.objects.get(pid)
    return None


# ---------- transforms ----------
TR = {}
for pid, o in lvl.objects.items():
    if o.type.name in ('Transform', 'RectTransform'):
        TR[pid] = o.read_typetree()
GO_TR = {t['m_GameObject']['m_PathID']: pid for pid, t in TR.items()}


def local_matrix(t):
    p, r, s = t['m_LocalPosition'], t['m_LocalRotation'], t['m_LocalScale']
    x, y, z, w = r['x'], r['y'], r['z'], r['w']
    R = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4)
    M[:3, :3] = R @ np.diag([s['x'], s['y'], s['z']])
    M[:3, 3] = [p['x'], p['y'], p['z']]
    return M


def world_matrix(tr_pid):
    M = np.eye(4)
    cur = tr_pid
    while cur:
        t = TR[cur]
        M = local_matrix(t) @ M
        cur = t['m_Father']['m_PathID']
    return M


def active_in_hierarchy(tr_pid):
    cur = tr_pid
    while cur:
        go = lvl.objects[TR[cur]['m_GameObject']['m_PathID']].read_typetree()
        if not go['m_IsActive']:
            return False
        cur = TR[cur]['m_Father']['m_PathID']
    return True


def go_name(go_pid):
    return lvl.objects[go_pid].read_typetree()['m_Name']


def path_name(tr_pid):
    names = []
    cur = tr_pid
    while cur:
        names.append(go_name(TR[cur]['m_GameObject']['m_PathID']))
        cur = TR[cur]['m_Father']['m_PathID']
    return '/'.join(reversed(names))


C = np.diag([-1.0, 1.0, 1.0])  # unity -> gltf basis flip

# ---------- meshes ----------
mesh_cache = {}


def load_mesh(obj):
    key = (id(obj.assets_file), obj.path_id)
    if key in mesh_cache:
        return mesh_cache[key]
    m = obj.read()
    h = MeshHandler(m)
    h.process()
    pos = np.array(h.m_Vertices, dtype=np.float64)
    nrm = np.array(h.m_Normals, dtype=np.float64) if h.m_Normals else None
    uv = np.array(h.m_UV0, dtype=np.float64) if h.m_UV0 else None
    subs = [np.array(tris, dtype=np.int64).reshape(-1, 3) for tris in h.get_triangles()]
    res = dict(name=m.m_Name, pos=pos, nrm=nrm, uv=uv, subs=subs)
    mesh_cache[key] = res
    return res


def builtin_mesh(name):
    if name == 'Plane':  # Unity's 10x10 plane, facing +Y
        pos = np.array([[-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5]], float)
        return dict(name='Plane', pos=pos, nrm=np.tile([0, 1, 0], (4, 1)).astype(float),
                    uv=np.array([[1, 1], [0, 1], [0, 0], [1, 0]], float),
                    subs=[np.array([[0, 2, 1], [0, 3, 2]])])
    raise KeyError(name)


# ---------- gather renderers ----------
groups = {}      # material name -> lists
collision = []   # (pos, tris)
stats = dict(renderers=0, skipped=0)

renderer_by_go = {}
filter_by_go = {}
colliders_by_go = {}
for pid, o in lvl.objects.items():
    tn = o.type.name
    if tn in ('MeshRenderer', 'MeshFilter', 'MeshCollider', 'BoxCollider'):
        t = o.read_typetree()
        g = t['m_GameObject']['m_PathID']
        if tn == 'MeshRenderer':
            renderer_by_go[g] = t
        elif tn == 'MeshFilter':
            filter_by_go[g] = t
        else:
            colliders_by_go.setdefault(g, []).append((tn, t))


def get_mesh_for(pptr):
    obj = resolve(pptr)
    if obj is None:
        return None
    if obj.type.name != 'Mesh':
        return None
    try:
        return load_mesh(obj)
    except Exception as e:
        nm = obj.read().m_Name
        return builtin_mesh(nm)


def mat_name(pptr):
    o = resolve(pptr)
    return o.read().m_Name if o else None


def transform_mesh(mesh, M, sub_ids=None):
    pos = mesh['pos']
    P = (M[:3, :3] @ pos.T).T + M[:3, 3]
    P = (C @ P.T).T
    N = None
    if mesh['nrm'] is not None and len(mesh['nrm']) == len(pos):
        nm = np.linalg.inv(M[:3, :3]).T
        N = (nm @ mesh['nrm'].T).T
        N = (C @ N.T).T
        ln = np.linalg.norm(N, axis=1, keepdims=True)
        ln[ln == 0] = 1
        N = N / ln
    UV = None
    if mesh['uv'] is not None and len(mesh['uv']) == len(pos):
        UV = mesh['uv'].copy()
        UV[:, 1] = 1.0 - UV[:, 1]
    flip = np.linalg.det(M[:3, :3]) < 0
    return P, N, UV, flip


triggers = []
for go_pid, rend in renderer_by_go.items():
    tr = GO_TR[go_pid]
    name = go_name(go_pid)
    if go_pid in colliders_by_go and any(t['m_IsTrigger'] for tn, t in colliders_by_go[go_pid] if tn == 'BoxCollider'):
        continue  # trigger volumes are invisible; handled separately
    if not rend['m_Enabled'] or not active_in_hierarchy(tr) or go_pid not in filter_by_go:
        stats['skipped'] += 1
        continue
    mesh = get_mesh_for(filter_by_go[go_pid]['m_Mesh'])
    if mesh is None:
        stats['skipped'] += 1
        continue
    M = world_matrix(tr)
    P, N, UV, flip = transform_mesh(mesh, M)
    mats = [mat_name(m) for m in rend['m_Materials']]
    pth = path_name(tr)
    category = 'sculpture' if pth.startswith('Sculptures/') else ('outside' if pth.startswith('Outside/') else 'building')
    for si, tris in enumerate(mesh['subs']):
        if len(tris) == 0:
            continue
        mname = mats[min(si, len(mats) - 1)] if mats else 'default'
        T = tris[:, ::-1] if not flip else tris  # basis flip reverses winding
        key = (mname, category)
        groups.setdefault(key, []).append((P, N, UV, T))
    stats['renderers'] += 1

# colliders: every enabled MeshCollider (non-trigger)
for go_pid, cols in colliders_by_go.items():
    tr = GO_TR[go_pid]
    if not active_in_hierarchy(tr):
        continue
    for tn, t in cols:
        if not t['m_Enabled'] or t['m_IsTrigger']:
            continue
        if tn == 'MeshCollider':
            mesh = get_mesh_for(t['m_Mesh'])
            if mesh is None:
                continue
            M = world_matrix(tr)
            P, _, _, flip = transform_mesh(mesh, M)
            tris = np.concatenate([s for s in mesh['subs'] if len(s)]) if mesh['subs'] else None
            if tris is None:
                continue
            cat = 'sculpture' if path_name(tr).startswith('Sculptures/') else 'building'
            collision.append((cat, P, tris if flip else tris[:, ::-1]))

# triggers -> tag sprites (resolved earlier via UIAppear.customImage)
tagmap = json.load(open(os.path.join(os.path.dirname(__file__), 'tagmap.json')))
for go_pid, cols in colliders_by_go.items():
    for tn, t in cols:
        if tn == 'BoxCollider' and t['m_IsTrigger']:
            name = go_name(go_pid).strip()
            M = world_matrix(GO_TR[go_pid])
            c, s = t['m_Center'], t['m_Size']
            # 8 corners of the box in world space -> keep as an oriented box
            center = M[:3, :3] @ np.array([c['x'], c['y'], c['z']]) + M[:3, 3]
            axes = M[:3, :3] @ np.diag([s['x'], s['y'], s['z']])  # columns = full extents
            center = C @ center
            axes = C @ axes
            triggers.append(dict(name=name, tag=tagmap[name][1], center=center.round(4).tolist(),
                                 axes=axes.T.round(4).tolist()))

# player
player = None
for pid, o in lvl.objects.items():
    if o.type.name == 'Camera':
        t = o.read_typetree()
        tr = GO_TR[t['m_GameObject']['m_PathID']]
        if active_in_hierarchy(tr):
            M = world_matrix(tr)
            # FirstPersonAIO resets the camera's local yaw on Start and steers the body instead,
            # so the visitor faces the root (body) forward, not the camera's saved yaw.
            # (Verified against the running original build.)
            root = tr
            while TR[root]['m_Father']['m_PathID']:
                root = TR[root]['m_Father']['m_PathID']
            R = world_matrix(root)
            fwd = C @ (R[:3, :3] @ np.array([0, 0, 1.0]))
            fwd[1] = 0
            fwd /= np.linalg.norm(fwd)
            pos = C @ M[:3, 3]
            player = dict(eye=pos.round(4).tolist(), forward=fwd.round(4).tolist(), fov=t['field of view'],
                          near=t['near clip plane'], far=t['far clip plane'])

# lights
lights = []
for pid, o in lvl.objects.items():
    if o.type.name == 'Light':
        t = o.read_typetree()
        tr = GO_TR[t['m_GameObject']['m_PathID']]
        if not t['m_Enabled'] or not active_in_hierarchy(tr):
            continue
        M = world_matrix(tr)
        d = C @ (M[:3, :3] @ np.array([0, 0, 1.0]))
        d = d / np.linalg.norm(d)
        col = t['m_Color']
        lights.append(dict(type=t['m_Type'], dir=d.round(4).tolist(), color=[col['r'], col['g'], col['b']],
                           intensity=t['m_Intensity'], shadows=t['m_Shadows']['m_Type'], bake=t['m_Lightmapping']))

# ---------- write glb ----------
gl = G.GLTF2(asset=G.Asset(generator='disruptive-type unity export'))
gl.scenes = [G.Scene(nodes=[])]
gl.scene = 0
blob = bytearray()


def add_view(arr, target=None):
    global blob
    while len(blob) % 4:
        blob += b'\0'
    off = len(blob)
    b = arr.tobytes()
    blob += b
    gl.bufferViews.append(G.BufferView(buffer=0, byteOffset=off, byteLength=len(b), target=target))
    return len(gl.bufferViews) - 1


def add_accessor(arr, ctype, typ, target, minmax=False):
    v = add_view(arr, target)
    acc = G.Accessor(bufferView=v, componentType=ctype, count=len(arr), type=typ)
    if minmax:
        acc.min = arr.min(axis=0).tolist()
        acc.max = arr.max(axis=0).tolist()
    gl.accessors.append(acc)
    return len(gl.accessors) - 1


mat_index = {}


def material(name):
    if name in mat_index:
        return mat_index[name]
    gl.materials.append(G.Material(name=name))
    mat_index[name] = len(gl.materials) - 1
    return mat_index[name]


def add_mesh_node(node_name, parts, mat=None, with_attrs=True):
    Ps, Ns, UVs, Is = [], [], [], []
    base = 0
    for P, N, UV, T in parts:
        Ps.append(P)
        if with_attrs:
            Ns.append(N if N is not None else np.tile([0, 1, 0], (len(P), 1)))
            UVs.append(UV if UV is not None else np.zeros((len(P), 2)))
        Is.append(T + base)
        base += len(P)
    P = np.concatenate(Ps).astype(np.float32)
    I = np.concatenate(Is).astype(np.uint32).reshape(-1)
    attrs = G.Attributes(POSITION=add_accessor(P, G.FLOAT, G.VEC3, G.ARRAY_BUFFER, True))
    if with_attrs:
        attrs.NORMAL = add_accessor(np.concatenate(Ns).astype(np.float32), G.FLOAT, G.VEC3, G.ARRAY_BUFFER)
        attrs.TEXCOORD_0 = add_accessor(np.concatenate(UVs).astype(np.float32), G.FLOAT, G.VEC2, G.ARRAY_BUFFER)
    prim = G.Primitive(attributes=attrs, indices=add_accessor(I, G.UNSIGNED_INT, G.SCALAR, G.ELEMENT_ARRAY_BUFFER))
    if mat is not None:
        prim.material = material(mat)
    gl.meshes.append(G.Mesh(name=node_name, primitives=[prim]))
    gl.nodes.append(G.Node(name=node_name, mesh=len(gl.meshes) - 1))
    gl.scenes[0].nodes.append(len(gl.nodes) - 1)
    return len(P), len(I) // 3


summary = {}
for (mname, cat), parts in sorted(groups.items()):
    nm = f'{cat}__{mname}'
    v, t = add_mesh_node(nm, parts, mname)
    summary[nm] = dict(parts=len(parts), verts=v, tris=t)

for cat in ('building', 'sculpture'):
    parts = [(P, None, None, T) for c, P, T in collision if c == cat]
    cv, ct = add_mesh_node(f'collision__{cat}', parts, None, with_attrs=False)
    summary[f'collision__{cat}'] = dict(parts=len(parts), verts=cv, tris=ct)

gl.buffers = [G.Buffer(byteLength=len(blob))]
gl.set_binary_blob(bytes(blob))
gl.save_binary(os.path.join(OUT, 'exhibition.raw.glb'))

json.dump(dict(player=player, triggers=sorted(triggers, key=lambda x: x['name']), lights=lights),
          open(os.path.join(OUT, 'scene.json'), 'w'), indent=1)
print(json.dumps(stats))
for k, v in summary.items():
    print(k, v)
print('triggers', len(triggers), 'lights', len(lights), 'player', player)
