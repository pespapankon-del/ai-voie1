"""evaluate_holdout.py — ประเมิน Round 5 บนภาพที่โมเดล "ไม่เคยเห็นเลย"

ต่างจาก evaluate_round4.py ตรงที่ script นี้วัดผลเฉพาะ test/ split ของ
seg_ulcer และ foot_callus เท่านั้น — สอง split นี้ไม่เคยถูกใช้ตอนเทรน Round 5
เลย (train_segformer_round5.py ใช้แค่ train/ กับ valid/) จึงเป็นการวัดผลที่
สะอาดจริง ไม่มี data leakage ต่างจาก necrotic_roboflow/necrotic_annotated
ที่ evaluate_round4.py ต้องยืมภาพจาก train/masks/ มาวัด (เพราะ valid/ ไม่มี
mask ให้) ซึ่งมีความเสี่ยงเห็นภาพซ้ำกับตอนเทรน

Usage:
  python evaluate_holdout.py
"""

import json, sys
import numpy as np
from pathlib import Path
from PIL import Image
from tqdm import tqdm

import torch
import torch.nn.functional as F
from transformers import SegformerForSemanticSegmentation

sys.stdout.reconfigure(encoding="utf-8")

# ── Paths ────────────────────────────────────────────────────────────────────
BASE = Path(__file__).resolve().parent

SEG_ULCER_TEST   = Path(r"C:\VITA_Round3\datasets\seg_ulcer\test")
FOOT_CALLUS_TEST = Path(r"C:\VITA_Round3\datasets\foot_callus\test")

CKPT_DIR  = BASE / "checkpoints"
CKPT_PATH = CKPT_DIR / "segformer_b4_5class_r5_best.pth"
VIZ_DIR   = BASE / "eval_viz_holdout"
VIZ_DIR.mkdir(exist_ok=True)

# ── Config ───────────────────────────────────────────────────────────────────
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

# ── Dataset helper ───────────────────────────────────────────────────────────

def load_image(path: Path):
    img = Image.open(path).convert("RGB").resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
    arr = np.array(img, dtype=np.float32) / 255.0
    arr = (arr - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    return torch.from_numpy(arr.transpose(2, 0, 1)).float()


def load_mask(path: Path):
    mask = Image.open(path).convert("L").resize((IMG_SIZE, IMG_SIZE), Image.NEAREST)
    return np.array(mask, dtype=np.int64)


def build_test_split(test_dir: Path):
    """images อยู่ที่ root ของ test/ + masks/ subfolder (จาก convert_*.py)"""
    mask_dir = test_dir / "masks"
    if not test_dir.exists() or not mask_dir.exists():
        return []
    pairs = []
    for img_p in sorted(test_dir.iterdir()):
        if img_p.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        mask_p = mask_dir / (img_p.stem + ".png")
        if mask_p.exists():
            pairs.append((img_p, mask_p))
    return pairs


# ── Metrics ──────────────────────────────────────────────────────────────────

class SegMetrics:
    def __init__(self, n=NUM_CLASSES):
        self.n = n
        self.tp = np.zeros(n)
        self.fp = np.zeros(n)
        self.fn = np.zeros(n)

    def update(self, pred, gt):
        for c in range(self.n):
            p = (pred == c)
            g = (gt == c)
            self.tp[c] += (p & g).sum()
            self.fp[c] += (p & ~g).sum()
            self.fn[c] += (~p & g).sum()

    def dice(self):
        return 2 * self.tp / (2 * self.tp + self.fp + self.fn + 1e-8)

    def iou(self):
        return self.tp / (self.tp + self.fp + self.fn + 1e-8)

    def precision(self):
        return self.tp / (self.tp + self.fp + 1e-8)

    def recall(self):
        return self.tp / (self.tp + self.fn + 1e-8)

    def mean_fg_dice(self):
        return self.dice()[1:].mean()


# ── Model ────────────────────────────────────────────────────────────────────

def load_model():
    model = SegformerForSemanticSegmentation.from_pretrained(
        "nvidia/mit-b4",
        num_labels=NUM_CLASSES,
        ignore_mismatched_sizes=True,
    )
    state = torch.load(str(CKPT_PATH), map_location=DEVICE, weights_only=True)
    model.load_state_dict(state)
    model.to(DEVICE).eval()
    return model


@torch.no_grad()
def predict(model, img_tensor):
    x = img_tensor.unsqueeze(0).to(DEVICE)
    out = model(pixel_values=x)
    logits = F.interpolate(out.logits, size=(IMG_SIZE, IMG_SIZE), mode="bilinear", align_corners=False)
    return logits.squeeze(0).argmax(0).cpu().numpy()


def save_overlay(img_path, pred, gt, save_path):
    img = Image.open(img_path).convert("RGB").resize((IMG_SIZE, IMG_SIZE))
    img_arr = np.array(img)
    pred_color = np.zeros_like(img_arr)
    gt_color   = np.zeros_like(img_arr)
    for c, col in enumerate(CLASS_COLORS):
        pred_color[pred == c] = col
        gt_color[gt == c]     = col
    blend_pred = (img_arr * 0.5 + pred_color * 0.5).astype(np.uint8)
    blend_gt   = (img_arr * 0.5 + gt_color   * 0.5).astype(np.uint8)
    combined = np.concatenate([img_arr, blend_gt, blend_pred], axis=1)
    Image.fromarray(combined).save(save_path)


def evaluate_dataset(model, pairs, name, max_viz=5):
    metrics = SegMetrics()
    viz_count = 0
    for img_p, mask_p in tqdm(pairs, desc=name):
        try:
            img_t = load_image(img_p)
            gt    = load_mask(mask_p)
            pred  = predict(model, img_t)
            metrics.update(pred, gt)
            if viz_count < max_viz:
                save_overlay(img_p, pred, gt, VIZ_DIR / f"{name}_{viz_count:02d}.png")
                viz_count += 1
        except Exception as e:
            print(f"  [WARN] {img_p.name}: {e}")
    return metrics


def print_metrics(name, m):
    dice, iou, prec, rec = m.dice(), m.iou(), m.precision(), m.recall()
    print(f"\n{'='*70}")
    print(f"  {name}  (holdout — โมเดลไม่เคยเห็นภาพชุดนี้เลย)")
    print(f"{'='*70}")
    print(f"  {'Class':<14} {'Dice':>7} {'IoU':>7} {'Prec':>7} {'Recall':>7}")
    print(f"  {'-'*44}")
    for i, cn in enumerate(CLASS_NAMES):
        print(f"  {cn:<14} {dice[i]:>7.4f} {iou[i]:>7.4f} {prec[i]:>7.4f} {rec[i]:>7.4f}")
    print(f"  {'-'*44}")
    print(f"  {'meanFG Dice':<14} {m.mean_fg_dice():>7.4f}")


def main():
    if not CKPT_PATH.exists():
        print(f"[ERROR] ไม่พบ checkpoint: {CKPT_PATH}")
        return

    print(f"โหลดโมเดลจาก {CKPT_PATH.name} ...")
    model = load_model()
    print(f"Device: {DEVICE}")

    datasets = [
        ("SegUlcer_HOLDOUT",   build_test_split(SEG_ULCER_TEST)),
        ("FootCallus_HOLDOUT", build_test_split(FOOT_CALLUS_TEST)),
    ]

    all_metrics = {}
    combined = SegMetrics()

    for name, pairs in datasets:
        if not pairs:
            print(f"\n[SKIP] {name} — ไม่พบข้อมูล (รัน convert_seg_ulcer.py / convert_foot_callus.py ก่อน)")
            continue
        print(f"\n{name}: {len(pairs)} ภาพ (ไม่เคยเทรนเลย)")
        m = evaluate_dataset(model, pairs, name)
        print_metrics(name, m)
        all_metrics[name] = {
            "dice": m.dice().tolist(), "iou": m.iou().tolist(),
            "precision": m.precision().tolist(), "recall": m.recall().tolist(),
            "meanFG": float(m.mean_fg_dice()), "n_images": len(pairs),
        }
        combined.tp += m.tp
        combined.fp += m.fp
        combined.fn += m.fn

    print_metrics("Overall Holdout (Combined)", combined)
    all_metrics["Overall"] = {
        "dice": combined.dice().tolist(), "iou": combined.iou().tolist(),
        "precision": combined.precision().tolist(), "recall": combined.recall().tolist(),
        "meanFG": float(combined.mean_fg_dice()),
    }
    all_metrics["class_names"] = CLASS_NAMES
    all_metrics["note"] = ("ทุกภาพในนี้มาจาก test/ split ที่ train_segformer_round5.py "
                            "ไม่เคยใช้เทรนหรือ validate เลย — เป็นค่าที่ไม่มี data leakage")

    out = BASE / "eval_results_holdout.json"
    out.write_text(json.dumps(all_metrics, indent=2, ensure_ascii=False))
    print(f"\nบันทึกผลที่ {out}")
    print(f"Visualization อยู่ที่ {VIZ_DIR}/")


if __name__ == "__main__":
    main()
