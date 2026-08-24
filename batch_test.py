"""batch_test.py — รันโมเดลกับภาพหลายภาพในโฟลเดอร์เดียว แล้วสรุปผลรวม
ใช้ logic เดียวกับ test_inference.py แต่ลูปทั้งโฟลเดอร์ + สรุปสถิติรวม

Usage:
  python batch_test.py "C:\\path\\to\\folder" [จำนวนภาพสูงสุด]

ตัวอย่าง:
  python batch_test.py "C:\\VITA_Round3\\datasets\\foot_ulcer_bbox\\test" 10
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import torch
import torch.nn.functional as F
from transformers import SegformerForSemanticSegmentation

sys.stdout.reconfigure(encoding="utf-8")

NUM_CLASSES = 5
IMG_SIZE    = 512
CLASS_NAMES = ["Background", "Fibrin", "Granulation", "Callus", "Necrotic"]
DEVICE      = torch.device("cuda" if torch.cuda.is_available() else "cpu")

CLASS_COLORS = [
    (0,   0,   0),
    (255, 255, 0),
    (0,   200, 0),
    (200, 100, 0),
    (180, 0,   0),
]

CKPT_DIR = Path(__file__).resolve().parent / "checkpoints"


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
        "nvidia/mit-b4", num_labels=NUM_CLASSES, ignore_mismatched_sizes=True,
    )
    state = torch.load(str(ckpt_path), map_location=DEVICE, weights_only=True)
    model.load_state_dict(state)
    model.to(DEVICE).eval()
    return model


def preprocess(img: Image.Image):
    img_r = img.resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
    arr = np.array(img_r, dtype=np.float32) / 255.0
    arr = (arr - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    return torch.from_numpy(arr.transpose(2, 0, 1)).float().unsqueeze(0)


@torch.no_grad()
def predict(model, img_tensor):
    x = img_tensor.to(DEVICE)
    out = model(pixel_values=x)
    logits = F.interpolate(out.logits, size=(IMG_SIZE, IMG_SIZE), mode="bilinear", align_corners=False)
    probs = F.softmax(logits, dim=1).squeeze(0).cpu().numpy()
    return probs.argmax(0), probs


def make_overlay(img_arr, pred, alpha=0.55):
    color_mask = np.zeros_like(img_arr)
    for c, col in enumerate(CLASS_COLORS):
        color_mask[pred == c] = col
    overlay = img_arr.copy()
    fg = pred != 0
    overlay[fg] = (img_arr[fg] * (1 - alpha) + color_mask[fg] * alpha).astype(np.uint8)
    return overlay


def make_legend(width, height=50):
    legend = Image.new("RGB", (width, height), (30, 30, 30))
    draw = ImageDraw.Draw(legend)
    try:
        font = ImageFont.truetype("arial.ttf", 14)
    except Exception:
        font = ImageFont.load_default()
    x = 10
    for name, col in zip(CLASS_NAMES, CLASS_COLORS):
        draw.rectangle([x, 15, x + 16, 31], fill=col, outline=(255, 255, 255))
        draw.text((x + 22, 16), name, fill=(255, 255, 255), font=font)
        x += 22 + len(name) * 8 + 20
    return legend


def main():
    if len(sys.argv) < 2:
        print("Usage: python batch_test.py <folder> [max_images]")
        return

    folder = Path(sys.argv[1])
    max_images = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    if not folder.exists():
        print(f"[ERROR] ไม่พบโฟลเดอร์: {folder}")
        return

    ckpt_path = find_checkpoint()
    if ckpt_path is None:
        print(f"[ERROR] ไม่พบ checkpoint ใน {CKPT_DIR}")
        return

    print(f"โหลดโมเดลจาก: {ckpt_path.name}")
    model = load_model(ckpt_path)
    print(f"Device: {DEVICE}")

    out_dir = folder / "batch_results"
    out_dir.mkdir(exist_ok=True)

    img_paths = sorted([p for p in folder.iterdir()
                         if p.suffix.lower() in {".jpg", ".jpeg", ".png"}])[:max_images]

    if not img_paths:
        print(f"[ERROR] ไม่พบภาพในโฟลเดอร์ {folder}")
        return

    print(f"\nพบภาพ {len(img_paths)} ภาพ กำลังประมวลผล...\n")

    rows = []
    total_area = np.zeros(NUM_CLASSES)

    for img_path in img_paths:
        img = Image.open(img_path).convert("RGB")
        tensor = preprocess(img)
        pred, probs = predict(model, tensor)

        total_px = pred.size
        pcts = [(pred == c).sum() / total_px * 100 for c in range(NUM_CLASSES)]
        total_area += np.array(pcts)
        rows.append((img_path.name, pcts))

        img_512 = np.array(img.resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR))
        overlay = make_overlay(img_512, pred)
        combined = np.concatenate([img_512, overlay], axis=1)
        combined_img = Image.fromarray(combined)
        legend = make_legend(combined_img.width)
        final = Image.new("RGB", (combined_img.width, combined_img.height + legend.height))
        final.paste(combined_img, (0, 0))
        final.paste(legend, (0, combined_img.height))
        final.save(out_dir / f"{img_path.stem}_result.png")

        print(f"  {img_path.name[:50]:<50}  BG={pcts[0]:5.1f}%  Fib={pcts[1]:5.1f}%  "
              f"Gran={pcts[2]:5.1f}%  Callus={pcts[3]:5.1f}%  Necro={pcts[4]:5.1f}%")

    print(f"\n{'='*70}")
    print("สรุปเฉลี่ยรวมทุกภาพ (% พื้นที่เฉลี่ย)")
    print(f"{'='*70}")
    avg = total_area / len(rows)
    for c, name in enumerate(CLASS_NAMES):
        print(f"  {name:<14} {avg[c]:6.2f}%")

    print(f"\nบันทึกภาพผลลัพธ์ทั้งหมดที่: {out_dir}/")
    print("เปิดดูภาพทีละไฟล์เพื่อเช็คว่า overlay ตรงตำแหน่งแผลจริงไหม")


if __name__ == "__main__":
    main()
