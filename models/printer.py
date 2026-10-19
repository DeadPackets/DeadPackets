# Blender script: OSCAR POS88C 80 mm thermal receipt printer (140 W x 150 D x 135 H mm, matte black, paper cover hood on a lower body).
# Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P models/printer.py
# Frame: origin at the bottom centre, three.js y up, front (paper exit side) toward +z (Blender -y). Parts are named by material.
import bpy, bmesh, json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build import OUT, U, mat, rrect, prism, join

bpy.ops.wm.read_factory_settings(use_empty=True)
u = U  # all numbers below are mm
W, D, H = 140, 150, 135
LH, LW, LD = 60, 136, 148  # lower body: the hood overhangs it by 2 mm at the front and both sides, flush at the back
C = 9  # 45 degree chamfer on the hood's top front edge
SY = -D / 2 + 24  # Blender y of the paper slot centre
shell, cover, slot, tear, led, btn, push = (mat('shell', (0.035, 0.037, 0.042), 0.0, 0.42), mat('cover', (0.06, 0.063, 0.07), 0.0, 0.3), mat('slot', (0.0, 0.0, 0.0), 0.0, 0.9),
    mat('tear', (0.7, 0.72, 0.75), 1.0, 0.25), mat('led', (0.2, 1.0, 0.45)), mat('button', (0.09, 0.095, 0.105), 0.0, 0.5), mat('push', (0.42, 0.43, 0.45), 0.0, 0.6))


def loft(name, rings, material, bevel):  # rings: (z, w, d, r, cy) rounded rectangles bridged bottom to top, both ends capped
    me = bpy.data.meshes.new(name); bm = bmesh.new(); loops = []
    for z, w, d, r, cy in rings:
        loops.append([bm.verts.new((x * u, (y + cy) * u, z * u)) for x, y in rrect(w, d, r, 8)])
    for a, b in zip(loops, loops[1:]):
        for i in range(len(a)): bm.faces.new((a[i], a[i - 1], b[i - 1], b[i]))
    bm.faces.new(loops[0]); bm.faces.new(loops[-1]); bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free(); ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob); ob.data.materials.append(material)
    md = ob.modifiers.new('bevel', 'BEVEL'); md.width = bevel * u; md.segments = 3; md.limit_method = 'ANGLE'; md.angle_limit = math.radians(40)
    ob.modifiers.new('wn', 'WEIGHTED_NORMAL').keep_sharp = True
    for p in ob.data.polygons: p.use_smooth = True
    return ob


def box(name, w, d, r, z0, z1, material, x, y, bevel=0.0):  # mm wrapper around prism
    return prism(name, rrect(w * u, d * u, r * u, 4), z0 * u, z1 * u, material, bevel * u, 2, at=(x * u, y * u))


def side(name, w, d, r, t, material, x, y, z):  # plate on the +x side face: w along z, d along y, t sticks out
    ob = box(name, w, d, r, -0.4, t, material, 0, 0); ob.rotation_euler = (0, math.radians(90), 0); ob.location = (x * u, y * u, z * u); return ob


loft('shell', [(0, LW, LD, 10, 1), (LH, LW, LD, 10, 1)], shell, 2.5)
box('slot', LW - 3, LD - 3, 9, LH - 0.5, LH + 2, slot, 0, 1)  # dark seam under the hood lip
loft('cover', [(LH + 2, W, D, 11, 0), (H - C, W, D, 11, 0), (H, W, D - C, 11, C / 2)], cover, 2)
# front grille, lower left: ~40 dark discs in a rounded rectangle (9 x 5 grid, corners dropped)
holes = []
for i in range(9):
    for j in range(5):
        if i in (0, 8) and j in (0, 4): continue
        h = box('slot', 2.6, 2.6, 1.3, 0, 0.5, slot, 0, 0); h.rotation_euler = (math.radians(90), 0, 0)
        h.location = ((-40 + (i - 4) * 4.6) * u, (-LD / 2 + 1 + 0.3) * u, (24 + (j - 2) * 4.6) * u); holes.append(h)
join(holes, 'slot')
# top: recessed paper slot, serrated tear bar on its front lip
box('slot', 90, 5, 1.2, H - 1, H + 0.06, slot, 0, SY)
teeth, n, tw = [], 40, 84 / 40
for k in range(n):
    teeth += [(-42 + k * tw, -1.2), (-42 + (k + 0.5) * tw, 0.6)]
pts = [(x * u, y * u) for x, y in [(-42, -1.6)] + teeth[1:] + [(42, -1.2), (42, -1.6)]]
tb = prism('tear', pts, (H - 0.2) * u, (H + 1.4) * u, tear); tb.location = (0, (SY - 3.4) * u, 0)
# top left: grey PUSH cover release in a dark recess, round feed button with an arrow icon, three LED slits at the rear
box('slot', 25, 14, 2.5, H - 0.5, H + 0.05, slot, -42, -18)
box('push', 23, 12, 2, H - 0.5, H + 0.12, push, -42, -18, 0.4)
box('slot', 12, 12, 6, H - 0.5, H + 0.05, slot, -20, -18)
box('push', 10.4, 10.4, 5.2, H - 0.5, H + 0.5, push, -20, -18, 0.6)
prism('slot', [(-1.8 * u, -1.6 * u), (1.8 * u, -1.6 * u), (0, 1.8 * u)], (H + 0.4) * u, (H + 0.56) * u, slot, at=(-20 * u, -18 * u))
for k, m in enumerate((led, slot, slot)):  # POWER lit, ERROR and PAPER dark
    box(m.name, 7, 1.8, 0.9, H - 0.5, H + 0.08, m, -54 + k * 11, D / 2 - 12)
# right side: vertical panel split line, rocker power switch low at the rear
side('slot', LH - 6, 0.6, 0.3, 0.1, slot, LW / 2, 18, LH / 2)
side('slot', H - LH - C - 6, 0.6, 0.3, 0.1, slot, W / 2, 18, (LH + H - C) / 2)
side('slot', 16, 10, 1.5, 0.12, slot, LW / 2, D / 2 - 18, 18)
side('button', 13.5, 7.5, 1.2, 2.2, btn, LW / 2, D / 2 - 18, 18).rotation_euler = (math.radians(8), math.radians(90), 0)

path = os.path.join(OUT, 'printer.glb')
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_apply=True, export_yup=True, export_normals=True, export_texcoords=True, export_materials='EXPORT', export_extras=False)
json.dump(dict(W=W * u, D=D * u, H=H * u, slot=dict(y=H * u, z=-SY * u, w=80 * u)), open(os.path.join(OUT, 'printer.json'), 'w'), separators=(',', ':'))
print('printer', os.path.getsize(path) // 1024, 'KB')
