"""convert_wound_tissue_v1.py — แปลง "My First Project" (COCO polygon) เป็น mask
รองรับ dataset: My First Project (ramesh-singh-9tdm3, Roboflow Universe)
Classes ต้นทาง: Callus, Epithelial, Granulation, Maceration, Necrotic Tissue,
                Other Wound Tissue, Slough, Tendon-Bone

Mapping ไปยัง 5-class ของ VITA:
  Slough           -> 1 (Fibrin)
  Granulation      -> 2 (Granulation)
  Callus           -> 3 (Callus)
  Necrotic Tissue  -> 4 (Necrotic)
  Epithelial / Maceration / Other Wound Tissue / Tendon-Bone -> ไม่มีคลาสตรง (ไม่วาด)

หมายเหตุพิเศษ: dataset นี้ export มาเป็น split เดียว (train ทั้งหมด 181 ภาพ,
ไม่มี valid/test) สคริปต์นี้จะ**แบ่ง split เอง** แบบ deterministic (80/10/10)
ตาม seed คงที่ เพื่อให้ reproducible

Usage:
  python convert_wound_tissue_v1.py
วางไฟล์นี้ไว้ที่โฟลเดอร์เดียวกับ train/ (หรือ root ที่มีภาพ + _annotations.coco.json)
ที่แตกจาก zip หรือแก้ BASE_DIR ด้านล่างให้ชี้ไปที่ path ของ dataset
"""

import json
import random
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from tqdm import tqdm

# ── Config ────────────────────────────────────────────────────────────────────
BASE_DIR = Path(r"C:\VITA_Round3\datasets\wound_tissue_v1")   # แก้ path ตามเครื่อง Windows
SPLIT_SEED = 42
SPLIT_RATIOS = (0.8, 0.1, 0.1)  # train, valid, test

CLASS_MAP = {
    "Slough": 1,               # Fibrin
    "Granulation": 2,          # Granulation
    "Callus": 3,                # Callus
    "Necrotic Tissue": 4,       # Necrotic
    "Epithelial": None,         # ไม่มีคลาสตรง -> ข้าม
    "Maceration": None,
    "Other Wound Tissue": None,
    "Tendon-Bone": None,
}


def polygon_mask(size, segmentation):
    w, h = size
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    for poly in segmentation:
        if len(poly) < 6:
            continue
        pts = [(poly[i], poly[i + 1]) for i in range(0, len(poly), 2)]
        draw.polygon(pts, fill=255)
    return np.array(mask) > 0


def find_source():
    """หา _annotations.coco.json ไม่ว่าจะอยู่ที่ root หรือใต้ train/"""
    for candidate in [BASE_DIR, BASE_DIR / "train"]:
        ann = candidate / "_annotations.coco.json"
        if ann.exists():
            return candidate, ann
    return None, None


def main():
    src_dir, ann_path = find_source()
    if src_dir is None:
        print(f"[ERROR] ไม่พบ _annotations.coco.json ใต้ {BASE_DIR} หรือ {BASE_DIR / 'train'}")
        return

    coco = json.loads(ann_path.read_text(encoding="utf-8"))
    cats = {c["id"]: c["name"] for c in coco["categories"]}
    images = {im["id"]: im for im in coco["images"]}

    anns_by_image = {}
    for ann in coco["annotations"]:
        anns_by_image.setdefault(ann["image_id"], []).append(ann)

    # ── สร้าง mask ต่อภาพ (เฉพาะภาพที่มี pixel ของคลาสที่เราสนใจ) ──────────────
    kept = []  # list of (img_path, mask_array)
    for img_id, img_info in tqdm(images.items(), desc="converting"):
        img_path = src_dir / img_info["file_name"]
        if not img_path.exists():
            continue

        w, h = img_info["width"], img_info["height"]
        mask = np.zeros((h, w), dtype=np.uint8)

        for ann in anns_by_image.get(img_id, []):
            cls_name = cats.get(ann["category_id"])
            cls_id = CLASS_MAP.get(cls_name)
            if cls_id is None:
                continue
            seg = ann.get("segmentation")
            if not seg or not isinstance(seg, list):
                continue
            region = polygon_mask((w, h), seg)
            mask[region] = cls_id

        if mask.max() == 0:
            continue  # ไม่มีคลาสที่สนใจเลย -> ข้าม

        kept.append((img_path, mask))

    print(f"\nพบภาพที่ใช้ได้ {len(kept)}/{len(images)} ภาพ")

    # ── แบ่ง split แบบ deterministic ────────────────────────────────────────
    rng = random.Random(SPLIT_SEED)
    indices = list(range(len(kept)))
    rng.shuffle(indices)

    n = len(indices)
    n_train = int(n * SPLIT_RATIOS[0])
    n_valid = int(n * SPLIT_RATIOS[1])
    split_map = {}
    for i, idx in enumerate(indices):
        if i < n_train:
            split_map[idx] = "train"
        elif i < n_train + n_valid:
            split_map[idx] = "valid"
        else:
            split_map[idx] = "test"

    counts = {"train": 0, "valid": 0, "test": 0}
    for split in counts:
        out_img_dir = BASE_DIR / split
        out_mask_dir = out_img_dir / "masks"
        out_img_dir.mkdir(parents=True, exist_ok=True)
        out_mask_dir.mkdir(parents=True, exist_ok=True)

    for idx, (img_path, mask) in enumerate(kept):
        split = split_map[idx]
        out_img_dir = BASE_DIR / split
        out_mask_dir = out_img_dir / "masks"

        dest_img = out_img_dir / img_path.name
        if not dest_img.exists():
            shutil.copy2(img_path, dest_img)
        Image.fromarray(mask).save(out_mask_dir / (img_path.stem + ".png"))
        counts[split] += 1

    print("\nสรุปการแบ่ง split:")
    for split, n_split in counts.items():
        print(f"  {split}: {n_split} ภาพ")
    print(f"\nบันทึกที่ {BASE_DIR}")


if __name__ == "__main__":
    main()
