"""test_inference.py — ทดสอบโมเดลกับภาพจริง 1 ภาพ
โหลด checkpoint ล่าสุด (Round 5) รันทำนาย แล้วบันทึกภาพ overlay ให้ดูด้วยตา

Usage:
  python test_inference.py "C:\\path\\to\\your\\image.jpg"

ผลลัพธ์:
  บันทึกไฟล์ <ชื่อภาพ>_result.png ไว้ที่โฟลเดอร์เดียวกับภาพต้นฉบับ
  โครงสร้างภาพ: [ภาพต้นฉบับ | overlay การทำนาย | legend สี]
  พร้อมพิมพ์เปอร์เซ็นต์พื้นที่ของแต่ละ class ออกทาง console
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import torch
import torch.nn.functional as F
from transformers import SegformerForSemanticSegmentation

sys.stdout.reconfigure(encoding="utf-8")

# ── Config ────────────────────────────────────────────────────────────────────
NUM_CLASSES = 5
IMG_SIZE    = 512
CLASS_NAMES = ["Background", "Fibrin", "Granulation", "Callus", "Necrotic"]
DEVICE      = torch.device("cuda" if torch.cuda.is_available() else "cpu")

# pixel ที่ confidence ต่ำกว่านี้ถูกดันกลับเป็น Background — เหมือน fix ที่ทำใน
# vita-dfu-bot (segformer_segmentation.py) เพื่อลด false positive (Callus บนผิว
# ปกติ, Fibrin จากแสงไม่สม่ำเสมอ) ปรับเทียบเคียงกันได้ผ่านตัวแปรนี้
CONFIDENCE_THRESHOLD = 0.5

CLASS_COLORS = [
    (0,   0,   0),    # Background — ดำ (โปร่งใส)
    (255, 255, 0),    # Fibrin — เหลือง
    (0,   200, 0),    # Granulation — เขียว
    (200, 100, 0),    # Callus — ส้ม
    (180, 0,   0),    # Necrotic — แดงเข้ม
]

CKPT_DIR = Path(__file__).resolve().parent / "checkpoints"

# ── หา checkpoint ล่าสุดอัตโนมัติ (r5 > r4 > r3) ────────────────────────────────
def find_checkpoint():
    for name in ["segformer_b4_5class_r5_best.pth",
                 "segformer_b4_5class_r4_best.pth",
                 "segformer_b4_5class_best.pth"]:
        p = CKPT_DIR / name
        if p.exists():
            return p
    return None


def load_model(ckpt_path: Path):
    model = SegformerForSemanticSegmentation.from_pretrained(
        "nvidia/mit-b4",
        num_labels=NUM_CLASSES,
        ignore_mismatched_sizes=True,
    )
    state = torch.load(str(ckpt_path), map_location=DEVICE, weights_only=True)
    model.load_state_dict(state)
    model.to(DEVICE).eval()
    return model


def preprocess(img: Image.Image):
    img_r = img.resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
    arr = np.array(img_r, dtype=np.float32) / 255.0
    arr = (arr - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    tensor = torch.from_numpy(arr.transpose(2, 0, 1)).float().unsqueeze(0)
    return tensor


@torch.no_grad()
def predict(model, img_tensor, conf_threshold=CONFIDENCE_THRESHOLD):
    x = img_tensor.to(DEVICE)
    out = model(pixel_values=x)
    logits = F.interpolate(out.logits, size=(IMG_SIZE, IMG_SIZE), mode="bilinear", align_corners=False)
    probs = F.softmax(logits, dim=1).squeeze(0).cpu().numpy()
    pred = probs.argmax(0)
    conf = probs.max(axis=0)
    if conf_threshold > 0:
        pred = pred.copy()
        pred[conf < conf_threshold] = 0  # Background
    return pred, probs


def make_overlay(img_arr, pred, alpha=0.55):
    color_mask = np.zeros_like(img_arr)
    for c, col in enumerate(CLASS_COLORS):
        color_mask[pred == c] = col
    overlay = img_arr.copy()
    fg = pred != 0
    overlay[fg] = (img_arr[fg] * (1 - alpha) + color_mask[fg] * alpha).astype(np.uint8)
    return overlay


def make_legend(width, height=60):
    legend = Image.new("RGB", (width, height), (30, 30, 30))
    draw = ImageDraw.Draw(legend)
    try:
        font = ImageFont.truetype("arial.ttf", 16)
    except Exception:
        font = ImageFont.load_default()

    x = 10
    for name, col in zip(CLASS_NAMES, CLASS_COLORS):
        draw.rectangle([x, 18, x + 20, 38], fill=col, outline=(255, 255, 255))
        draw.text((x + 26, 20), name, fill=(255, 255, 255), font=font)
        x += 26 + len(name) * 9 + 25
    return legend


def main():
    if len(sys.argv) < 2:
        print("Usage: python test_inference.py <path_to_image> [confidence_threshold]")
        print(f"  confidence_threshold: default {CONFIDENCE_THRESHOLD} (0 = ปิดการกรอง)")
        return

    img_path = Path(sys.argv[1])
    if not img_path.exists():
        print(f"[ERROR] ไม่พบไฟล์: {img_path}")
        return

    conf_threshold = float(sys.argv[2]) if len(sys.argv) > 2 else CONFIDENCE_THRESHOLD

    ckpt_path = find_checkpoint()
    if ckpt_path is None:
        print(f"[ERROR] ไม่พบ checkpoint ใน {CKPT_DIR}")
        return

    print(f"โหลดโมเดลจาก: {ckpt_path.name}")
    model = load_model(ckpt_path)
    print(f"Device: {DEVICE}")
    print(f"Confidence threshold: {conf_threshold} ({'ปิด' if conf_threshold <= 0 else 'เปิด'})")

    img = Image.open(img_path).convert("RGB")
    orig_w, orig_h = img.size

    tensor = preprocess(img)
    pred, probs = predict(model, tensor, conf_threshold=conf_threshold)

    # ── สรุปพื้นที่แต่ละ class ────────────────────────────────────────────────
    total_px = pred.size
    print(f"\n=== ผลทำนาย: {img_path.name} ===")
    for c, name in enumerate(CLASS_NAMES):
        pct = (pred == c).sum() / total_px * 100
        conf = probs[c][pred == c].mean() * 100 if (pred == c).any() else 0.0
        print(f"  {name:<14} {pct:6.2f}%   (confidence เฉลี่ย {conf:.1f}%)")

    # ── สร้างภาพเปรียบเทียบ ──────────────────────────────────────────────────
    img_512 = np.array(img.resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR))
    overlay = make_overlay(img_512, pred)

    combined = np.concatenate([img_512, overlay], axis=1)
    combined_img = Image.fromarray(combined)

    legend = make_legend(combined_img.width)
    final = Image.new("RGB", (combined_img.width, combined_img.height + legend.height))
    final.paste(combined_img, (0, 0))
    final.paste(legend, (0, combined_img.height))

    suffix = "_result" if conf_threshold == CONFIDENCE_THRESHOLD else f"_result_conf{conf_threshold:g}"
    out_path = img_path.parent / f"{img_path.stem}{suffix}.png"
    final.save(out_path)
    print(f"\nบันทึกผลที่: {out_path}")


if __name__ == "__main__":
    main()
