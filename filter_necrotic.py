"""filter_necrotic.py
กรองเฉพาะภาพที่มี Necrotic pixel เกิน threshold แล้ว copy ไปโฟลเดอร์ใหม่

Sources รองรับ:
  1. FUSeg  — label: 2=necrotic (RGB mask หรือ grayscale)
  2. DFUTissue (dataset เดิม) — label: 4=necrotic
  3. necrotic_roboflow / necrotic_annotated — label: 4=necrotic

Usage:
  python filter_necrotic.py
ผลลัพธ์อยู่ที่ C:\\VITA_Round3\\datasets\\necrotic_filtered\\
"""

import shutil
import numpy as np
from pathlib import Path
from PIL import Image
from tqdm import tqdm

# ── Config ────────────────────────────────────────────────────────────────────
MIN_NECROTIC_PIXELS = 200   # ขั้นต่ำ pixel เนื้อตายในภาพ (ปรับได้)
OUT_DIR = Path(r"C:\VITA_Round3\datasets\necrotic_filtered")

SOURCES = [
    # (ชื่อ, img_dir, mask_dir, necrotic_class_id, mask_mode)
    # mask_mode: "gray" = grayscale mask, "rgb_green" = FUSeg RGB ที่ necrotic=green
    {
        "name": "DFUTissue",
        "img_dir":  Path(r"C:\VITA_Round3\datasets\dfu_tissue_segnet\DFUTissue\Labeled\Original\Images\TrainVal"),
        "mask_dir": Path(r"C:\VITA_Round3\datasets\dfu_tissue_segnet\DFUTissue\Labeled\Original\Annotations\TrainVal"),
        "necrotic_id": 4,
        "mask_mode": "gray",
    },
    {
        "name": "DFUTissue_Pseudo",
        "img_dir":  Path(r"C:\VITA_Round3\datasets\dfu_tissue_segnet\DFUTissue\PseudoLabeled\Images"),
        "mask_dir": Path(r"C:\VITA_Round3\datasets\dfu_tissue_segnet\DFUTissue\PseudoLabeled\Annotations"),
        "necrotic_id": 4,
        "mask_mode": "gray",
    },
    {
        "name": "NecroticRoboflow_train",
        "img_dir":  Path(r"C:\VITA_Round3\datasets\necrotic_roboflow\train\images"),
        "mask_dir": Path(r"C:\VITA_Round3\datasets\necrotic_roboflow\train\masks"),
        "necrotic_id": 4,
        "mask_mode": "gray",
    },
    {
        "name": "NecroticRoboflow_valid",
        "img_dir":  Path(r"C:\VITA_Round3\datasets\necrotic_roboflow\valid\images"),
        "mask_dir": Path(r"C:\VITA_Round3\datasets\necrotic_roboflow\valid\masks"),
        "necrotic_id": 4,
        "mask_mode": "gray",
    },
    {
        "name": "NecroticAnnotated_train",
        "img_dir":  Path(r"C:\VITA_Round3\datasets\necrotic_annotated\train\images"),
        "mask_dir": Path(r"C:\VITA_Round3\datasets\necrotic_annotated\train\masks"),
        "necrotic_id": 4,
        "mask_mode": "gray",
    },
    # FUSeg — เปิด comment ถ้ามี dataset
    # {
    #     "name": "FUSeg_train",
    #     "img_dir":  Path(r"C:\VITA_Round3\datasets\fuseg\train\images"),
    #     "mask_dir": Path(r"C:\VITA_Round3\datasets\fuseg\train\labels"),
    #     "necrotic_id": 2,   # FUSeg: 0=bg, 1=granulation, 2=necrotic
    #     "mask_mode": "gray",
    # },
    # {
    #     "name": "FUSeg_val",
    #     "img_dir":  Path(r"C:\VITA_Round3\datasets\fuseg\validation\images"),
    #     "mask_dir": Path(r"C:\VITA_Round3\datasets\fuseg\validation\labels"),
    #     "necrotic_id": 2,
    #     "mask_mode": "gray",
    # },
]

IMG_EXTS  = {".jpg", ".jpeg", ".png", ".bmp"}
MASK_EXTS = {".png", ".jpg", ".jpeg", ".bmp"}

# ── Helpers ───────────────────────────────────────────────────────────────────

def find_mask(mask_dir: Path, stem: str) -> Path | None:
    for ext in MASK_EXTS:
        p = mask_dir / (stem + ext)
        if p.exists():
            return p
    return None


def count_necrotic(mask_path: Path, necrotic_id: int, mask_mode: str) -> int:
    img = Image.open(mask_path)
    if mask_mode == "gray":
        arr = np.array(img.convert("L"))
        return int((arr == necrotic_id).sum())
    elif mask_mode == "rgb_green":
        # FUSeg บางเวอร์ชัน: necrotic=เขียว (0,128,0) หรือ (0,255,0)
        arr = np.array(img.convert("RGB"))
        green_mask = (arr[:, :, 0] < 50) & (arr[:, :, 1] > 100) & (arr[:, :, 2] < 50)
        return int(green_mask.sum())
    return 0


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    out_img  = OUT_DIR / "images"
    out_mask = OUT_DIR / "masks"
    out_img.mkdir(parents=True, exist_ok=True)
    out_mask.mkdir(parents=True, exist_ok=True)

    total_checked = 0
    total_kept    = 0

    for src in SOURCES:
        img_dir  = src["img_dir"]
        mask_dir = src["mask_dir"]
        name     = src["name"]
        nec_id   = src["necrotic_id"]
        mode     = src["mask_mode"]

        if not img_dir.exists():
            print(f"[SKIP] {name} — ไม่พบ {img_dir}")
            continue
        if not mask_dir.exists():
            print(f"[SKIP] {name} — ไม่พบ mask dir {mask_dir}")
            continue

        imgs = [p for p in img_dir.iterdir() if p.suffix.lower() in IMG_EXTS]
        kept = 0

        for img_path in tqdm(imgs, desc=name):
            mask_path = find_mask(mask_dir, img_path.stem)
            if mask_path is None:
                continue

            total_checked += 1
            try:
                n = count_necrotic(mask_path, nec_id, mode)
            except Exception:
                continue

            if n < MIN_NECROTIC_PIXELS:
                continue

            # ตั้งชื่อไม่ซ้ำ
            dest_stem = f"{name}_{img_path.stem}"
            shutil.copy2(img_path,  out_img  / (dest_stem + img_path.suffix))
            shutil.copy2(mask_path, out_mask / (dest_stem + mask_path.suffix))
            kept += 1

        total_kept += kept
        print(f"  {name}: {kept}/{len(imgs)} ภาพที่มี necrotic >= {MIN_NECROTIC_PIXELS} px")

    print(f"\nสรุป: กรองได้ {total_kept}/{total_checked} ภาพ")
    print(f"บันทึกที่ {OUT_DIR}")


if __name__ == "__main__":
    main()
