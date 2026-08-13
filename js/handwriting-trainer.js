/**
 * handwriting-trainer.js
 * -----------------------------------------------------------------------
 * หน้าฝึกลายมือ: ผู้ใช้เขียนตัวอักษรทีละตัวด้วย Apple Pencil / นิ้ว / เมาส์ ผ่าน Pointer Events
 * บันทึกพิกัด ลำดับเส้น และแรงกด (pressure) เก็บเป็น "variant" ของตัวอักษรนั้นใน profile
 * รองรับ 3–5 ตัวอย่างต่อตัวอักษร เพื่อให้ renderer สุ่มสลับใช้ (ดู handwriting-engine.js)
 * -----------------------------------------------------------------------
 */

import { CHAR_CATEGORIES, CORE_THAI_CHARS } from "./handwriting-engine.js";

const EM_SIZE = 100; // กรอบอ้างอิงมาตรฐานสำหรับบันทึกลายเส้น (พิกัดจะ scale ตาม fontSize ตอน render จริง)
const MAX_VARIANTS_PER_CHAR = 5;

export class HandwritingTrainer {
  /**
   * @param {HTMLCanvasElement} canvasEl
   * @param {object} profile - object โปรไฟล์ลายมือ (จะถูกแก้ไข mutate โดยตรง)
   * @param {(state:object)=>void} onChange - callback แจ้ง UI เมื่อมีการบันทึก/ลบตัวอย่าง
   */
  constructor(canvasEl, profile, onChange) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.profile = profile;
    this.onChange = onChange || (() => {});

    this.currentChar = null;
    this.strokes = []; // strokes ของตัวอักษรที่กำลังเขียนอยู่ในรอบนี้ (ยังไม่ save)
    this.activeStroke = null;
    this.isDrawing = false;

    this._bindEvents();
  }

  _bindEvents() {
    const el = this.canvas;
    // ป้องกันหน้าเว็บเลื่อน (scroll) ขณะกำลังเขียนด้วย Apple Pencil/นิ้วบน iPad
    el.style.touchAction = "none";

    el.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    el.addEventListener("pointermove", (e) => this._onPointerMove(e));
    el.addEventListener("pointerup", (e) => this._onPointerUp(e));
    el.addEventListener("pointercancel", (e) => this._onPointerUp(e));
    el.addEventListener("pointerleave", (e) => { if (this.isDrawing) this._onPointerUp(e); });
  }

  _toEmCoords(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * EM_SIZE;
    const y = ((clientY - rect.top) / rect.height) * EM_SIZE;
    return { x, y };
  }

  _onPointerDown(e) {
    if (!this.currentChar) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.isDrawing = true;
    const { x, y } = this._toEmCoords(e.clientX, e.clientY);
    this.activeStroke = [{ x, y, pressure: e.pressure || 0.5 }];
    this._redraw();
  }

  _onPointerMove(e) {
    if (!this.isDrawing || !this.activeStroke) return;
    e.preventDefault();
    const { x, y } = this._toEmCoords(e.clientX, e.clientY);
    this.activeStroke.push({ x, y, pressure: e.pressure || 0.5 });
    this._redraw();
  }

  _onPointerUp(e) {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    if (this.activeStroke && this.activeStroke.length > 1) {
      this.strokes.push(this.activeStroke);
    }
    this.activeStroke = null;
    this._redraw();
  }

  /** เริ่มฝึกตัวอักษรใหม่ ล้าง canvas และ strokes ชั่วคราว */
  setChar(ch) {
    this.currentChar = ch;
    this.strokes = [];
    this.activeStroke = null;
    this._redraw();
  }

  clearCurrentStrokes() {
    this.strokes = [];
    this.activeStroke = null;
    this._redraw();
  }

  /** เปลี่ยนไปใช้โปรไฟล์อื่นโดยไม่ต้องสร้าง instance ใหม่ (คง event listener เดิมไว้ชุดเดียว) */
  setProfile(profile) {
    this.profile = profile;
    this.currentChar = null;
    this.strokes = [];
    this.activeStroke = null;
    this._redraw();
  }

  /** จำนวนตัวอย่างที่บันทึกไปแล้วของตัวอักษรปัจจุบัน */
  savedVariantCount() {
    if (!this.currentChar) return 0;
    return this.profile.samples[this.currentChar]?.length || 0;
  }

  canSaveMore() {
    return this.savedVariantCount() < MAX_VARIANTS_PER_CHAR;
  }

  /** บันทึก strokes ปัจจุบันเป็น variant ใหม่ของตัวอักษร */
  saveVariant() {
    if (!this.currentChar || this.strokes.length === 0) {
      throw new Error("ยังไม่ได้เขียนตัวอักษรนี้");
    }
    if (!this.canSaveMore()) {
      throw new Error(`บันทึกได้สูงสุด ${MAX_VARIANTS_PER_CHAR} ตัวอย่างต่อตัวอักษร`);
    }
    // รวมทุก stroke เป็น points เดียว โดยแทรก marker penUp คั่นระหว่าง stroke
    const points = [];
    this.strokes.forEach((stroke, sIdx) => {
      stroke.forEach((p, i) => {
        points.push({ ...p, penUp: sIdx > 0 && i === 0 });
      });
    });
    // ประมาณความกว้างตัวอักษร (advance) จาก bounding box ของลายเส้น
    const xs = points.map((p) => p.x);
    const advance = Math.max(20, Math.max(...xs) - Math.min(...xs) + 15);

    if (!this.profile.samples[this.currentChar]) this.profile.samples[this.currentChar] = [];
    this.profile.samples[this.currentChar].push({
      points,
      emSize: EM_SIZE,
      advance,
      seed: `${this.currentChar}-${Date.now()}`,
    });

    this.clearCurrentStrokes();
    this.onChange({ char: this.currentChar, variantCount: this.savedVariantCount() });
  }

  deleteVariant(index) {
    if (!this.currentChar || !this.profile.samples[this.currentChar]) return;
    this.profile.samples[this.currentChar].splice(index, 1);
    if (this.profile.samples[this.currentChar].length === 0) {
      delete this.profile.samples[this.currentChar];
    }
    this._redraw();
    this.onChange({ char: this.currentChar, variantCount: this.savedVariantCount() });
  }

  _redraw() {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // เส้นไกด์กรอบ + baseline
    ctx.strokeStyle = "#E1DCC9";
    ctx.lineWidth = 1;
    ctx.strokeRect(4, 4, w - 8, h - 8);
    ctx.beginPath();
    ctx.moveTo(4, h * 0.7); ctx.lineTo(w - 4, h * 0.7);
    ctx.strokeStyle = "#D65B5B";
    ctx.stroke();

    const scaleX = w / EM_SIZE, scaleY = h / EM_SIZE;
    ctx.strokeStyle = "#1f3a5f";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const drawStroke = (pts) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(pts[0].x * scaleX, pts[0].y * scaleY);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineWidth = Math.max(1.5, 4 * (pts[i].pressure ?? 0.5));
        ctx.lineTo(pts[i].x * scaleX, pts[i].y * scaleY);
      }
      ctx.stroke();
    };

    this.strokes.forEach(drawStroke);
    if (this.activeStroke) drawStroke(this.activeStroke);
  }
}

/* ============================ Profile factory ============================ */

export function createEmptyProfile(name = "ลายมือของฉัน") {
  return {
    id: `profile_${Date.now().toString(36)}`,
    name,
    samples: {},
    settings: {
      slant: 0,          // radians, ลบ=เอียงซ้าย บวก=เอียงขวา
      charSpacing: 0,    // px เพิ่มระหว่างตัวอักษร
      baselineJitter: 2, // px สุ่มขึ้นลงต่อตัวอักษร
      wordSpacing: 0,    // px เพิ่มระหว่างคำ
      strokeThickness: 2.5,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** รายการชุดฝึกทั้งหมด รวมคณิตศาสตร์/เคมี/เลขยกกำลัง/เศษส่วนตามที่ต้องการ */
export const TRAINING_SETS = {
  core: { label: "⭐ ชุดจำเป็น (37 ตัว) — ฝึกแค่นี้ก็พอสำหรับข้อความส่วนใหญ่", chars: CORE_THAI_CHARS },
  thai: { label: "พยัญชนะ-สระ-วรรณยุกต์ไทย (ชุดเต็ม)", chars: CHAR_CATEGORIES.thai },
  english: { label: "ภาษาอังกฤษ A–Z", chars: CHAR_CATEGORIES.english },
  number: { label: "ตัวเลข", chars: CHAR_CATEGORIES.number },
  math: { label: "สัญลักษณ์คณิตศาสตร์ / เคมี / เลขยกกำลัง / เศษส่วน", chars: CHAR_CATEGORIES.math },
};
