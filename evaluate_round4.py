"""evaluate_round4.py — ประเมินผล SegFormer-B4 Round 4
รันบน validation set ทั้ง 3 ชุด แล้วรายงาน Dice / IoU / Precision / Recall per-class
บันทึกผลลง eval_results_r4.json และ visualize ตัวอย่าง 5 ภาพ

Usage:
  python evaluate_round4.py
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

# ── Paths (เหมือนใน train_segformer_round4.py) ────────────────────────────────
BASE      = Path(__file__).resolve().parent
DFUT      = BASE / "datasets/dfu_tissue_segnet/DFUTissue"
IMG_DIR   = DFUT / "Labeled/Original/Images/TrainVal"
MASK_DIR  = DFUT / "Labeled/Original/Annotations/TrainVal"
VAL_LIST  = DFUT / "Labeled/labeled_val_names.txt"

NECROTIC_BASE = Path(r"C:\VITA_Round3\datasets\necrotic_roboflow")
NECROTIC_VALID = NECROTIC_BASE / "valid"

NECROTIC_ANN_BASE  = Path(r"C:\VITA_Round3\datasets\necrotic_annotated")
NECROTIC_ANN_VALID = NECROTIC_ANN_BASE / "valid"

CKPT_DIR  = Path(__file__).resolve().parent / "checkpoints"
CKPT_PATH = CKPT_DIR / "segformer_b4_5class_r4_best.pth"
VIZ_DIR   = Path(__file__).resolve().parent / "eval_viz_r4"
VIZ_DIR.mkdir(exist_ok=True)

# ── Config ────────────────────────────────────────────────────────────────────
NUM_CLASSES = 5
IMG_SIZE    = 512
CLASS_NAMES = ["Background", "Fibrin", "Granulation", "Callus", "Necrotic"]
DEVICE      = torch.device("cuda" if torch.cuda.is_available() else "cpu")

# สี overlay (BGR-ish สำหรับ PIL RGB)
CLASS_COLORS = [
    (0,   0,   0),    # Background — ดำ
    (255, 255, 0),    # Fibrin — เหลือง
    (0,   200, 0),    # Granulation — เขียว
    (200, 100, 0),    # Callus — ส้ม
    (180, 0,   0),    # Necrotic — แดงเข้ม
]

# ── Dataset helpers ───────────────────────────────────────────────────────────

def load_image(path: Path):
    img = Image.open(path).convert("RGB").resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
    arr = np.array(img, dtype=np.float32) / 255.0
    arr = (arr - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    return torch.from_numpy(arr.transpose(2, 0, 1)).float()


def load_mask(path: Path):
    mask = Image.open(path).convert("L").resize((IMG_SIZE, IMG_SIZE), Image.NEAREST)
    return np.array(mask, dtype=np.int64)


def find_mask(mask_dir: Path, stem: str):
    for ext in [".png", ".jpg", ".jpeg", ".bmp"]:
        p = mask_dir / (stem + ext)
        if p.exists():
            return p
    return None


def build_dfutissue_val():
    if not VAL_LIST.exists():
        return []
    names = [l.strip() for l in VAL_LIST.read_text().splitlines() if l.strip()]
    pairs = []
    for n in names:
        img_p  = find_mask(IMG_DIR,  n)
        mask_p = find_mask(MASK_DIR, n)
        if img_p and mask_p:
            pairs.append((img_p, mask_p))
    return pairs


def build_roboflow_val(valid_dir: Path):
    img_dir  = valid_dir / "images"
    mask_dir = valid_dir / "masks"
    if not img_dir.exists() or not mask_dir.exists():
        return []
    pairs = []
    for img_p in img_dir.iterdir():
        if img_p.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        mask_p = find_mask(mask_dir, img_p.stem)
        if mask_p:
            pairs.append((img_p, mask_p))
    return pairs


# ── Metrics ───────────────────────────────────────────────────────────────────

class SegMetrics:
    def __init__(self, n=NUM_CLASSES):
        self.n = n
        self.tp = np.zeros(n)
        self.fp = np.zeros(n)
        self.fn = np.zeros(n)

    def update(self, pred: np.ndarray, gt: np.ndarray):
        for c in range(self.n):
            p = (pred == c)
            g = (gt   == c)
            self.tp[c] += (p & g).sum()
            self.fp[c] += (p & ~g).sum()
            self.fn[c] += (~p & g).sum()

    def dice(self):
        return 2*self.tp / (2*self.tp + self.fp + self.fn + 1e-8)

    def iou(self):
        return self.tp / (self.tp + self.fp + self.fn + 1e-8)

    def precision(self):
        return self.tp / (self.tp + self.fp + 1e-8)

    def recall(self):
        return self.tp / (self.tp + self.fn + 1e-8)

    def mean_fg_dice(self):
        return self.dice()[1:].mean()


# ── Model ─────────────────────────────────────────────────────────────────────

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


# ── Visualize ─────────────────────────────────────────────────────────────────

def save_overlay(img_path: Path, pred: np.ndarray, gt: np.ndarray, save_path: Path):
    img = Image.open(img_path).convert("RGB").resize((IMG_SIZE, IMG_SIZE))
    img_arr = np.array(img)

    pred_color = np.zeros_like(img_arr)
    gt_color   = np.zeros_like(img_arr)
    for c, col in enumerate(CLASS_COLORS):
        pred_color[pred == c] = col
        gt_color[gt   == c]   = col

    blend_pred = (img_arr * 0.5 + pred_color * 0.5).astype(np.uint8)
    blend_gt   = (img_arr * 0.5 + gt_color   * 0.5).astype(np.uint8)

    combined = np.concatenate([img_arr, blend_gt, blend_pred], axis=1)
    Image.fromarray(combined).save(save_path)


# ── Evaluate one dataset ───────────────────────────────────────────────────────

def evaluate_dataset(model, pairs, name: str, max_viz=5):
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


# ── Main ──────────────────────────────────────────────────────────────────────

def print_metrics(name: str, m: SegMetrics):
    dice = m.dice()
    iou  = m.iou()
    prec = m.precision()
    rec  = m.recall()
    print(f"\n{'='*70}")
    print(f"  {name}")
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

    print(f"โหลดโมเดลจาก {CKPT_PATH} ...")
    model = load_model()
    print(f"Device: {DEVICE}")

    datasets = [
        ("DFUTissue",   build_dfutissue_val()),
        ("NecroDS",     build_roboflow_val(NECROTIC_VALID)),
        ("NecroV2",     build_roboflow_val(NECROTIC_ANN_VALID)),
    ]

    all_metrics = {}
    combined    = SegMetrics()

    for name, pairs in datasets:
        if not pairs:
            print(f"\n[SKIP] {name} — ไม่พบข้อมูล")
            continue
        print(f"\n{name}: {len(pairs)} ภาพ")
        m = evaluate_dataset(model, pairs, name)
        print_metrics(name, m)
        all_metrics[name] = {
            "dice":      m.dice().tolist(),
            "iou":       m.iou().tolist(),
            "precision": m.precision().tolist(),
            "recall":    m.recall().tolist(),
            "meanFG":    float(m.mean_fg_dice()),
        }
        combined.tp += m.tp
        combined.fp += m.fp
        combined.fn += m.fn

    print_metrics("Overall (Combined)", combined)
    all_metrics["Overall"] = {
        "dice":      combined.dice().tolist(),
        "iou":       combined.iou().tolist(),
        "precision": combined.precision().tolist(),
        "recall":    combined.recall().tolist(),
        "meanFG":    float(combined.mean_fg_dice()),
    }
    all_metrics["class_names"] = CLASS_NAMES

    out = Path(__file__).resolve().parent / "eval_results_r4.json"
    out.write_text(json.dumps(all_metrics, indent=2, ensure_ascii=False))
    print(f"\nบันทึกผลที่ {out}")
    print(f"Visualization อยู่ที่ {VIZ_DIR}/")

    necro_overall = combined.dice()[4]
    meanfg_overall = combined.mean_fg_dice()
    print(f"\n{'='*40}")
    print(f"  Overall meanFG Dice : {meanfg_overall:.4f}  {'✅' if meanfg_overall > 0.82 else '❌'} (เป้า > 0.82)")
    print(f"  Overall Necrotic    : {necro_overall:.4f}  {'✅' if necro_overall  > 0.70 else '❌'} (เป้า > 0.70)")
    print(f"{'='*40}")


if __name__ == "__main__":
    main()
