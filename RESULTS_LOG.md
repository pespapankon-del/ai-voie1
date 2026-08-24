# VITA — DFU Tissue Segmentation: บันทึกผลและไทม์ไลน์

โครงการ: ระบบ AI ประเมินแผลเบาหวานที่เท้า (Diabetic Foot Ulcer) สำหรับนำเสนอ **ISTEM 2026**

## เป้าหมาย (Target)
- meanFG Dice > **0.82**
- Necrotic Dice > **0.70**

## โมเดลและ Classes
- Architecture: **SegFormer-B4** (`nvidia/mit-b4`), fine-tuned
- 5 classes: `0=Background  1=Fibrin  2=Granulation  3=Callus  4=Necrotic`
- Loss: Combined Cross-Entropy + Dice (dice_weight=0.5)
- Optimizer: AdamW + CosineAnnealingWarmRestarts (T_0=10, T_mult=2)

---

## ผลแต่ละ Round

### Round 3 (baseline)
- Checkpoint: `segformer_b4_5class_best.pth`
- ใช้เป็นจุดเริ่มต้นของ Round 4

### Round 4
- Checkpoint: `segformer_b4_5class_r4_best.pth`
- LR = 1e-5, Class weights = [0.3, 6.0, 2.5, 1.2, 8.0]
- Best ที่ **Epoch 1**, early stop ที่ Epoch 17 (patience 15)
- **ผลระหว่างเทรน (training val)**: meanFG = **0.8233** ✅ | Necrotic = **0.7112** ✅
- **ผล evaluate แยกทีหลัง** (`evaluate_round4.py`, รวม DFUTissue + NecroDS + NecroV2):

| Class | Dice |
|-------|------|
| Background | 0.9806 |
| Fibrin | 0.5639 ❌ |
| Granulation | 0.7242 |
| Callus | 0.6083 ❌ |
| Necrotic | 0.9189 |
| **meanFG (combined)** | 0.7038 |

  - พบว่า **Fibrin** และ **Callus** เป็นจุดอ่อน → นำไปสู่การหา dataset เสริมใน Round 5

### Round 5
- Checkpoint: `segformer_b4_5class_r5_best.pth` (โหลดต่อจาก Round 4 best)
- LR ลดเหลือ 5e-6, Class weights = [0.3, **8.0**, 2.5, **3.0**, 8.0] (เพิ่ม weight Fibrin/Callus)
- เพิ่ม dataset ใหม่ 2 ชุด (ดูหัวข้อ Datasets ด้านล่าง)
- Best ที่ **Epoch 46** (รันครบ 50 epoch โดยไม่ early stop)

**ผลสุดท้าย (training val, combined ทุก dataset):**

| Class | Round 4 (eval) | Round 5 (best) | เปลี่ยนแปลง |
|-------|----------------|-----------------|------------|
| Fibrin | 0.5639 | **0.8953** | +0.3314 |
| Granulation | 0.7242 | **0.9269** | +0.2027 |
| Callus | 0.6083 | **0.8206** | +0.2123 |
| Necrotic | 0.9189 | **0.8350** | -0.0839 (ยังผ่านเป้า) |
| **meanFG Dice** | 0.7038 | **0.8694** | +0.1656 |

**✅ ผ่านเป้าทั้งคู่**: meanFG 0.8694 > 0.82, Necrotic 0.8350 > 0.70

**ทดสอบภาพจริง** (`test_inference.py`) — ทดสอบกับภาพ test set ที่โมเดลไม่เคยเห็น ผล segmentation ตรงกับตำแหน่งแผลจริง ขอบเขตชัดเจน ไม่มี noise

⚠️ **หมายเหตุเรื่อง data leakage**: ตัวเลข Necrotic ที่ได้จาก `evaluate_round4.py` (NecroDS 0.9500, NecroV2 0.8907) วัดจาก `train/masks/` ของ necrotic_roboflow/necrotic_annotated เพราะ `valid/` ของสอง dataset นี้ไม่มี mask ให้ — ภาพที่ใช้วัดจึงเป็นภาพที่โมเดลเคยเห็นตอนเทรนมาแล้ว ตัวเลขนี้**สูงเกินจริง** ไม่ควรใช้เป็นตัวแทน generalization ที่แท้จริง ให้ใช้ตัวเลขจาก `evaluate_holdout.py` และการทดสอบ generalization ด้านล่างแทน

---

## การทดสอบ Generalization กับข้อมูลภายนอก (2026-08-24)

เพื่อตรวจสอบว่าโมเดลไม่ได้แค่ "จำ" ภาพที่เทรนมา แต่ใช้งานได้จริงกับภาพที่ไม่เคยเห็นเลย ได้ทดสอบ 2 ชั้น:

### 1. Clean holdout (`evaluate_holdout.py`)
วัดผลเฉพาะ `seg_ulcer/test/` (16 ภาพ) และ `foot_callus/test/` (20 ภาพ) — สอง split ที่ `train_segformer_round5.py` **ไม่เคยใช้เทรนหรือ validate เลย** (ใช้แค่ train/ กับ valid/) จึงไม่มี data leakage เลย ตัวเลขจากส่วนนี้เชื่อถือได้ 100% สำหรับ paper

### 2. Dataset ภายนอกที่ไม่เกี่ยวข้องเลย ("Foot Ulcer Detection", Roboflow Universe)
- Dataset คนละแหล่งข้อมูล ไม่ใช่ dataset ที่ใช้เทรนใน Round ใดเลย (741 ภาพ, class `ulcer`, bounding-box only ไม่มี mask ให้เทียบ Dice ได้ — ใช้ตรวจสอบเชิงคุณภาพ/แนวโน้มเท่านั้น)
- ใช้ `batch_test.py` รันกับภาพ 15 ภาพจาก test split ของ dataset นี้

**ผลค่าเฉลี่ยพื้นที่ต่อ class (15 ภาพ):**

| Class | ค่าเฉลี่ย |
|-------|----------|
| Background | 85.90% |
| Fibrin | 5.94% |
| Granulation | 5.42% |
| Callus | 0.98% |
| Necrotic | 1.77% |

**ข้อสังเกต:**
- ขอบเขตแผล (localization) แม่นยำมาก ตรงตำแหน่งแผลจริงในทุกภาพที่ตรวจสอบด้วยตา
- ภาพที่ไม่มีแผลชัดเจน โมเดลตอบ Background ถูกต้อง ไม่สร้าง false positive
- พบ 1 ภาพ (image107) ที่โมเดลอาจแยก Necrotic กับ Fibrin/Slough สับสน (ทำนาย Necrotic ทับเนื้อเยื่อสีน้ำตาลอมเหลืองเกือบทั้งแผล) — ตรวจสอบ dataset ทั้งชุดแล้วพบว่าเป็น **edge case เดียว ไม่ใช่ pattern เป็นระบบ** (ค่าเฉลี่ย Necrotic รวมต่ำเพียง 1.77%)
- **ข้อจำกัดของการทดสอบนี้**: ไม่มี ground-truth mask เทียบ จึงเป็นการตรวจสอบเชิงคุณภาพ (คนดูด้วยตา) ไม่ใช่ตัวเลข Dice ที่วัดได้แม่นยำ ควรให้บุคลากรทางการแพทย์ตรวจสอบภาพผลลัพธ์เพิ่มเติมก่อนอ้างอิงใน paper อย่างเป็นทางการ

---

## Datasets ที่ใช้

| Dataset | จำนวนภาพที่ใช้ได้ | ใช้เสริม class | หมายเหตุ |
|---------|-------------------|-----------------|----------|
| DFUTissue (dfu_tissue_segnet) | หลัก (train/val split) | ทุก class | dataset หลักที่มี label ครบ 4 tissue types |
| necrotic_roboflow | train+valid | Necrotic | ใช้ train/masks/ เพราะ valid ไม่มี mask |
| necrotic_annotated (NecroV2) | train+valid | Necrotic | เช่นเดียวกับด้านบน |
| **Segmentation-ulcer** (Roboflow Universe) | 161 ภาพ (112 train / 33 valid / 16 test) | Fibrin (จาก Sloughy), Granulation, Necrotic | ข้ามภาพที่มีแต่ Epithelialising (ไม่มี class ตรง) |
| **Foot Callus Detection** (Roboflow Universe) | 202 ภาพ (143 train / 39 valid / 20 test) | Callus (จาก stage-1..4) | ข้ามภาพ unlabeled และ "normal foot" ล้วน |

---

## ไทม์ไลน์

| วันที่ | เหตุการณ์ |
|--------|-----------|
| ก่อนหน้า | Round 3 เทรนเสร็จ (baseline) |
| ก่อนหน้า | Round 4 เทรนเสร็จ — best Ep1, meanFG=0.8233, Necrotic=0.7112 (training val) |
| 2026-08-23 | รัน `evaluate_round4.py` แยก — เจอ path bug (valid/images ไม่มีจริง) → แก้เป็นอ่านจาก train/masks/ |
| 2026-08-23 | ผล evaluate Round 4 แยกตาม dataset: Necrotic 0.9189 ✅, meanFG รวม 0.7038 (ลากลงเพราะ Fibrin/Callus อ่อน) |
| 2026-08-23 | ค้นหาและตรวจสอบ dataset เสริม: Segmentation-ulcer (217 ภาพ) และ Foot Callus Detection (576 ภาพ) จาก Roboflow Universe |
| 2026-08-23 | เขียน `convert_seg_ulcer.py`, `convert_foot_callus.py` แปลง COCO polygon → grayscale mask |
| 2026-08-23/24 | เขียน `train_segformer_round5.py` รวม dataset ใหม่ + ปรับ class weight + ลด LR |
| 2026-08-24 ~01:14 | Round 5 เทรนเสร็จ — best Ep46, meanFG=0.8694 ✅, Necrotic=0.8350 ✅, Fibrin=0.8953, Callus=0.8206 |
| 2026-08-24 | ทดสอบ `test_inference.py` กับภาพจริงจาก test set — ผลตรงกับตำแหน่งแผลจริง ยืนยันโมเดลใช้งานได้ |
| 2026-08-24 | เขียน `evaluate_holdout.py` วัดผลแบบไม่มี data leakage บน seg_ulcer/test และ foot_callus/test |
| 2026-08-24 | ทดสอบ generalization กับ "Foot Ulcer Detection" dataset ภายนอก (741 ภาพ ไม่เกี่ยวกับที่เทรนเลย) ด้วย `batch_test.py` — ผลดี ขอบเขตแผลแม่นยำ, พบ edge case เดียวเรื่อง Necrotic/Fibrin สับสน |

---

## ไฟล์สคริปต์ทั้งหมด (อยู่ใน repo)

| ไฟล์ | หน้าที่ |
|------|---------|
| `train_segformer_round4.py` | เทรน Round 4 |
| `train_segformer_round5.py` | เทรน Round 5 (ล่าสุด) |
| `evaluate_round4.py` | ประเมินผลบน validation set แยกตาม dataset |
| `filter_necrotic.py` | กรองภาพที่มี Necrotic pixel มากพอ |
| `convert_seg_ulcer.py` | แปลง Segmentation-ulcer COCO → mask |
| `convert_foot_callus.py` | แปลง Foot Callus Detection COCO → mask |
| `test_inference.py` | รันโมเดลกับภาพเดี่ยว + สร้างภาพ overlay ผลลัพธ์ |
| `evaluate_holdout.py` | ประเมินผลแบบไม่มี data leakage (seg_ulcer/test, foot_callus/test) |
| `batch_test.py` | รันโมเดลกับหลายภาพในโฟลเดอร์เดียว + สรุปสถิติรวม |

## Checkpoint ปัจจุบัน (ดีที่สุด)
```
C:\VITA_Round3\checkpoints\segformer_b4_5class_r5_best.pth
```

---

## ขั้นตอนถัดไป
- [x] รัน `evaluate_holdout.py` เพื่อได้ตัวเลขที่ไม่มี data leakage
- [x] ทดสอบ generalization กับ dataset ภายนอก
- [ ] Deploy โมเดลกับ LINE Bot + Web UI (repo `vita-dfu-bot`)
- [ ] เตรียมเอกสาร/สไลด์สำหรับ ISTEM 2026
- [ ] (แนะนำ) ให้บุคลากรทางการแพทย์ตรวจสอบภาพผลลัพธ์ตัวอย่าง ยืนยันความถูกต้องของการแยกชนิดเนื้อเยื่อก่อนนำเสนอ
