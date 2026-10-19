# Blender script: builds both laptops from published dimensions and exports one GLB + key layout JSON each.
# Run: /Applications/Blender.app/Contents/MacOS/Blender -b -P models/build.py
# Frames match app.js: root = hinge axis (three.js y up, base toward -z); lid parts are named lid_* and live in the
# lid's own frame (centre origin, sticker face at z = 0, screen toward -z). Blender (x, y, z) = three.js (x, -z, y).
import bpy, bmesh, json, math, os
from mathutils import Vector

OUT = os.path.dirname(os.path.abspath(__file__))
U = 3.4 / 356.7  # world units per mm: the old lid keeps app.js's 3.4-unit width

SPECS = {
    'macbook-pro-16': dict(  # Apple MacBook Pro 16" (2021+), Space Black
        W=355.7, D=248.1, lid_t=5.6, base_t=11.2, r=11.0, lid_r=11.0, edge=1.6,
        bezel=dict(side=5.4, top=6.2, bottom=17.0), notch=(31.0, 7.6),
        pitch=18.6, cap=16.2, kb_top=14.0, numpad=False, well=True,
        pad=(160.0, 100.0, 0.0, 9.0),  # w, h, x offset, gap from the front edge (mm)
        grilles=True, hinge=(0.86, 4.6, 3.8)),  # width share, height, depth (mm)
    'matebook-d16': dict(  # HUAWEI MateBook D16 (2022), Space Grey
        W=356.7, D=248.0, lid_t=6.2, base_t=12.2, r=7.5, lid_r=7.5, edge=1.2,
        bezel=dict(side=6.0, top=7.5, bottom=24.0), notch=None,
        pitch=17.4, cap=15.6, kb_top=18.0, numpad=True, well=False,
        pad=(120.0, 76.0, -36.0, 12.0),
        grilles=False, hinge=(0.80, 5.4, 4.2)),
}

ANSI = [  # (label, width in keys); 'gap' = empty space
    [('esc', 1.5)] + [(f'F{i}', 1) for i in range(1, 13)] + [('', 1)],
    [('`', 1), ('1', 1), ('2', 1), ('3', 1), ('4', 1), ('5', 1), ('6', 1), ('7', 1), ('8', 1), ('9', 1), ('0', 1), ('-', 1), ('=', 1), ('delete', 1.5)],
    [('tab', 1.5), ('Q', 1), ('W', 1), ('E', 1), ('R', 1), ('T', 1), ('Y', 1), ('U', 1), ('I', 1), ('O', 1), ('P', 1), ('[', 1), (']', 1), ('\\', 1)],
    [('caps', 1.8), ('A', 1), ('S', 1), ('D', 1), ('F', 1), ('G', 1), ('H', 1), ('J', 1), ('K', 1), ('L', 1), (';', 1), ("'", 1), ('return', 1.7)],
    [('shift', 2.3), ('Z', 1), ('X', 1), ('C', 1), ('V', 1), ('B', 1), ('N', 1), ('M', 1), (',', 1), ('.', 1), ('/', 1), ('shift', 2.2)],
    [('fn', 1), ('ctrl', 1), ('opt', 1), ('cmd', 1.25), ('', 5.0), ('cmd', 1.25), ('opt', 1), ('ARROWS', 3)],
]
NUMPAD = [[('num', 1), ('/', 1), ('*', 1), ('-', 1)], [('7', 1), ('8', 1), ('9', 1), ('+', 1)], [('4', 1), ('5', 1), ('6', 1), ('', 1)], [('1', 1), ('2', 1), ('3', 1), ('enter', 1)], [('0', 2), ('.', 1), ('', 1)]]


def mat(name, rgb, metal=0.0, rough=0.5):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True; b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1); b.inputs['Metallic'].default_value = metal; b.inputs['Roughness'].default_value = rough
    return m


def rrect(w, d, r, seg=12):  # rounded rectangle outline in Blender XY, centred
    r = min(r, w / 2 - 1e-4, d / 2 - 1e-4); pts = []
    for cx, cy, a0 in ((w / 2 - r, d / 2 - r, 0), (-w / 2 + r, d / 2 - r, 90), (-w / 2 + r, -d / 2 + r, 180), (w / 2 - r, -d / 2 + r, 270)):
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg); pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def prism(name, pts, z0, z1, material, bevel=0.0, bseg=3, at=(0, 0)):
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    vs = [bm.verts.new((x + at[0], y + at[1], z0)) for x, y in pts]; f = bm.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(bm, geom=[f]); top = [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=top, vec=(0, 0, z1 - z0)); bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free(); ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    ob.data.materials.append(material)
    if bevel > 0:  # only the 90 degree rims: the rounded corners are already many shallow faces
        md = ob.modifiers.new('bevel', 'BEVEL'); md.width = bevel; md.segments = bseg; md.limit_method = 'ANGLE'; md.angle_limit = math.radians(40)
    ob.modifiers.new('wn', 'WEIGHTED_NORMAL').keep_sharp = True
    for p in ob.data.polygons: p.use_smooth = True
    return ob


def join(obs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs: o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]; bpy.ops.object.convert(target='MESH'); bpy.ops.object.join(); obs[0].name = name; return obs[0]


def build(key, S):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    alu, black, keycap, glass, pad, port, grille, chamfer = (mat('alu', (0.5, 0.5, 0.5), 0.7, 0.35), mat('black', (0.02, 0.02, 0.022), 0.3, 0.5), mat('key', (0.03, 0.03, 0.035), 0, 0.6),
        mat('glass', (0.01, 0.01, 0.012), 0, 0.08), mat('trackpad', (0.5, 0.5, 0.5), 0.4, 0.3), mat('port', (0.005, 0.005, 0.005), 0, 0.8), mat('grille', (0.5, 0.5, 0.5), 0.7, 0.4), mat('chamfer', (0.8, 0.8, 0.8), 1, 0.12))
    W, D, H = S['W'] * U, S['D'] * U, S['D'] * U  # lid height == base depth on both machines
    lt, bt = S['lid_t'] * U, S['base_t'] * U
    # ---- lid (lid frame: centre origin; sticker face z=0 -> Blender y=0; screen side toward Blender +y) ----
    shell = prism('lid_shell', rrect(W, H, S['lid_r'] * U, 16), -lt, 0, alu, S['edge'] * U, 4)
    shell.rotation_euler = (math.radians(90), 0, 0)  # Rx(90): Blender z -> -y, so the lid body ends up on the screen side (three -z)
    b = S['bezel']; dw, dh = W - 2 * b['side'] * U, H - (b['top'] + b['bottom']) * U; dcy = (b['bottom'] - b['top']) / 2 * U
    gl = prism('lid_glass', rrect(W - 1.2 * U, H - 1.2 * U, (S['lid_r'] - 0.6) * U, 16), -lt - 0.15 * U, -lt, glass)
    gl.rotation_euler = (math.radians(90), 0, 0)
    disp = prism('lid_display', rrect(dw, dh, 1.5 * U, 4), -lt - 0.16 * U, -lt - 0.15 * U, glass, at=(0, dcy))
    disp.rotation_euler = (math.radians(90), 0, 0)
    parts = [shell, gl, disp]
    if S['notch']:
        nw, nh = S['notch'][0] * U, S['notch'][1] * U
        n = prism('lid_notch', rrect(nw, nh, 2.2 * U, 6), -lt - 0.3 * U, -lt - 0.16 * U, glass, at=(0, dcy + dh / 2 - nh / 2 + 0.01 * U)); n.rotation_euler = (math.radians(90), 0, 0); parts.append(n)
    if key == 'matebook-d16':  # diamond-cut lid rim catches the light
        c = prism('lid_rim', rrect(W + 0.2 * U, H + 0.2 * U, S['lid_r'] * U + 0.1 * U, 16), -lt * 0.55, -lt * 0.15, chamfer); c.rotation_euler = (math.radians(90), 0, 0); parts.append(c)
    # ---- base (root frame: hinge axis at origin; base top at three y = -(lt + gap); base toward three -z = Blender +y) ----
    gap = 0.6 * U; top = -(lt + gap); y0 = 1.2 * U  # back edge just behind the hinge axis
    base = prism('base', rrect(W, D, S['r'] * U, 16), top - bt, top, alu, S['edge'] * U, 4, at=(0, -y0 + D / 2))
    # keyboard
    keys, legend = [], []
    rows = [r[:] for r in ANSI]; p, cap = S['pitch'] * U, S['cap'] * U
    cols_main = max(sum(w for _, w in r) for r in rows); cols = cols_main + (4.6 if S['numpad'] else 0)
    kb_w = cols * p; x_left = -kb_w / 2; y_top = -y0 + S['kb_top'] * U + (S['hinge'][2] * U)
    for ri, row in enumerate(rows):
        x = x_left; hgt = 0.62 if ri == 0 else 1.0; yc = y_top + (0.31 * p if ri == 0 else (0.62 + ri - 0.5) * p)
        for lab, w in row:
            if lab == 'ARROWS':  # inverted T, half-height up/down
                for dx, dy, hh, l in ((0, 0.25, 0.48, '◀'), (1, 0.0, 0.48, '▲'), (1, 0.5, 0.48, '▼'), (2, 0.25, 0.48, '▶')):
                    kh = (0.48 if l in '▲▼' else 0.48) * p - (p - cap) * 0.5; kx = x + (dx + 0.5) * p
                    ky = yc - 0.25 * p + dy * p if l in '▲▼' else yc + 0.25 * p
                    keys.append(prism('k', rrect(cap, kh, 1.6 * U, 3), top, top + 0.7 * U, keycap, 0.35 * U, 2, at=(kx, ky))); legend.append((l, kx, ky, cap, kh))
                x += 3 * p; continue
            kw, kh = w * p - (p - cap), hgt * p - (p - cap); kx = x + w * p / 2
            if lab or w <= 1.5 or ri == 5:
                keys.append(prism('k', rrect(kw, kh, 1.8 * U, 3), top, top + 0.7 * U, keycap, 0.35 * U, 2, at=(kx, yc)))
                legend.append((lab, kx, yc, kw, kh))
            x += w * p
    if S['numpad']:
        for ri, row in enumerate(NUMPAD):
            x = x_left + (cols_main + 0.6) * p; yc = y_top + (0.62 + ri + 1 - 0.5) * p
            for lab, w in row:
                kw, kh = w * p - (p - cap), p - (p - cap); kx = x + w * p / 2
                keys.append(prism('k', rrect(kw, kh, 1.8 * U, 3), top, top + 0.7 * U, keycap, 0.35 * U, 2, at=(kx, yc))); legend.append((lab, kx, yc, kw, kh)); x += w * p
    kb = join(keys, 'keys')
    me = kb.data; uv = me.uv_layers.new(name='UVMap'); kx0, kx1 = x_left - p * 0.2, x_left + kb_w + p * 0.2; ky0, ky1 = y_top - p * 0.2, y_top + 6.2 * p
    for loop in me.loops:  # top-down projection: the legend canvas in app.js uses the same box
        v = me.vertices[loop.vertex_index].co; uv.data[loop.index].uv = ((v.x - kx0) / (kx1 - kx0), 1 - (v.y - ky0) / (ky1 - ky0))
    out = [base, kb]
    if S['well']:
        out.append(prism('well', rrect(kb_w + 4 * U, ky1 - ky0 + 2 * U, 3 * U, 6), top, top + 0.05 * U, black, at=(0, (ky0 + ky1) / 2)))
    pw, ph, pxo, pgap = (v * U for v in S['pad'])
    out.append(prism('trackpad', rrect(pw, ph, 6 * U, 8), top, top + 0.08 * U, pad, 0.25 * U, 2, at=(pxo, -y0 + D - pgap - ph / 2)))
    if S['grilles']:
        gw = (W - kb_w) / 2 - 9 * U
        for sgn in (-1, 1):
            g = prism('grille', rrect(gw, ky1 - ky0, 2 * U, 4), top, top + 0.02 * U, grille, at=(sgn * (kb_w / 2 + 4.5 * U + gw / 2), (ky0 + ky1) / 2)); out.append(g)
    for sgn in (-1, 1):  # side ports, a few dark slots each
        for i in range(3):
            sl = prism('port', rrect(2.2 * U, 9 * U, 1.0 * U, 3), -1.2 * U, 1.2 * U, port, at=(0, 0))
            sl.rotation_euler = (0, math.radians(90), 0); sl.location = (sgn * (W / 2 - 1.15 * U), -y0 + D * (0.28 + 0.13 * i), top - bt / 2); out.append(sl)
    hw, hh, hd = S['hinge'][0] * W, S['hinge'][1] * U, S['hinge'][2] * U  # flat hinge cover, not a barrel
    out.append(prism('hinge', rrect(hw, hd, hd * 0.45, 6), top - 0.2 * U, top + hh, black, hd * 0.3, 3, at=(0, -y0 + hd / 2 - 0.4 * U)))
    # name parts by material so app.js can swap in its own materials
    path = os.path.join(OUT, key + '.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_apply=True, export_yup=True, export_normals=True, export_texcoords=True, export_materials='EXPORT', export_extras=False)
    info = dict(W=W, H=H, D=D, lid_t=lt, base_top=top, display=dict(w=dw, h=dh, cy=dcy),
                keys=dict(box=[kx0, ky0, kx1, ky1], list=[dict(l=l, x=x, y=y, w=w, h=h) for l, x, y, w, h in legend]))
    json.dump(info, open(os.path.join(OUT, key + '.json'), 'w'), separators=(',', ':'))
    print(key, 'tris', sum(len(o.data.polygons) for o in bpy.data.objects if o.type == 'MESH'), os.path.getsize(path) // 1024, 'KB')


if __name__ == '__main__':  # printer.py imports the helpers without rebuilding the laptops
    for k, s in SPECS.items(): build(k, s)
