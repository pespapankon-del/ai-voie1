"""convert_foot_callus.py — แปลง Foot Callus Detection (COCO polygon) เป็น grayscale mask
รองรับ dataset: Foot Callus Detection v1 (foot-callus-detection, Roboflow Universe)
Classes ต้นทาง: Foot-Callus (catch-all), normal foot, stage-1, stage-2, stage-3, stage-4

Mapping ไปยัง 5-class ของ VITA:
  stage-1..stage-4 -> 3 (Callus)
  normal foot       -> 0 (Background) — ไม่ระบาย (เว้นเป็น background)
  Foot-Callus (catch-all) -> ข้าม

หมายเหตุ: มีภาพที่ไม่มี annotation เลย (unlabeled) — ข้ามไปโดยอัตโนมัติ
เพราะไม่มี segmentation ให้แปลง

Usage:
  python convert_foot_callus.py
วางไฟล์นี้ไว้ที่โฟลเดอร์เดียวกับ train/ valid/ test/ (โฟลเดอร์ที่แตกจาก zip)
หรือแก้ BASE_DIR ด้านล่างให้ชี้ไปที่ path ของ dataset
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from tqdm import tqdm

# ── Config ────────────────────────────────────────────────────────────────────
BASE_DIR = Path(r"C:\VITA_Round3\datasets\foot_callus")   # แก้ path ตามเครื่อง Windows

CLASS_MAP = {
    "stage-1": 3,        # Callus
    "stage-2": 3,        # Callus
    "stage-3": 3,        # Callus
    "stage-4": 3,        # Callus
    "normal foot": 0,     # ไม่มี callus -> background (ไม่วาด)
    "Foot-Callus": None,  # catch-all -> ข้าม
}

SPLITS = ["train", "valid", "test"]


def polygon_mask(size, segmentation):
    """วาด polygon(s) จาก COCO segmentation list ลงบน mask เดี่ยว"""
    w, h = size
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    for poly in segmentation:
        if len(poly) < 6:
            continue
        pts = [(poly[i], poly[i + 1]) for i in range(0, len(poly), 2)]
        draw.polygon(pts, fill=255)
    return np.array(mask) > 0


def convert_split(split_dir: Path):
    ann_path = split_dir / "_annotations.coco.json"
    if not ann_path.exists():
        print(f"[SKIP] {split_dir} — ไม่พบ _annotations.coco.json")
        return 0

    coco = json.loads(ann_path.read_text(encoding="utf-8"))
    cats = {c["id"]: c["name"] for c in coco["categories"]}
    images = {im["id"]: im for im in coco["images"]}

    anns_by_image = {}
    for ann in coco["annotations"]:
        anns_by_image.setdefault(ann["image_id"], []).append(ann)

    mask_dir = split_dir / "masks"
    mask_dir.mkdir(exist_ok=True)

    kept = 0
    for img_id, img_info in tqdm(images.items(), desc=split_dir.name):
        anns = anns_by_image.get(img_id)
        if not anns:
            continue  # ภาพไม่มี annotation -> ข้าม

        img_path = split_dir / img_info["file_name"]
        if not img_path.exists():
            continue

        w, h = img_info["width"], img_info["height"]
        mask = np.zeros((h, w), dtype=np.uint8)

        for ann in anns:
            cls_name = cats.get(ann["category_id"])
            cls_id = CLASS_MAP.get(cls_name)
            if cls_id is None or cls_id == 0:
                continue
            seg = ann.get("segmentation")
            if not seg or not isinstance(seg, list):
                continue
            region = polygon_mask((w, h), seg)
            mask[region] = cls_id

        if mask.max() == 0:
            # มีแต่ "normal foot" (ไม่มี callus จริง) -> ข้าม ไม่บันทึกเป็น background
            continue

        out_path = mask_dir / (img_path.stem + ".png")
        Image.fromarray(mask).save(out_path)
        kept += 1

    print(f"  {split_dir.name}: บันทึก {kept} masks ที่ {mask_dir}")
    return kept


def main():
    if not BASE_DIR.exists():
        print(f"[ERROR] ไม่พบ {BASE_DIR}")
        return

    total = 0
    for split in SPLITS:
        split_dir = BASE_DIR / split
        if split_dir.exists():
            total += convert_split(split_dir)
        else:
            print(f"[SKIP] {split_dir} — ไม่พบโฟลเดอร์")

    print(f"\nรวม {total} masks")


if __name__ == "__main__":
    main()
