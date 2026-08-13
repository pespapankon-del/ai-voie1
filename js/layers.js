/**
 * layers.js
 * -----------------------------------------------------------------------
 * โมเดลของ "handwriting text layer" หนึ่งชิ้นบนหน้ากระดาษ + ระบบ undo/redo
 * แบบ snapshot stack (เก็บ deep-clone ของ layers array ทั้งหน้า ทุกครั้งที่เปลี่ยนแปลง)
 *
 * เหตุผลที่ใช้ snapshot แทน command pattern: จำนวน layer ต่อหน้าไม่เยอะ (หลักสิบ)
 * และ text ไม่ยาวมาก การ deep-clone จึงเบากว่าที่คิด และ debug ง่ายกว่ามาก
 * -----------------------------------------------------------------------
 */

let idCounter = 0;
export function makeLayerId() {
  idCounter += 1;
  return `layer_${Date.now().toString(36)}_${idCounter}`;
}

export function createLayer(overrides = {}) {
  return {
    id: makeLayerId(),
    text: overrides.text ?? "",
    x: overrides.x ?? 100,
    y: overrides.y ?? 100,
    width: overrides.width ?? 400,
    fontSize: overrides.fontSize ?? 32,
    lineHeight: overrides.lineHeight ?? 48,
    inkColor: overrides.inkColor ?? "#1f3a5f",
    rotation: overrides.rotation ?? 0, // radians
    scale: overrides.scale ?? 1,
    handwritingProfileId: overrides.handwritingProfileId ?? null,
  };
}

export function cloneLayer(layer) {
  return { ...layer };
}

export function duplicateLayer(layer) {
  return { ...layer, id: makeLayerId(), x: layer.x + 24, y: layer.y + 24 };
}

/* ============================ History (undo/redo) ============================ */

export class LayerHistory {
  constructor(maxDepth = 50) {
    this.maxDepth = maxDepth;
    this.past = [];
    this.future = [];
  }

  /** เรียกก่อนจะแก้ไข layers ทุกครั้ง เพื่อบันทึกสถานะปัจจุบันลง stack */
  push(currentLayers) {
    this.past.push(JSON.parse(JSON.stringify(currentLayers)));
    if (this.past.length > this.maxDepth) this.past.shift();
    this.future = []; // การแก้ไขใหม่ล้าง redo stack เสมอ
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }

  undo(currentLayers) {
    if (!this.canUndo()) return currentLayers;
    this.future.push(JSON.parse(JSON.stringify(currentLayers)));
    return this.past.pop();
  }

  redo(currentLayers) {
    if (!this.canRedo()) return currentLayers;
    this.past.push(JSON.parse(JSON.stringify(currentLayers)));
    return this.future.pop();
  }

  clear() { this.past = []; this.future = []; }
}

/* ============================ Hit-testing / geometry ============================ */

/**
 * ประมาณกรอบสี่เหลี่ยม (ก่อน rotation) ของ layer — ใช้ร่วมกันในทั้ง hit-testing และวาด outline
 * @returns {{x,y,width,height}} พิกัด canvas จริง ที่มุมบนซ้ายของกรอบ
 */
export function estimateLayerBounds(layer) {
  const w = layer.width * layer.scale;
  const charsPerLine = Math.max(6, Math.floor(layer.width / (layer.fontSize * 0.65)));
  const lines = Math.max(1, Math.ceil((layer.text || "").length / charsPerLine));
  const h = layer.lineHeight * layer.scale * (lines + 0.5);
  return { x: layer.x, y: layer.y, width: w, height: h };
}

/** คืนค่า true ถ้าจุด (px,py) ในพิกัด canvas จริง อยู่ในกรอบของ layer (คิดรวม rotation ด้วย) */
export function isPointInLayer(layer, px, py) {
  const { x, y, width, height } = estimateLayerBounds(layer);
  const cx = x + width / 2;
  const cy = y + height / 2;
  const dx = px - cx;
  const dy = py - cy;
  const cos = Math.cos(-layer.rotation);
  const sin = Math.sin(-layer.rotation);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  return Math.abs(localX) <= width / 2 && Math.abs(localY) <= height / 2;
}
