"""Generate the EarthForge semantic building library with headless Blender.

Usage:
  blender --background --python scripts/generate_earthforge_assets.py -- --output public/assets/earthforge/buildings

The committed PNGs are runtime artifacts. Blender is a build-time compiler only.
After Blender, run ``python scripts/generate_earthforge_pixel_world.py`` to
compile buildings and habitat materials into the shared 32px pixel grammar.
"""
from __future__ import annotations

import argparse
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector


PALETTE = {
    "cream": (0.78, 0.65, 0.44, 1),
    "plaster": (0.72, 0.52, 0.30, 1),
    "brick": (0.34, 0.075, 0.035, 1),
    "timber": (0.16, 0.055, 0.018, 1),
    "roof": (0.20, 0.035, 0.028, 1),
    "slate": (0.09, 0.10, 0.14, 1),
    "stone": (0.38, 0.40, 0.39, 1),
    "copper": (0.045, 0.32, 0.18, 1),
    "glass": (0.08, 0.38, 0.48, 0.52),
    "green": (0.06, 0.31, 0.10, 1),
    "leaf": (0.10, 0.48, 0.14, 1),
    "flower": (0.68, 0.08, 0.18, 1),
    "metal": (0.16, 0.19, 0.22, 1),
    "path": (0.45, 0.31, 0.18, 1),
    "warm": (1.0, 0.38, 0.06, 1),
    "shadow": (0.015, 0.02, 0.025, 0.24),
}


def material(name: str, color, roughness=0.72, metallic=0.0, emission=None):
    existing = bpy.data.materials.get(name)
    if existing:
        return existing
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if color[3] < 1:
        bsdf.inputs["Alpha"].default_value = color[3]
        mat.surface_render_method = "DITHERED"
    if emission:
        bsdf.inputs["Emission Color"].default_value = emission
        bsdf.inputs["Emission Strength"].default_value = 2.8
    return mat


MATS = {}


def mat(name):
    if not MATS:
        for key, color in PALETTE.items():
            MATS[key] = material(key, color, 0.34 if key in {"glass", "metal"} else 0.78, 0.55 if key in {"copper", "metal"} else 0.0, PALETTE["warm"] if key == "warm" else None)
    return MATS[name]


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def apply_bevel(obj, amount=0.08, segments=3):
    modifier = obj.modifiers.new("soft handcrafted edges", "BEVEL")
    modifier.width = amount
    modifier.segments = segments
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def cube(name, location, scale, material_name, bevel=0.06, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        apply_bevel(obj, bevel)
    obj.data.materials.append(mat(material_name))
    return obj


def cylinder(name, location, radius, depth, material_name, vertices=32, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat(material_name))
    apply_bevel(obj, min(radius * 0.12, 0.08), 2)
    return obj


def sphere(name, location, scale, material_name):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat(material_name))
    return obj


def arch_mesh(name, location, width, depth, wall_height, rise, material_name, steps=12):
    verts = []
    for y in (-depth / 2, depth / 2):
        for index in range(steps + 1):
            t = index / steps
            x = -width / 2 + width * t
            z = wall_height + math.sin(math.pi * t) * rise
            verts.append((x, y, z))
    faces = []
    row = steps + 1
    for index in range(steps):
        faces.append((index, index + 1, row + index + 1, row + index))
    faces += [tuple(range(row - 1, -1, -1)), tuple(range(row, row * 2))]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.data.materials.append(mat(material_name))
    solid = obj.modifiers.new("roof thickness", "SOLIDIFY")
    solid.thickness = 0.16
    bevel = obj.modifiers.new("rounded roof", "BEVEL")
    bevel.width = 0.05
    bevel.segments = 3
    return obj


def window(x, y, z, width=0.42, height=0.58, arched=False):
    cube("warm window", (x, y, z), (width, 0.07, height), "warm", 0.05)
    cube("window lintel", (x, y - 0.075, z + height + 0.08), (width + 0.08, 0.05, 0.06), "timber", 0.03)
    cube("window mullion", (x, y - 0.1, z), (0.035, 0.035, height), "timber", 0.01)
    cube("window rail", (x, y - 0.1, z), (width, 0.035, 0.035), "timber", 0.01)
    if arched:
        cylinder("arched crown", (x, y - 0.08, z + height), width, 0.12, "warm", 32, (math.pi / 2, 0, 0))


def door(x, y, z=0.72, width=0.48, height=0.78, grand=False):
    cube("entry door", (x, y, z), (width, 0.09, height), "timber", 0.08)
    if grand:
        cylinder("arched entry", (x, y, z + height), width, 0.17, "timber", 32, (math.pi / 2, 0, 0))
    sphere("door lamp", (x + width * 0.55, y - 0.16, z + 0.08), (0.08, 0.08, 0.08), "warm")


def shrubs(front_y=-2.15, spread=3.0, count=7, orchard=False):
    for index in range(count):
        x = -spread / 2 + spread * index / max(1, count - 1)
        y = front_y + (0.12 if index % 2 else -0.05)
        sphere("garden shrub", (x, y, 0.22), (0.27, 0.23, 0.24), "leaf" if index % 3 else "green")
        if index % 2:
            sphere("garden flower", (x + 0.08, y - 0.04, 0.46), (0.055, 0.055, 0.055), "flower")
    if orchard:
        cylinder("orchard trunk", (-2.2, 0.9, 0.75), 0.16, 1.5, "timber")
        sphere("orchard crown", (-2.2, 0.9, 1.85), (0.85, 0.75, 0.72), "leaf")


def path_and_shadow(width=4.8, depth=4.0):
    sphere("soft contact shadow", (0.25, 0.2, 0.025), (width * 0.62, depth * 0.42, 0.035), "shadow")
    cube("curved entry path", (0, -2.5, 0.05), (0.56, 1.05, 0.05), "path", 0.28)


def home(variant):
    path_and_shadow()
    wall = "cream" if variant != "timber" else "plaster"
    cube("home body", (0, 0, 1.25), (2.15, 1.55, 1.22), wall, 0.16)
    arch_mesh("soft gable roof", (0, 0, 1.35), 5.0, 3.8, 1.22, 1.55 if variant == "courtyard" else 1.15,
              "copper" if variant == "orchard" else "roof")
    door(0, -1.62, grand=variant == "timber")
    window(-1.22, -1.62, 1.15, arched=variant == "courtyard")
    window(1.22, -1.62, 1.15)
    cube("porch canopy", (0, -1.92, 1.75), (0.92, 0.48, 0.12), "timber", 0.12, (math.radians(8), 0, 0))
    cylinder("chimney", (1.45, 0.45, 3.35), 0.27, 1.1, "brick")
    if variant == "orchard":
        cube("orchard side wing", (2.15, -0.2, 0.92), (0.85, 1.05, 0.9), "plaster", 0.18)
        arch_mesh("orchard wing roof", (2.15, -0.2, 0.95), 2.1, 2.45, 0.82, 0.72, "roof", 9)
        window(2.85, -1.27, 0.92, 0.3, 0.48)
    if variant == "timber":
        for x in (-1.6, 0, 1.6):
            cube("timber upright", (x, -1.64, 1.35), (0.08, 0.055, 1.25), "timber", 0.02)
        cube("timber beam", (0, -1.65, 2.0), (2.12, 0.055, 0.09), "timber", 0.02)
    shrubs(orchard=variant == "orchard")


def bank():
    path_and_shadow(7.4, 5.4)
    cube("bank mass", (0, 0.35, 1.48), (3.25, 1.9, 1.4), "stone", 0.18)
    cylinder("rotunda drum", (0, 0.2, 3.0), 1.75, 0.72, "stone", 48)
    sphere("copper dome", (0, 0.2, 3.15), (1.8, 1.8, 1.25), "copper")
    cube("dome cutoff band", (0, 0.2, 2.72), (2.0, 2.0, 0.35), "stone", 0.12)
    cylinder("bank finial", (0, 0.2, 4.58), 0.13, 0.65, "copper")
    cube("civic cornice", (0, -1.65, 2.55), (3.55, 0.28, 0.2), "cream", 0.12)
    for x in (-2.5, -1.55, 1.55, 2.5):
        cylinder("stone column", (x, -1.78, 1.25), 0.18, 2.5, "cream", 28)
    door(0, -1.88, 0.82, 0.72, 0.92, True)
    window(-2.25, -1.92, 1.35, 0.48, 0.72, True)
    window(2.25, -1.92, 1.35, 0.48, 0.72, True)
    for z in (0.14, 0.3, 0.46):
        cube("public stair", (0, -2.05 - z * 1.9, z), (2.15 + z, 0.42, 0.11), "stone", 0.06)
    shrubs(-2.3, 6.4, 9)


def workshop():
    path_and_shadow(6.0, 4.5)
    cube("workshop body", (0, 0.2, 1.25), (2.8, 1.7, 1.2), "brick", 0.14)
    for x in (-1.9, 0, 1.9):
        arch_mesh("sawtooth bay", (x, 0.2, 1.2), 2.15, 3.65, 1.2, 0.85, "slate", 6)
    cube("wide maker doors", (0, -1.56, 0.8), (1.05, 0.1, 0.78), "timber", 0.08)
    for x in (-2.0, 2.0):
        window(x, -1.56, 1.25, 0.48, 0.55)
    cylinder("vent stack", (2.15, 0.75, 3.05), 0.23, 1.4, "metal")
    cube("tool bench", (-2.15, -2.0, 0.35), (0.75, 0.34, 0.3), "timber", 0.07)
    shrubs(-2.2, 4.6, 5)


def hall():
    path_and_shadow(6.6, 5.0)
    cube("hall body", (0, 0.2, 1.45), (3.0, 1.75, 1.38), "cream", 0.16)
    arch_mesh("clock gable", (0, 0.15, 1.45), 6.7, 4.1, 1.36, 1.65, "slate")
    door(0, -1.64, 0.78, 0.62, 0.82, True)
    for x in (-2.15, -1.1, 1.1, 2.15):
        window(x, -1.64, 1.35, 0.34, 0.62, True)
    sphere("clock face", (0, -1.82, 2.9), (0.48, 0.08, 0.48), "warm")
    cube("clock hand", (0.08, -1.92, 2.98), (0.04, 0.025, 0.28), "timber", 0.01, (0, 0, math.radians(-28)))
    for x in (-2.55, -1.65, 1.65, 2.55):
        cylinder("arcade column", (x, -1.82, 0.72), 0.12, 1.44, "stone", 24)
    shrubs(-2.25, 5.7, 8)


def data_center():
    path_and_shadow(6.0, 4.7)
    cube("data house", (0, 0.25, 1.35), (2.75, 1.75, 1.28), "metal", 0.24)
    arch_mesh("green canopy roof", (0, 0.2, 1.35), 6.1, 4.1, 1.18, 0.62, "green")
    door(0, -1.58, 0.78, 0.7, 0.82)
    for x in (-2.15, -1.35, 1.35, 2.15):
        cube("cooling fin", (x, -1.6, 1.42), (0.12, 0.08, 0.74), "copper", 0.04)
        sphere("signal light", (x, -1.73, 2.18), (0.07, 0.07, 0.07), "warm")
    shrubs(-2.2, 4.8, 6)


def library():
    path_and_shadow(6.2, 4.6)
    cube("library body", (0, 0.15, 1.28), (2.85, 1.7, 1.22), "plaster", 0.18)
    arch_mesh("barrel vault", (0, 0.1, 1.26), 6.25, 4.05, 1.15, 1.35, "copper")
    door(0, -1.6, 0.78, 0.56, 0.82, True)
    for x in (-2.05, -1.15, 1.15, 2.05):
        window(x, -1.62, 1.32, 0.33, 0.7, True)
    cube("reading terrace", (0, -2.0, 0.18), (2.35, 0.5, 0.14), "stone", 0.12)
    shrubs(-2.3, 5.4, 8)


def greenhouse():
    path_and_shadow(6.0, 4.5)
    cube("glasshouse base", (0, 0.1, 0.24), (2.75, 1.7, 0.22), "stone", 0.1)
    arch_mesh("curved glasshouse", (0, 0.1, 0.22), 5.7, 3.6, 0.15, 2.25, "glass", 18)
    for x in (-2.2, -1.1, 0, 1.1, 2.2):
        cube("glass rib", (x, -1.68, 1.0), (0.045, 0.055, 0.92), "metal", 0.015)
    door(0, -1.74, 0.72, 0.52, 0.72)
    for x in (-1.65, 1.65):
        cube("planting bed", (x, -0.2, 0.42), (0.7, 1.1, 0.34), "path", 0.12)
        for y in (-0.9, -0.2, 0.5):
            sphere("glasshouse crop", (x, y, 0.85), (0.3, 0.3, 0.38), "leaf")
    cylinder("rain cistern", (2.55, 1.3, 0.72), 0.42, 1.42, "glass", 32)


def plaza_fountain():
    path_and_shadow(5.8, 4.6)
    cylinder("fountain lower basin", (0, 0.1, 0.22), 2.0, 0.38, "stone", 48)
    cylinder("fountain water", (0, 0.1, 0.43), 1.72, 0.08, "glass", 48)
    cylinder("fountain pedestal", (0, 0.1, 1.15), 0.36, 1.55, "stone", 32)
    cylinder("fountain upper bowl", (0, 0.1, 1.72), 0.82, 0.2, "copper", 48)
    sphere("water crown", (0, 0.1, 2.18), (0.18, 0.18, 0.38), "glass")
    for x in (-2.35, 2.35):
        cylinder("plaza lantern post", (x, -1.55, 0.78), 0.08, 1.55, "timber")
        sphere("plaza lantern", (x, -1.55, 1.62), (0.16, 0.16, 0.22), "warm")
    shrubs(-2.15, 5.2, 8)


def park_garden():
    path_and_shadow(6.2, 4.6)
    cylinder("park tree trunk", (1.4, 0.6, 1.05), 0.28, 2.1, "timber", 28)
    for offset, scale in [((-0.35, 0, 2.3), (1.2, 1.0, 0.9)), ((0.55, 0.1, 2.45), (1.1, 0.9, 0.82)), ((0.1, 0.5, 3.0), (1.0, 0.88, 0.75))]:
        sphere("park canopy", (1.4 + offset[0], 0.6 + offset[1], offset[2]), scale, "leaf")
    for x in (-1.65, 0.0):
        cube("park bench seat", (x, -1.25, 0.5), (0.7, 0.3, 0.12), "timber", 0.07)
        cube("park bench back", (x, -1.02, 0.88), (0.7, 0.08, 0.34), "timber", 0.06, (math.radians(-8), 0, 0))
    shrubs(-2.1, 5.6, 10)


def training_grove():
    path_and_shadow(6.0, 4.8)
    sphere("soft training lawn", (0, 0.1, 0.08), (2.75, 1.9, 0.08), "green")
    for x in (-2.45, 2.45):
        cylinder("training banner", (x, 0.15, 1.15), 0.09, 2.3, "timber")
        cube("training pennant", (x + (0.32 if x < 0 else -0.32), 0.12, 1.92), (0.34, 0.06, 0.25), "copper", 0.04)
    for x, y in [(-1.2, -0.3), (0, 0.45), (1.2, -0.3)]:
        cylinder("training marker", (x, y, 0.22), 0.18, 0.42, "cream", 24)
    shrubs(-2.15, 5.0, 7)


def bench_canopy():
    path_and_shadow(4.4, 3.5)
    cube("canopy bench seat", (0, -0.45, 0.54), (1.2, 0.35, 0.14), "timber", 0.09)
    cube("canopy bench back", (0, -0.16, 0.98), (1.2, 0.09, 0.38), "timber", 0.07, (math.radians(-8), 0, 0))
    for x in (-1.35, 1.35):
        cylinder("canopy post", (x, 0, 1.25), 0.09, 2.5, "copper", 24)
    arch_mesh("bench rain canopy", (0, 0, 1.78), 3.2, 1.8, 0.05, 0.62, "copper", 12)
    shrubs(-1.65, 3.8, 7)


def community_garden():
    path_and_shadow(5.6, 4.3)
    for x in (-1.55, -0.5, 0.55, 1.6):
        cube("raised planting bed", (x, 0.25, 0.28), (0.38, 1.35, 0.24), "path", 0.1)
        for y in (-0.65, 0.1, 0.85):
            sphere("garden crop", (x, y, 0.68), (0.28, 0.28, 0.34), "leaf" if int((x + y) * 10) % 2 else "green")
    cube("garden tool shed", (2.15, 1.15, 0.68), (0.58, 0.55, 0.64), "plaster", 0.12)
    arch_mesh("shed roof", (2.15, 1.15, 0.72), 1.45, 1.45, 0.55, 0.48, "roof", 8)
    cylinder("rain barrel", (-2.35, 1.15, 0.54), 0.34, 1.05, "copper", 28)


def configure_render(output: Path):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.filepath = str(output)
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.look = "AgX - Medium High Contrast"
    world = scene.world or bpy.data.worlds.new("EarthForge World")
    scene.world = world
    world.color = (0.025, 0.03, 0.045)
    bpy.ops.object.light_add(type="AREA", location=(-4.5, -6.5, 9.5))
    key = bpy.context.object
    key.data.energy = 1100
    key.data.shape = "DISK"
    key.data.size = 6.0
    bpy.ops.object.light_add(type="AREA", location=(5.0, 2.5, 5.5))
    fill = bpy.context.object
    fill.data.energy = 650
    fill.data.color = (0.36, 0.52, 0.78)
    fill.data.size = 5.0
    bpy.ops.object.camera_add(location=(8.8, -11.8, 9.2))
    camera = bpy.context.object
    direction = Vector((0, 0, 1.3)) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 9.2
    scene.camera = camera


BUILDERS = {
    "home_courtyard": lambda: home("courtyard"),
    "home_orchard": lambda: home("orchard"),
    "home_timber": lambda: home("timber"),
    "bank_rotunda": bank,
    "workshop_sawtooth": workshop,
    "civic_hall": hall,
    "data_center": data_center,
    "library_pavilion": library,
    "greenhouse": greenhouse,
    "plaza_fountain": plaza_fountain,
    "park_garden": park_garden,
    "training_grove": training_grove,
    "bench_canopy": bench_canopy,
    "community_garden": community_garden,
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    for asset_id, builder in BUILDERS.items():
        clear_scene()
        builder()
        configure_render(output / f"{asset_id}.png")
        bpy.ops.render.render(write_still=True)
        print(f"EARTHFORGE_RENDERED {asset_id}")


if __name__ == "__main__":
    main()
