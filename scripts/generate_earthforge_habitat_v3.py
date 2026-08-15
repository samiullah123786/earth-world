"""Split the approved EarthForge renders into semantic runtime passes.

The existing live building PNGs remain the canonical art. This compiler only
separates their pixels according to the bounded mask declarations in
``shared/earthforge-habitat-specs.json``. Re-compositing the emitted passes in
layer order is pixel-equivalent to the approved source image.

Usage: python scripts/generate_earthforge_habitat_v3.py
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "shared" / "earthforge-catalog.json"
SPEC_PATH = ROOT / "shared" / "earthforge-habitat-specs.json"
SOURCE_LOCK_PATH = ROOT / "shared" / "earthforge-source-lock.json"
BUILDINGS = ROOT / "public" / "assets" / "earthforge" / "buildings"
LAYERS = BUILDINGS / "layers"


def region_mask(size: tuple[int, int], regions: list[list[int]]) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for region in regions:
        if len(region) != 4 or any(not isinstance(value, int) for value in region):
            raise ValueError(f"invalid mask region {region}")
        x0, y0, x1, y1 = region
        if x0 < 0 or y0 < 0 or x1 > size[0] or y1 > size[1] or x0 >= x1 or y0 >= y1:
            raise ValueError(f"mask region leaves source canvas: {region}")
        draw.rectangle((x0, y0, x1 - 1, y1 - 1), fill=255)
    return mask


def masked(source: Image.Image, mask: Image.Image) -> Image.Image:
    output = source.copy()
    output.putalpha(ImageChops.multiply(source.getchannel("A"), mask))
    return output


def compile_asset(asset_id: str, asset: dict[str, Any], spec: dict[str, Any], expected_source_sha: str):
    source_path = BUILDINGS / f"{asset_id}.png"
    source = Image.open(source_path).convert("RGBA")
    source_sha = hashlib.sha256(source_path.read_bytes()).hexdigest()
    if source_sha != expected_source_sha:
        raise RuntimeError(f"{asset_id} is not the locked smooth approved source; refusing pixelated or modified art")
    if source.size != tuple(asset["layers"]["pixelSize"]):
        raise RuntimeError(f"{asset_id} source size {source.size} does not match its catalog")
    overhead_mask = region_mask(source.size, spec["overheadRegions"])
    ground_mask = ImageChops.subtract(region_mask(source.size, spec["groundRegions"]), overhead_mask)
    occupied = ImageChops.lighter(overhead_mask, ground_mask)
    midground_mask = ImageChops.invert(occupied)
    layers = {
        "ground": masked(source, ground_mask),
        "midground": masked(source, midground_mask),
        "overhead": masked(source, overhead_mask),
        "emissive": Image.new("RGBA", source.size, (0, 0, 0, 0)),
    }
    recomposed = Image.new("RGBA", source.size, (0, 0, 0, 0))
    for key in ("ground", "midground", "overhead", "emissive"):
        recomposed.alpha_composite(layers[key])
    if ImageChops.difference(source, recomposed).getbbox() is not None:
        raise RuntimeError(f"{asset_id} layer split changed approved artwork")

    normal = Image.new("RGBA", source.size, (128, 128, 255, 0))
    normal.putalpha(source.getchannel("A"))
    output = LAYERS / asset_id
    output.mkdir(parents=True, exist_ok=True)
    digests: dict[str, str] = {}
    for key, image in {**layers, "normal": normal}.items():
        path = output / f"{key}.png"
        image.save(path, optimize=True)
        digests[key] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest = {
        "assetId": asset_id,
        "compiler": "earthforge-habitat-spec-v1",
        "visualSystem": "earthforge-layered-habitat-v3",
        "source": f"/assets/earthforge/buildings/{asset_id}.png",
        "sourceSha256": source_sha,
        "pixelSize": list(source.size),
        "sortRow": asset["layers"]["sortRow"],
        "footprint": asset["footprint"],
        "entry": asset["entry"],
        "collision": asset["collision"],
        "masks": spec,
        "sha256": digests,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main():
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    specs = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    source_lock = json.loads(SOURCE_LOCK_PATH.read_text(encoding="utf-8"))
    if catalog["visualSystem"] != "earthforge-layered-habitat-v3":
        raise RuntimeError("catalog visual system is not EarthForge v3")
    if specs["system"] != "earthforge-habitat-spec-v1" or specs["gridSize"] != 32:
        raise RuntimeError("unsupported habitat specification")
    unknown = set(specs["structures"]) ^ set(catalog["assets"])
    if unknown:
        raise RuntimeError(f"catalog/spec mismatch: {sorted(unknown)}")
    if source_lock.get("policy") != "smooth-pre-quantization-only" or set(source_lock["sha256"]) != set(catalog["assets"]):
        raise RuntimeError("EarthForge smooth source lock is incomplete")
    LAYERS.mkdir(parents=True, exist_ok=True)
    manifests = [compile_asset(asset_id, asset, specs["structures"][asset_id], source_lock["sha256"][asset_id])
                 for asset_id, asset in catalog["assets"].items()]
    summary = {
        "visualSystem": catalog["visualSystem"],
        "compiler": specs["system"],
        "gridSize": 32,
        "sourcePolicy": specs["rules"]["source"],
        "assets": [{"assetId": item["assetId"], "sourceSha256": item["sourceSha256"], "sha256": item["sha256"]}
                   for item in manifests],
    }
    (LAYERS / "manifest.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"EARTHFORGE_APPROVED_ART_LAYERED assets={len(manifests)}")


if __name__ == "__main__":
    main()
