# Polished pictures of a model, made with Blender (Stage 9.6b). Run only headless, with factory settings, by the gateway:
#   blender --background --factory-startup --python-exit-code 1 --python render/blender_render.py -- <job.json>
# The job names the model's GLB and its JSON (materials, grain, how it pulls apart, sizes), the shots to make, the
# backdrop, the size, and where everything goes. This script builds the scene from those files only: proper timber with
# its grain along each part's grain direction (rings round that axis, so long faces show long grain and ends show end
# grain), a soft studio backdrop that curves up behind, three soft lights, a slightly long lens framed to the model, and
# a filmic look. It never touches the owner's own Blender set-up: nothing is saved but the files the job asks for.
# Prints "PROGRESS i/n shot", "TIME shot seconds" and "SAVED kind path" lines for the gateway to read.
import bpy
import json
import math
import os
import sys
import time
from mathutils import Matrix, Vector
from bpy_extras.object_utils import world_to_camera_view

job = json.load(open(sys.argv[sys.argv.index("--") + 1], encoding="utf-8"))
model = json.load(open(job["model"], encoding="utf-8"))
OUT = job["out_dir"]
os.makedirs(OUT, exist_ok=True)


def log(*a):
    print(*a, flush=True)


bpy.context.preferences.use_preferences_save = False  # factory settings stay in memory; nothing of Blender's is saved

# ---------------------------------------------------------------- the scene, empty
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.use_preferences_save = False
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"

# ---------------------------------------------------------------- the model
bpy.ops.import_scene.gltf(filepath=job["glb"])
info = {p["id"]: p for p in model["parts"]}
objs = {}
for ob in list(scene.objects):
    if ob.type == "MESH" and ob.get("part_id") in info:
        objs[ob["part_id"]] = ob
for ob in list(scene.objects):  # anything else the importer made (an empty root) goes
    if ob.type != "MESH":
        bpy.data.objects.remove(ob, do_unlink=True)
for pid, ob in objs.items():
    ob.name = info[pid]["name"]
    ob.data.name = info[pid]["name"]
home = {pid: ob.matrix_world.copy() for pid, ob in objs.items()}


def seeded(s):
    h = 2166136261
    for ch in s:
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    def rnd():
        nonlocal h
        h = (h * 1103515245 + 12345) & 0xFFFFFFFF
        return h / 4294967296
    return rnd


# ---------------------------------------------------------------- materials, made here from the JSON
def lin(hexcol):
    """A colour as it looks on screen (sRGB hex) in the linear values Blender's shaders use."""
    out = []
    for i in (1, 3, 5):
        c = int(hexcol[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


# early wood, late wood (as they look), ring spacing in metres, roughness
WOOD = {
    "pine": ("#D9B57C", "#A8743C", 0.0055, 0.6),
    "hardwood": ("#93603F", "#5E3720", 0.0042, 0.5),
    "oak": ("#C29B68", "#8A6036", 0.0048, 0.55),
    "walnut": ("#7A5338", "#43291A", 0.0045, 0.5),
    "birch": ("#E2CDA3", "#C9AC7E", 0.007, 0.6),
}
AXIS = {"x": 0, "y": 1, "z": 2}


def node(nt, kind, x, y, **props):
    n = nt.nodes.new(kind)
    n.location = (x, y)
    for k, v in props.items():
        setattr(n, k, v)
    return n


def principled(nt, rough):
    out = node(nt, "ShaderNodeOutputMaterial", 1100, 0)
    bsdf = node(nt, "ShaderNodeBsdfPrincipled", 800, 0)
    bsdf.inputs["Roughness"].default_value = rough
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    # edges caught by the light, as a real sanded arris is: a shading bevel only, the shape is untouched
    bev = node(nt, "ShaderNodeBevel", 500, -400)
    bev.inputs["Radius"].default_value = 0.0007
    return bsdf, bev


def math_node(nt, op, x, y, a=None, b=None):
    n = node(nt, "ShaderNodeMath", x, y, operation=op)
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def timber(name, kind, grain, pith, tint):
    """Growth rings round the grain axis, centred on the pith (off the board, as in a sawn board): long faces show long
    grain, ends show the rings. The rings wander slowly along the length and a little across, fibres run with the grain."""
    early, late, ring, rough = WOOD[kind]
    e, l = lin(early), lin(late)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    bsdf, bev = principled(nt, rough)
    g = AXIS[grain]
    oa, ob = [i for i in range(3) if i != g]
    tc = node(nt, "ShaderNodeTexCoord", -1800, 0)
    sep = node(nt, "ShaderNodeSeparateXYZ", -1600, 200)
    nt.links.new(tc.outputs["Object"], sep.inputs["Vector"])
    da = math_node(nt, "SUBTRACT", -1400, 300, sep.outputs["XYZ"[oa]], pith[oa])
    db = math_node(nt, "SUBTRACT", -1400, 150, sep.outputs["XYZ"[ob]], pith[ob])
    r = math_node(nt, "SQRT", -1050, 250, math_node(nt, "ADD", -1200, 250, math_node(nt, "POWER", -1300, 300, da, 2.0), math_node(nt, "POWER", -1300, 150, db, 2.0)))
    # the wander: slow along the grain, a little across it
    mp = node(nt, "ShaderNodeMapping", -1600, -200)
    sc = [55.0, 55.0, 55.0]
    sc[g] = 2.2
    mp.inputs["Scale"].default_value = tuple(sc)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    wn = node(nt, "ShaderNodeTexNoise", -1400, -200)
    wn.inputs["Scale"].default_value = 1.0
    wn.inputs["Detail"].default_value = 3.0
    wn.inputs["Roughness"].default_value = 0.55
    nt.links.new(mp.outputs["Vector"], wn.inputs["Vector"])
    wobble = math_node(nt, "MULTIPLY", -1200, -200, math_node(nt, "SUBTRACT", -1300, -200, wn.outputs["Fac"], 0.5), 1.8)
    # rings of different widths: a slow noise of the distance itself
    rc = node(nt, "ShaderNodeCombineXYZ", -1000, 450)
    nt.links.new(math_node(nt, "DIVIDE", -1100, 450, r, ring * 7), rc.inputs["X"])
    rn = node(nt, "ShaderNodeTexNoise", -850, 450)
    rn.inputs["Scale"].default_value = 1.0
    rn.inputs["Detail"].default_value = 1.0
    nt.links.new(rc.outputs["Vector"], rn.inputs["Vector"])
    widths = math_node(nt, "MULTIPLY", -700, 450, math_node(nt, "SUBTRACT", -750, 450, rn.outputs["Fac"], 0.5), 2.6)
    rings = math_node(nt, "ADD", -900, 100, math_node(nt, "ADD", -950, 250, math_node(nt, "DIVIDE", -1000, 250, r, ring), widths), wobble)
    f = math_node(nt, "FRACT", -800, 100, rings)
    ramp = node(nt, "ShaderNodeValToRGB", -650, 100)
    cr = ramp.color_ramp
    cr.interpolation = "EASE"
    cr.elements[0].position = 0.0
    cr.elements[0].color = (*e, 1)
    cr.elements[1].position = 0.7
    cr.elements[1].color = (*e, 1)
    el = cr.elements.new(0.9)
    el.color = (*l, 1)
    el2 = cr.elements.new(0.985)
    el2.color = (*[c * 0.6 + ec * 0.4 for c, ec in zip(l, e)], 1)
    nt.links.new(f, ramp.inputs["Fac"])
    # fine fibres with the grain, and a broad tonal drift so long boards aren't flat
    mp2 = node(nt, "ShaderNodeMapping", -1600, -500)
    sc2 = [700.0, 700.0, 700.0]
    sc2[g] = 14.0
    mp2.inputs["Scale"].default_value = tuple(sc2)
    nt.links.new(tc.outputs["Object"], mp2.inputs["Vector"])
    fn = node(nt, "ShaderNodeTexNoise", -1400, -500)
    fn.inputs["Scale"].default_value = 1.0
    fn.inputs["Detail"].default_value = 4.0
    nt.links.new(mp2.outputs["Vector"], fn.inputs["Vector"])
    fib = node(nt, "ShaderNodeMapRange", -650, -400)
    fib.inputs["To Min"].default_value = 0.9 * tint
    fib.inputs["To Max"].default_value = 1.07 * tint
    nt.links.new(fn.outputs["Fac"], fib.inputs["Value"])
    mul = node(nt, "ShaderNodeMix", -350, 100, data_type="RGBA", blend_type="MULTIPLY")
    mul.inputs["Factor"].default_value = 1.0
    nt.links.new(ramp.outputs["Color"], mul.inputs["A"])
    nt.links.new(fib.outputs["Result"], mul.inputs["B"])
    nt.links.new(mul.outputs["Result"], bsdf.inputs["Base Color"])
    # a touch of relief in the late wood, through the bevel's rounded normal
    bump = node(nt, "ShaderNodeBump", 500, -150)
    bump.inputs["Strength"].default_value = 0.035
    bump.inputs["Distance"].default_value = 0.0003
    nt.links.new(f, bump.inputs["Height"])
    nt.links.new(bev.outputs["Normal"], bump.inputs["Normal"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Specular IOR Level"].default_value = 0.35
    bsdf.inputs["Coat Weight"].default_value = 0.08
    return m


def ply_edge(name, thick_axis, t0, t, tint):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    bsdf, bev = principled(nt, 0.75)
    nt.links.new(bev.outputs["Normal"], bsdf.inputs["Normal"])
    tc = node(nt, "ShaderNodeTexCoord", -1300, 0)
    sep = node(nt, "ShaderNodeSeparateXYZ", -1100, 0)
    nt.links.new(tc.outputs["Object"], sep.inputs["Vector"])
    # layer number across the thickness: (coord - t0) / t * 7
    sub = node(nt, "ShaderNodeMath", -900, 0, operation="SUBTRACT")
    nt.links.new(sep.outputs["XYZ"[thick_axis]], sub.inputs[0])
    sub.inputs[1].default_value = t0
    scl = node(nt, "ShaderNodeMath", -750, 0, operation="MULTIPLY")
    nt.links.new(sub.outputs[0], scl.inputs[0])
    scl.inputs[1].default_value = 7.0 / t
    flo = node(nt, "ShaderNodeMath", -600, 100, operation="FLOOR")
    nt.links.new(scl.outputs[0], flo.inputs[0])
    md = node(nt, "ShaderNodeMath", -450, 100, operation="MODULO")
    nt.links.new(flo.outputs[0], md.inputs[0])
    md.inputs[1].default_value = 2.0
    mix = node(nt, "ShaderNodeMix", -250, 100, data_type="RGBA")
    mix.inputs["A"].default_value = (*[c * tint for c in lin("#E2CB9F")], 1)
    mix.inputs["B"].default_value = (*[c * tint for c in lin("#C9A673")], 1)
    nt.links.new(md.outputs[0], mix.inputs["Factor"])
    # thin glue lines between the layers
    fr = node(nt, "ShaderNodeMath", -600, -100, operation="FRACT")
    nt.links.new(scl.outputs[0], fr.inputs[0])
    edge = node(nt, "ShaderNodeMath", -450, -100, operation="PINGPONG")
    nt.links.new(fr.outputs[0], edge.inputs[0])
    edge.inputs[1].default_value = 0.5
    glue = node(nt, "ShaderNodeMapRange", -300, -100)
    glue.inputs["From Min"].default_value = 0.0
    glue.inputs["From Max"].default_value = 0.05
    glue.inputs["To Min"].default_value = 0.45
    glue.inputs["To Max"].default_value = 1.0
    nt.links.new(edge.outputs[0], glue.inputs["Value"])
    mul = node(nt, "ShaderNodeMix", -50, 100, data_type="RGBA", blend_type="MULTIPLY")
    mul.inputs["Factor"].default_value = 1.0
    nt.links.new(mix.outputs["Result"], mul.inputs["A"])
    nt.links.new(glue.outputs["Result"], mul.inputs["B"])
    nt.links.new(mul.outputs["Result"], bsdf.inputs["Base Color"])
    return m


def plain(name, color, rough, metal=0.0, noise=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    bsdf, bev = principled(nt, rough)
    nt.links.new(bev.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Metallic"].default_value = metal
    if noise:
        tc = node(nt, "ShaderNodeTexCoord", -900, 0)
        nz = node(nt, "ShaderNodeTexNoise", -700, 0)
        nz.inputs["Scale"].default_value = 180.0
        nz.inputs["Detail"].default_value = 8.0
        nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
        rng = node(nt, "ShaderNodeMapRange", -500, 0)
        rng.inputs["To Min"].default_value = 1 - noise
        rng.inputs["To Max"].default_value = 1 + noise * 0.5
        nt.links.new(nz.outputs["Fac"], rng.inputs["Value"])
        mul = node(nt, "ShaderNodeMix", -250, 0, data_type="RGBA", blend_type="MULTIPLY")
        mul.inputs["Factor"].default_value = 1.0
        mul.inputs["A"].default_value = (*color, 1)
        nt.links.new(rng.outputs["Result"], mul.inputs["B"])
        nt.links.new(mul.outputs["Result"], bsdf.inputs["Base Color"])
    else:
        bsdf.inputs["Base Color"].default_value = (*color, 1)
    return m


for pid, ob in objs.items():
    p = info[pid]
    rnd = seeded(pid + p["name"])
    tint = 0.93 + 0.12 * rnd()
    bb = [Vector(c) for c in ob.bound_box]
    lo = Vector((min(c.x for c in bb), min(c.y for c in bb), min(c.z for c in bb)))
    hi = Vector((max(c.x for c in bb), max(c.y for c in bb), max(c.z for c in bb)))
    size = hi - lo
    g = AXIS[p["grain"]]
    others = [i for i in range(3) if i != g]
    half = max(0.03, math.hypot(size[others[0]], size[others[1]]) / 2)
    ang = rnd() * 2 * math.pi
    reach = half * (1.1 + 0.9 * rnd())
    pith = [(lo[i] + hi[i]) / 2 for i in range(3)]
    pith[others[0]] += math.cos(ang) * reach
    pith[others[1]] += math.sin(ang) * reach
    mat = p["material"]
    if mat in WOOD:
        a = b = timber(f"{p['name']} timber", mat, p["grain"], pith, tint)
    elif mat == "ply":
        t_axis = min(range(3), key=lambda i: size[i])
        face_grain = "xyz"[[i for i in range(3) if i != t_axis][0] if g == t_axis else g]
        a = timber(f"{p['name']} ply face", "birch", face_grain, pith, tint)
        b = ply_edge(f"{p['name']} ply edge", t_axis, lo[t_axis], size[t_axis], tint)
    elif mat == "steel":
        a = b = plain(f"{p['name']} steel", lin("#B4B9BE"), 0.32, metal=1.0)
    elif mat == "concrete":
        a = b = plain(f"{p['name']} concrete", lin("#A3A19B"), 0.92, noise=0.25)
    elif mat == "mdf":
        a = b = plain(f"{p['name']} mdf", lin("#B08A60"), 0.8, noise=0.06)
    else:
        a = b = plain(f"{p['name']} plain", lin("#D9D5CD"), 0.75)
    slots = ob.data.materials
    for i in range(len(slots)):
        slots[i] = a if i == 0 else b
    if not len(slots):
        slots.append(a)

# ---------------------------------------------------------------- pulling apart, and the boxes to frame


def set_apart(t):
    for pid, ob in objs.items():
        d = Vector(info[pid]["apart"]) * t
        ob.matrix_world = Matrix.Translation(d) @ home[pid]
    bpy.context.view_layer.update()


def box(objects=None):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for ob in objects or objs.values():
        for c in ob.bound_box:
            w = ob.matrix_world @ Vector(c)
            lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
            hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
    return lo, hi


set_apart(1.0)
alo, ahi = box()
set_apart(0.0)
tlo, thi = box()
ulo = Vector((min(alo.x, tlo.x), min(alo.y, tlo.y), min(alo.z, tlo.z)))
uhi = Vector((max(ahi.x, thi.x), max(ahi.y, thi.y), max(ahi.z, thi.z)))
R = max((uhi - ulo).length, 0.05)
floor_z = ulo.z

# ---------------------------------------------------------------- backdrop, world, lights, camera
DARK = job.get("backdrop") == "dark"
BACK = lin("#1B1D20") if DARK else lin("#E9E8E4")
world = bpy.data.worlds.new("Studio")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (*([c * 0.9 for c in BACK]), 1)
bg.inputs["Strength"].default_value = 0.07 if DARK else 0.1


def sweep():
    """A floor that curves up into a wall behind: no horizon line. Built along +y (away from the camera) and turned."""
    W, D, Rc, H = R * 9, R * 4, R * 1.4, R * 5
    pts = [(-D, 0.0)]
    steps = 16
    for i in range(steps + 1):
        a = math.pi / 2 * i / steps
        pts.append((R * 1.2 + Rc * math.sin(a), Rc * (1 - math.cos(a))))
    pts.append((R * 1.2 + Rc, H))
    verts, faces = [], []
    for y, z in pts:
        verts.append((-W / 2, y, z))
        verts.append((W / 2, y, z))
    for i in range(len(pts) - 1):
        faces.append((2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2))
    me = bpy.data.meshes.new("Backdrop")
    me.from_pydata(verts, [], faces)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new("Backdrop", me)
    scene.collection.objects.link(ob)
    mat = bpy.data.materials.new("Backdrop")
    mat.use_nodes = True
    b = mat.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*BACK, 1)
    b.inputs["Roughness"].default_value = 0.95
    b.inputs["Specular IOR Level"].default_value = 0.15
    me.materials.append(mat)
    return ob


backdrop = sweep()
cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 70
cam_data.sensor_width = 36
cam_data.clip_start = R * 0.01
cam_data.clip_end = R * 80
cam = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

lights = {}
for nm, energy, size in (("Key", 1.0, 1.2), ("Fill", 0.16, 2.2), ("Rim", 0.55, 1.0)):
    ld = bpy.data.lights.new(nm, "AREA")
    ld.shape = "DISK"
    ld.size = R * size
    ld["k"] = energy
    lo = bpy.data.objects.new(nm, ld)
    scene.collection.objects.link(lo)
    lights[nm] = lo

DIRS = {"hero": (0.53, -0.74, 0.42), "apart": (0.53, -0.74, 0.42), "front": (0.0, -1.0, 0.06), "side": (1.0, 0.0, 0.06), "top": (0.0, -0.02, 1.0), "detail": (0.6, -0.68, 0.48)}


def aim(ob, target):
    """Point a camera or a light at target, its top towards the sky (straight down, its top towards the back)."""
    d = target - ob.location
    if abs(d.normalized().z) > 0.999:
        d = d + Vector((0, 0.002 * d.length, 0))
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def place_lights(view_dir, target, dist):
    """Three soft lights that move with the camera: a key up and to the left, a fill low on the right, a rim behind."""
    fwd = Vector((view_dir.x, view_dir.y, 0)).normalized() if abs(view_dir.z) < 0.97 else Vector((0, -1, 0))
    side = fwd.cross(Vector((0, 0, 1))).normalized()
    spots = {
        "Key": fwd * 0.45 + side * 0.8 + Vector((0, 0, 1.35)),
        "Fill": fwd * 0.9 - side * 0.9 + Vector((0, 0, 0.35)),
        "Rim": -fwd * 1.0 + side * 0.25 + Vector((0, 0, 1.25)),
    }
    for nm, lo in lights.items():
        off = spots[nm].normalized() * dist * 0.9
        lo.location = target + off
        aim(lo, target)
        lo.data.energy = lo.data["k"] * 30.0 * (off.length ** 2) * (0.8 if DARK else 1.0)


def turn_backdrop(view_dir, target):
    fwd = Vector((view_dir.x, view_dir.y, 0))
    yaw = math.atan2(-fwd.x, -fwd.y) if fwd.length > 0.05 else 0.0
    backdrop.location = (target.x, target.y, floor_z)
    backdrop.rotation_euler = (0, 0, -yaw)


def fit(view_dir, lo, hi, w, h, margin=0.86):
    target = (lo + hi) / 2
    corners = [Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]
    d = view_dir.normalized()
    scene.render.resolution_x, scene.render.resolution_y = w, h
    a, b = R * 0.05, R * 40
    for _ in range(40):
        mid = (a + b) / 2
        cam.location = target + d * mid
        aim(cam, target)
        bpy.context.view_layer.update()
        ok = True
        for c in corners:
            p = world_to_camera_view(scene, cam, c)
            if p.z <= 0 or abs(p.x - 0.5) > margin / 2 or abs(p.y - 0.5) > margin / 2:
                ok = False
                break
        if ok:
            b = mid
        else:
            a = mid
    cam.location = target + d * b
    aim(cam, target)
    bpy.context.view_layer.update()
    return target, b


# ---------------------------------------------------------------- render settings: Cycles, the graphics card if there is one
scene.render.engine = "CYCLES"
device = "CPU"
try:
    cp = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            cp.compute_device_type = kind
            cp.get_devices()
            gpus = [d for d in cp.devices if d.type == kind]
            if gpus:
                for d in cp.devices:
                    d.use = d.type == kind
                device = kind
                break
        except Exception:
            continue
except Exception:
    pass
scene.cycles.device = "GPU" if device != "CPU" else "CPU"
scene.cycles.use_denoising = True
scene.cycles.denoiser = "OPTIX" if device == "OPTIX" else "OPENIMAGEDENOISE"
scene.cycles.use_adaptive_sampling = True
scene.cycles.samples = int(job.get("samples", 96))
scene.cycles.max_bounces = 6
scene.render.film_transparent = False
try:
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
except Exception:
    try:
        scene.view_settings.view_transform = "Filmic"
    except Exception:
        pass
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"
scene.render.resolution_percentage = 100
log("DEVICE", device)

LONG = int(job.get("size", 1920))
W, H = LONG, round(LONG * 2 / 3)

# ---------------------------------------------------------------- files the owner asked for: the scene itself, a USDZ
set_apart(0.0)
d0 = Vector(DIRS["hero"])
target, dist = fit(d0, tlo, thi, W, H)
place_lights(d0, target, dist)
turn_backdrop(d0, target)
if job.get("save_blend"):
    bpy.ops.wm.save_as_mainfile(filepath=job["save_blend"], copy=True, compress=True)
    log("SAVED blend", job["save_blend"])
if job.get("save_usdz"):
    keep = [backdrop, *lights.values(), cam]
    for o in keep:
        o.hide_set(True)
        o.hide_render = True
    # USD can't carry the grain made of shader nodes: each part gets a plain colour of its timber for the export only
    FLAT = {"pine": "#CDA772", "hardwood": "#7E4F33", "oak": "#B28B5B", "walnut": "#5E3E29", "ply": "#D8C197", "mdf": "#B08A60", "steel": "#B4B9BE", "concrete": "#A3A19B", "plain": "#D9D5CD"}
    saved_mats = {}
    for pid, ob in objs.items():
        kind = info[pid]["material"]
        fm = bpy.data.materials.new(f"{ob.name} colour")
        fm.use_nodes = True
        pb = fm.node_tree.nodes["Principled BSDF"]
        pb.inputs["Base Color"].default_value = (*lin(FLAT.get(kind, "#D9D5CD")), 1)
        pb.inputs["Roughness"].default_value = 0.35 if kind == "steel" else 0.6
        pb.inputs["Metallic"].default_value = 1.0 if kind == "steel" else 0.0
        saved_mats[pid] = [sl for sl in ob.data.materials]
        for i in range(len(ob.data.materials)):
            ob.data.materials[i] = fm
    sel = {"selected_objects_only": False, "export_materials": True, "visible_objects_only": True}
    try:
        bpy.ops.wm.usd_export(filepath=job["save_usdz"], **sel)
    except TypeError:
        bpy.ops.wm.usd_export(filepath=job["save_usdz"])
    for o in keep:
        o.hide_set(False)
        o.hide_render = False
    for pid, ob in objs.items():
        for i, m in enumerate(saved_mats[pid]):
            ob.data.materials[i] = m
    log("SAVED usdz", job["save_usdz"])

# ---------------------------------------------------------------- the shots
shots = list(job.get("shots", []))
total = len(shots)


def dims2d(apart):
    out = []
    for d in model.get("dims", []):
        show = d.get("show")
        if show == "apart" and not apart or show == "together" and apart:
            continue
        off = Vector(info[d["part"]]["apart"]) if apart and d.get("part") in info else Vector((0, 0, 0))
        a = world_to_camera_view(scene, cam, Vector(d["a"]) + off)
        b = world_to_camera_view(scene, cam, Vector(d["b"]) + off)
        if a.z <= 0 or b.z <= 0:
            continue
        L = (Vector(d["a"]) - Vector(d["b"])).length * 1000
        out.append({"a": [a.x * W, (1 - a.y) * H], "b": [b.x * W, (1 - b.y) * H], "text": d.get("text") or str(round(L))})
    return out


for i, shot in enumerate(shots):
    log(f"PROGRESS {i + 1}/{total} {shot}")
    t0 = time.time()
    if shot == "turntable":
        set_apart(0.0)
        tw, th = (1280, 720) if LONG <= 1920 else (1920, 1080)
        scene.render.resolution_x, scene.render.resolution_y = tw, th
        # turn round the middle of the model as it stands, far enough back that its bounding sphere fits the frame at
        # every angle (a box fitted from one side can run off the frame from another)
        d = Vector(DIRS["hero"]).normalized()
        target = (tlo + thi) / 2
        radius = (thi - tlo).length / 2
        half_v = math.atan((cam_data.sensor_width / 2) * (th / tw) / cam_data.lens)
        dist = radius / math.sin(half_v) / 0.9
        cam.location = target + d * dist
        aim(cam, target)
        bpy.context.view_layer.update()
        place_lights(d, target, dist)
        # a disc of floor and the world the same tone, so the turning camera never sees an edge
        backdrop.hide_render = True
        me = bpy.data.meshes.new("Floor")
        rr, n = R * 25, 64
        me.from_pydata([(target.x + rr * math.cos(2 * math.pi * k / n), target.y + rr * math.sin(2 * math.pi * k / n), floor_z) for k in range(n)], [], [list(range(n))])
        fl = bpy.data.objects.new("Floor", me)
        scene.collection.objects.link(fl)
        me.materials.append(backdrop.data.materials[0])
        bg.inputs["Color"].default_value = (*BACK, 1)
        pivot = bpy.data.objects.new("Turntable", None)
        scene.collection.objects.link(pivot)
        pivot.location = target
        bpy.context.view_layer.update()  # the pivot must be in place before anything is hung on it
        cam_world = cam.matrix_world.copy()
        cam.parent = pivot
        cam.matrix_world = cam_world
        for nm, lo in lights.items():
            lw = lo.matrix_world.copy()
            lo.parent = pivot
            lo.matrix_world = lw
        frames = 144
        scene.frame_start, scene.frame_end = 1, frames
        scene.render.fps = 24
        pivot.rotation_euler = (0, 0, 0)
        pivot.keyframe_insert("rotation_euler", frame=1)
        pivot.rotation_euler = (0, 0, 2 * math.pi * (frames) / frames)
        pivot.keyframe_insert("rotation_euler", frame=frames + 1)
        for fc in pivot.animation_data.action.layers[0].strips[0].channelbag(pivot.animation_data.action.slots[0]).fcurves if hasattr(pivot.animation_data.action, "layers") and pivot.animation_data.action.layers else pivot.animation_data.action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
        scene.cycles.samples = int(job.get("turntable_samples", 24))
        isets = scene.render.image_settings
        if hasattr(isets, "media_type"):
            isets.media_type = "VIDEO"
        isets.file_format = "FFMPEG"
        scene.render.ffmpeg.format = "MPEG4"
        scene.render.ffmpeg.codec = "H264"
        scene.render.ffmpeg.constant_rate_factor = "HIGH"
        path = os.path.join(OUT, "turntable.mp4")
        scene.render.filepath = path
        bpy.ops.render.render(animation=True)
        log(f"TIME {shot} {time.time() - t0:.1f}")
        log("SAVED video", path)
        # a few frames as stills too, when asked (for checking the video by eye without a player)
        if job.get("check_frames"):
            if hasattr(isets, "media_type"):
                isets.media_type = "IMAGE"
            isets.file_format = "PNG"
            for fr in job["check_frames"]:
                scene.frame_set(int(fr))
                scene.render.filepath = os.path.join(OUT, f"turntable-frame-{int(fr):03d}.png")
                bpy.ops.render.render(write_still=True)
        continue
    apart = shot == "apart"
    set_apart(1.0 if apart else 0.0)
    lo, hi = (alo, ahi) if apart else (tlo, thi)
    d = Vector(DIRS.get(shot, DIRS["hero"]))
    margin = 0.86
    if job.get("labels") and shot in ("front", "side"):
        # the sizes sit outside the parts: frame them too, with room for their labels
        lo, hi = lo.copy(), hi.copy()
        for dm in model.get("dims", []):
            show = dm.get("show")
            if show == "apart" and not apart or show == "together" and apart:
                continue
            off = Vector(info[dm["part"]]["apart"]) if apart and dm.get("part") in info else Vector((0, 0, 0))
            for p in (Vector(dm["a"]) + off, Vector(dm["b"]) + off):
                lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
                hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
        margin = 0.8
    if shot == "detail":
        # closer in on the joint: where the parts' boxes meet
        bs = [box([ob]) for ob in objs.values()]
        jl, jh = None, None
        for a in range(len(bs)):
            for b in range(a + 1, len(bs)):
                l = Vector((max(bs[a][0].x, bs[b][0].x), max(bs[a][0].y, bs[b][0].y), max(bs[a][0].z, bs[b][0].z)))
                h = Vector((min(bs[a][1].x, bs[b][1].x), min(bs[a][1].y, bs[b][1].y), min(bs[a][1].z, bs[b][1].z)))
                if l.x <= h.x + 1e-6 and l.y <= h.y + 1e-6 and l.z <= h.z + 1e-6:
                    jl = l if jl is None else Vector((min(jl.x, l.x), min(jl.y, l.y), min(jl.z, l.z)))
                    jh = h if jh is None else Vector((max(jh.x, h.x), max(jh.y, h.y), max(jh.z, h.z)))
        if jl is not None:
            pad = max((jh - jl).length, R * 0.12) * 0.9
            lo, hi = jl - Vector((pad, pad, pad)), jh + Vector((pad, pad, pad))
        margin = 1.0
    target, dist = fit(d, lo, hi, W, H, margin)
    place_lights(d, target, dist)
    turn_backdrop(d, target)
    backdrop.hide_render = shot == "top"  # straight down, a plain floor tone is enough
    path = os.path.join(OUT, f"{shot}.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    log(f"TIME {shot} {time.time() - t0:.1f}")
    if job.get("labels") and shot in ("front", "side"):
        with open(os.path.join(OUT, f"{shot}.dims.json"), "w", encoding="utf-8") as f:
            json.dump({"w": W, "h": H, "dark": DARK, "dims": dims2d(apart)}, f)
    log("SAVED picture", path)

log("FINISHED")
