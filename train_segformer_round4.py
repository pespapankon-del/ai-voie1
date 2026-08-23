"""train_segformer_round4.py — SegFormer-B4, 5-Class Round 4
Classes : 0=Background  1=Fibrin  2=Granulation  3=Callus  4=Necrotic
Changes vs Round 3:
  - Combined CE + Dice loss (dice_weight=0.5) — directly optimises the tracking metric
  - AdamW + CosineAnnealingWarmRestarts instead of Adam + ReduceLROnPlateau
  - Loads from Round 3 best (segformer_b4_5class_best.pth) with strict=True
  - Saves to segformer_b4_5class_r4_best.pth (does NOT overwrite Round 3)
  - Per-dataset val Dice printed each epoch for easier debugging
  - history saved to history_5class_r4.json
"""

import sys, json
import numpy as np
from pathlib import Path
from PIL import Image
from tqdm import tqdm

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader, ConcatDataset, WeightedRandomSampler
from torch.optim.lr_scheduler import CosineAnnealingWarmRestarts
from torch.cuda.amp import autocast, GradScaler

import albumentations as A
from albumentations.pytorch import ToTensorV2
from transformers import SegformerForSemanticSegmentation

sys.stdout.reconfigure(encoding='utf-8')

# ── Paths ────────────────────────────────────────────────────────────────────
BASE       = Path(__file__).resolve().parent.parent
DFUT       = BASE / "datasets/dfu_tissue_segnet/DFUTissue"
IMG_DIR    = DFUT / "Labeled/Original/Images/TrainVal"
MASK_DIR   = DFUT / "Labeled/Original/Annotations/TrainVal"
TRAIN_LIST = DFUT / "Labeled/labeled_train_names.txt"
VAL_LIST   = DFUT / "Labeled/labeled_val_names.txt"
PSEUDO_IMG  = DFUT / "PseudoLabeled/Images"
PSEUDO_MASK = DFUT / "PseudoLabeled/Annotations"

NECROTIC_BASE  = Path(r"C:\Users\papan\Desktop\VITA_Project_Files\datasets\necrotic_roboflow")
NECROTIC_TRAIN = NECROTIC_BASE / "train"
NECROTIC_VALID = NECROTIC_BASE / "valid"

NECROTIC_ANN_BASE  = Path(r"C:\Users\papan\Desktop\VITA_Project_Files\datasets\necrotic_annotated")
NECROTIC_ANN_TRAIN = NECROTIC_ANN_BASE / "train"
NECROTIC_ANN_VALID = NECROTIC_ANN_BASE / "valid"

SAVE_DIR = Path(__file__).resolve().parent / "checkpoints"
SAVE_DIR.mkdir(exist_ok=True)

# Load from Round 3 best; save to separate R4 file so R3 is preserved
ROUND3_CKPT = SAVE_DIR / "segformer_b4_5class_best.pth"
SAVE_BEST   = SAVE_DIR / "segformer_b4_5class_r4_best.pth"
PHASE3_CKPT = SAVE_DIR / "segformer_b4_best.pth"  # fallback: 4-class encoder

# ── Config ───────────────────────────────────────────────────────────────────
IMG_SIZE     = 512
BATCH_SIZE   = 4
NUM_CLASSES  = 5
EPOCHS       = 50
LR           = 1e-5        # lower than R3 (2e-5) — fine-tune at end of schedule
WEIGHT_DECAY = 1e-4        # AdamW decoupled decay
DICE_WEIGHT  = 0.5         # loss = (1-DICE_WEIGHT)*CE + DICE_WEIGHT*Dice

# Same class weights as Round 3
CLASS_WEIGHTS = torch.tensor([0.3, 6.0, 2.5, 1.2, 8.0], dtype=torch.float32)
CLASS_NAMES   = ["Background", "Fibrin", "Granulation", "Callus", "Necrotic"]

# ── Augmentations ─────────────────────────────────────────────────────────────
def get_train_transforms():
    return A.Compose([
        A.Resize(IMG_SIZE, IMG_SIZE),
        A.OneOf([A.HorizontalFlip(p=0.5), A.VerticalFlip(p=0.5)], p=0.8),
        A.OneOf([
            A.Affine(translate_percent=0.1, scale=(0.95, 1.05), rotate=(-10, 10), p=0.6),
            A.Affine(shear=(-5, 5), p=0.2),
            A.RandomScale(scale_limit=0.1, p=0.1),
        ], p=0.9),
        A.OneOf([
            A.GaussNoise(p=0.2),
            A.Blur(blur_limit=3, p=0.2),
            A.MotionBlur(blur_limit=3, p=0.2),
            A.Sharpen(p=0.2),
            A.Perspective(scale=(0.02, 0.05), p=0.2),
        ], p=0.5),
        A.OneOf([
            A.CLAHE(clip_limit=2.0, p=0.25),
            A.RandomBrightnessContrast(brightness_limit=0.2, contrast_limit=0.2, p=0.25),
            A.HueSaturationValue(hue_shift_limit=10, sat_shift_limit=20, p=0.25),
            A.RandomGamma(gamma_limit=(80, 120), p=0.25),
        ], p=0.3),
        A.Resize(IMG_SIZE, IMG_SIZE),
        A.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ToTensorV2(),
    ])

def get_val_transforms():
    return A.Compose([
        A.Resize(IMG_SIZE, IMG_SIZE),
        A.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ToTensorV2(),
    ])

# ── Datasets ──────────────────────────────────────────────────────────────────
class DFUTissueDataset(Dataset):
    """DFUTissue labeled/pseudo masks — classes 0-3"""
    def __init__(self, img_dir, mask_dir, names, transform=None, is_pseudo=False):
        self.transform = transform
        self.is_pseudo = is_pseudo
        img_dir  = Path(img_dir)
        mask_dir = Path(mask_dir)
        self.pairs = []
        for stem in names:
            for ext in [".jpg", ".jpeg", ".png"]:
                p = img_dir / (stem + ext)
                if p.exists():
                    m = mask_dir / (stem + ".png")
                    if m.exists():
                        try:
                            if Image.open(m).mode == "L":
                                self.pairs.append((p, m))
                        except Exception:
                            pass
                    break

        self.sample_weights = []
        for _, mp in self.pairs:
            arr = np.array(Image.open(mp))
            w = 1.0
            if (arr == 1).sum() > 50:
                w = 5.0
            elif (arr == 2).sum() > 50:
                w = 2.5
            elif (arr == 3).sum() > 50:
                w = 1.5
            self.sample_weights.append(w)

    def __len__(self): return len(self.pairs)

    def __getitem__(self, i):
        img_path, mask_path = self.pairs[i]
        img  = np.array(Image.open(img_path).convert("RGB"))
        mask = np.array(Image.open(mask_path))
        mask = np.clip(mask, 0, NUM_CLASSES - 1).astype(np.uint8)
        if self.transform:
            aug  = self.transform(image=img, mask=mask)
            img  = aug["image"]
            mask = torch.tensor(aug["mask"].numpy().astype(np.int64), dtype=torch.long)
        return {"image": img, "mask": mask, "is_pseudo": self.is_pseudo}


class NecroticDataset(Dataset):
    """Necrotic images with converted PNG masks — class 4 = Necrotic"""
    def __init__(self, split_dir, transform=None):
        self.transform = transform
        split_dir = Path(split_dir)
        mask_dir  = split_dir / "masks"
        self.pairs = []
        for img_path in sorted(split_dir.iterdir()):
            if img_path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
                continue
            m = mask_dir / (img_path.stem + ".png")
            if m.exists():
                self.pairs.append((img_path, m))
        self.sample_weights = [6.0] * len(self.pairs)

    def __len__(self): return len(self.pairs)

    def __getitem__(self, i):
        img_path, mask_path = self.pairs[i]
        img  = np.array(Image.open(img_path).convert("RGB"))
        mask = np.array(Image.open(mask_path))
        mask = np.clip(mask, 0, NUM_CLASSES - 1).astype(np.uint8)
        if self.transform:
            aug  = self.transform(image=img, mask=mask)
            img  = aug["image"]
            mask = torch.tensor(aug["mask"].numpy().astype(np.int64), dtype=torch.long)
        return {"image": img, "mask": mask, "is_pseudo": False}


def load_names(txt_path):
    return [l.strip() for l in Path(txt_path).read_text().splitlines() if l.strip()]

# ── Loss ──────────────────────────────────────────────────────────────────────
class CombinedCEDiceLoss(nn.Module):
    """Weighted CE + multi-class Dice. Dice directly optimises the val metric."""
    def __init__(self, class_weights=None, dice_weight=0.5, eps=1e-6):
        super().__init__()
        self.cw          = class_weights
        self.dice_weight = dice_weight
        self.eps         = eps

    def forward(self, logits, targets, is_pseudo=False):
        # CE part (with optional pseudo-label confidence weighting)
        ce = F.cross_entropy(logits, targets,
                             weight=self.cw.to(logits.device) if self.cw is not None else None,
                             reduction="none")
        if is_pseudo:
            conf = F.softmax(logits.detach(), dim=1).max(dim=1).values
            ce   = ce * conf
        ce_loss = ce.mean()

        # Dice part — soft multi-class Dice over probabilities
        probs  = F.softmax(logits, dim=1)                       # (B, C, H, W)
        onehot = F.one_hot(targets, NUM_CLASSES).permute(0, 3, 1, 2).float()  # (B, C, H, W)
        inter  = (probs * onehot).sum(dim=(0, 2, 3))
        union  = (probs + onehot).sum(dim=(0, 2, 3))
        dice_per_cls = (2 * inter + self.eps) / (union + self.eps)  # (C,)
        # Weight Dice by same class weights (skip BG)
        if self.cw is not None:
            cw = self.cw.to(logits.device)
            dice_loss = 1 - (dice_per_cls[1:] * cw[1:]).sum() / cw[1:].sum()
        else:
            dice_loss = 1 - dice_per_cls[1:].mean()

        return (1 - self.dice_weight) * ce_loss + self.dice_weight * dice_loss

# ── Metrics ───────────────────────────────────────────────────────────────────
def dice_per_class(pred, target, num_classes=NUM_CLASSES, eps=1e-6):
    scores = []
    for c in range(num_classes):
        p = (pred == c).float()
        t = (target == c).float()
        scores.append(((2 * (p * t).sum() + eps) / (p.sum() + t.sum() + eps)).item())
    return scores

def eval_loader(model, loader, device):
    """Returns per-class dice lists."""
    model.eval()
    all_dice = [[] for _ in range(NUM_CLASSES)]
    with torch.no_grad():
        for batch in loader:
            imgs  = batch["image"].to(device)
            masks = batch["mask"].to(device)
            with autocast():
                logits    = model(pixel_values=imgs).logits
                logits_up = F.interpolate(logits, size=masks.shape[-2:],
                                          mode="bilinear", align_corners=False)
            preds = logits_up.argmax(dim=1)
            for ci, d in enumerate(dice_per_class(preds, masks)):
                all_dice[ci].append(d)
    return [float(np.mean(all_dice[c])) for c in range(NUM_CLASSES)]

# ── Training ──────────────────────────────────────────────────────────────────
def train():
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}\n")

    train_tf = get_train_transforms()
    val_tf   = get_val_transforms()

    # DFUTissue datasets
    train_names = load_names(TRAIN_LIST)
    val_names   = load_names(VAL_LIST)
    dfu_train   = DFUTissueDataset(IMG_DIR, MASK_DIR, train_names, train_tf)
    dfu_val     = DFUTissueDataset(IMG_DIR, MASK_DIR, val_names,   val_tf)

    # Pseudo-labeled
    datasets, weights = [dfu_train], list(dfu_train.sample_weights)
    if PSEUDO_IMG.exists() and any(PSEUDO_IMG.iterdir()):
        pseudo_stems = [p.stem for p in PSEUDO_IMG.iterdir()
                        if p.suffix.lower() in {".jpg", ".jpeg", ".png"}]
        pseudo_ds = DFUTissueDataset(PSEUDO_IMG, PSEUDO_MASK, pseudo_stems, train_tf, is_pseudo=True)
        datasets.append(pseudo_ds)
        weights  += pseudo_ds.sample_weights
        print(f"DFU labeled : {len(dfu_train)}")
        print(f"DFU pseudo  : {len(pseudo_ds)}")
    else:
        print(f"DFU labeled : {len(dfu_train)} (no pseudo)")

    # Necrotic
    necrotic_mask_dir = NECROTIC_TRAIN / "masks"
    if not necrotic_mask_dir.exists():
        print("\n[!] Necrotic masks not found — run convert_masks.py first!")
        print(f"    python \"{NECROTIC_BASE / 'convert_masks.py'}\"")
        return

    necro_train = NecroticDataset(NECROTIC_TRAIN, train_tf)
    necro_val   = NecroticDataset(NECROTIC_VALID, val_tf)
    datasets.append(necro_train)
    weights  += necro_train.sample_weights
    print(f"Necrotic    : {len(necro_train)}")

    necro_ann_train = necro_ann_val = None
    if (NECROTIC_ANN_TRAIN / "masks").exists():
        necro_ann_train = NecroticDataset(NECROTIC_ANN_TRAIN, train_tf)
        necro_ann_val   = NecroticDataset(NECROTIC_ANN_VALID, val_tf)
        datasets.append(necro_ann_train)
        weights  += necro_ann_train.sample_weights
        print(f"Necrotic v2 : {len(necro_ann_train)}")
    else:
        print("[!] necrotic_annotated masks not found — skipping")

    combined = ConcatDataset(datasets)
    print(f"\nTotal train : {len(combined)}")

    val_parts = [dfu_val, necro_val]
    if necro_ann_val is not None:
        val_parts.append(necro_ann_val)
    val_combined = ConcatDataset(val_parts)
    print(f"DFU val     : {len(dfu_val)}, Necrotic val: {len(necro_val)}"
          + (f", Necrotic v2 val: {len(necro_ann_val)}" if necro_ann_val else ""))
    print(f"Total val   : {len(val_combined)}\n")

    sampler = WeightedRandomSampler(weights, num_samples=len(weights), replacement=True)
    train_loader = DataLoader(combined,     batch_size=BATCH_SIZE, sampler=sampler,
                              num_workers=2, pin_memory=True)
    val_loader   = DataLoader(val_combined, batch_size=BATCH_SIZE, shuffle=False,
                              num_workers=2, pin_memory=True)

    # Separate val loaders for per-dataset Dice logging
    dfu_val_loader    = DataLoader(dfu_val,    batch_size=BATCH_SIZE, shuffle=False, num_workers=2)
    necro_val_loader  = DataLoader(necro_val,  batch_size=BATCH_SIZE, shuffle=False, num_workers=2)
    necro_ann_loader  = (DataLoader(necro_ann_val, batch_size=BATCH_SIZE, shuffle=False, num_workers=2)
                         if necro_ann_val else None)

    print("Loading SegFormer-B4 (5-class)...")
    model = SegformerForSemanticSegmentation.from_pretrained(
        "nvidia/mit-b4",
        num_labels=NUM_CLASSES,
        ignore_mismatched_sizes=True,
        id2label={i: n for i, n in enumerate(CLASS_NAMES)},
        label2id={n: i for i, n in enumerate(CLASS_NAMES)},
    ).to(device)

    if ROUND3_CKPT.exists():
        print(f"[Round 4] Loading Round 3 best → {ROUND3_CKPT.name}")
        model.load_state_dict(torch.load(ROUND3_CKPT, map_location=device), strict=True)
        print(f"  Fine-tuning with LR={LR}, loss=CE({1-DICE_WEIGHT})+Dice({DICE_WEIGHT})")
    elif PHASE3_CKPT.exists():
        print(f"Fallback: loading Phase 3 encoder from {PHASE3_CKPT.name}")
        state = torch.load(PHASE3_CKPT, map_location=device)
        encoder_state = {k: v for k, v in state.items() if "decode_head.classifier" not in k}
        model.load_state_dict(encoder_state, strict=False)
        print(f"  Loaded {len(encoder_state)} layers | Skipped decode head classifier")
    else:
        print("No checkpoint found — starting from ImageNet weights")

    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    # Cosine restarts: T_0=10 epochs, T_mult=2 → restarts at 10, 30, 70 ...
    scheduler = CosineAnnealingWarmRestarts(optimizer, T_0=10, T_mult=2, eta_min=1e-7)
    criterion = CombinedCEDiceLoss(class_weights=CLASS_WEIGHTS, dice_weight=DICE_WEIGHT)
    scaler    = GradScaler()

    best_mean_dice    = 0.0
    early_stop_patience = 15
    no_improve_count    = 0
    history = []

    for epoch in range(1, EPOCHS + 1):
        # ── Train ─────────────────────────────────────────────────────────────
        model.train()
        train_loss = 0.0
        for batch in tqdm(train_loader, desc=f"Ep {epoch:03d}/{EPOCHS} [Train]", leave=False):
            imgs  = batch["image"].to(device)
            masks = batch["mask"].to(device)
            is_ps = bool(any(batch["is_pseudo"]))

            with autocast():
                logits    = model(pixel_values=imgs).logits
                logits_up = F.interpolate(logits, size=masks.shape[-2:],
                                          mode="bilinear", align_corners=False)
                loss = criterion(logits_up, masks, is_pseudo=is_ps)

            optimizer.zero_grad()
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(optimizer)
            scaler.update()
            train_loss += loss.item()

        scheduler.step(epoch - 1)   # CosineAnnealingWarmRestarts counts from 0
        train_loss /= len(train_loader)

        # ── Validate (combined) ───────────────────────────────────────────────
        dices   = eval_loader(model, val_loader, device)
        mean_fg = float(np.mean(dices[1:]))

        # ── Per-dataset val Dice (for debugging) ──────────────────────────────
        dfu_d   = eval_loader(model, dfu_val_loader,   device)
        necro_d = eval_loader(model, necro_val_loader, device)
        ann_d   = eval_loader(model, necro_ann_loader, device) if necro_ann_loader else None

        cur_lr = optimizer.param_groups[0]["lr"]
        log = {
            "epoch": epoch, "loss": round(train_loss, 4),
            "dice_bg":       round(dices[0], 4),
            "dice_fibrin":   round(dices[1], 4),
            "dice_gran":     round(dices[2], 4),
            "dice_callus":   round(dices[3], 4),
            "dice_necrotic": round(dices[4], 4),
            "mean_fg_dice":  round(mean_fg,  4),
            "lr": cur_lr,
            "per_dataset": {
                "dfu":      [round(v, 4) for v in dfu_d],
                "necrotic": [round(v, 4) for v in necro_d],
                **({"necrotic_v2": [round(v, 4) for v in ann_d]} if ann_d else {}),
            },
        }
        history.append(log)

        print(f"Ep {epoch:03d} | Loss {train_loss:.4f} | "
              f"Fib {dices[1]:.4f}  Gran {dices[2]:.4f}  "
              f"Callus {dices[3]:.4f}  Necro {dices[4]:.4f} | "
              f"meanFG {mean_fg:.4f} | LR {cur_lr:.2e}")
        print(f"         DFU  Necro={dfu_d[4]:.4f}↓  "
              f"NecroDS Necro={necro_d[4]:.4f}"
              + (f"  NecroV2 Necro={ann_d[4]:.4f}" if ann_d else ""))

        if mean_fg > best_mean_dice:
            best_mean_dice   = mean_fg
            no_improve_count = 0
            torch.save(model.state_dict(), SAVE_BEST)
            print(f"  ✓ Best saved  (meanFG: {mean_fg:.4f} | Necrotic: {dices[4]:.4f})")
        else:
            no_improve_count += 1
            print(f"  No improve {no_improve_count}/{early_stop_patience}")
            if no_improve_count >= early_stop_patience:
                print(f"\n⚡ Early stopping at epoch {epoch}")
                break

        if epoch % 10 == 0:
            torch.save(model.state_dict(), SAVE_DIR / f"segformer_b4_5class_r4_ep{epoch}.pth")

    with open(SAVE_DIR / "history_5class_r4.json", "w") as f:
        json.dump(history, f, indent=2)

    print(f"\nDone — Best meanFG Dice: {best_mean_dice:.4f}")
    print(f"Best model → {SAVE_BEST}")


if __name__ == "__main__":
    train()
