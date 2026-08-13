/**
 * canvas-editor.js
 * -----------------------------------------------------------------------
 * จัดการ "พื้นที่ทำงาน" ของใบงาน: แสดงภาพ/หน้า PDF, ให้ผู้ใช้ลากเลือกกรอบโจทย์,
 * ปรับขนาดกรอบด้วย resize handles, ครอบตัด (crop), ลบพื้นที่ที่เลือก, รีเซ็ต, ซูม/แพน
 *
 * หลักการสำคัญ: baseCanvas.width/height คือ "พิกัดจริง" ของเอกสาร ไม่เปลี่ยนตามการซูม
 * การซูม/แพนทำผ่าน CSS transform เท่านั้น (ไม่แก้ resolution) ทำให้:
 *   - พิกัดที่แปลงจาก pointer event ผ่าน getBoundingClientRect() ถูกต้องเสมอไม่ว่าจะซูมเท่าไร
 *   - ตำแหน่ง layer/selection ที่บันทึกไว้ใช้ได้ตรงกันทั้งตอน preview และตอน export
 *
 * overlayCanvas ใช้วาดกรอบ selection + resize handles เท่านั้น (ไม่รวมใน export)
 * -----------------------------------------------------------------------
 */

const HANDLE_SIZE = 22; // px ในพิกัด canvas จริง (ทำให้แตะง่ายบน iPad ผ่านการ scale ของ CSS ให้ยังใหญ่พอบนจอ)
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export class WorkAreaEditor {
  /**
   * @param {HTMLCanvasElement} baseCanvas เนื้อหาใบงานจริง (สำหรับ export)
   * @param {HTMLCanvasElement} overlayCanvas กรอบ selection/handles (ไม่ export)
   * @param {HTMLElement} viewportEl container ที่ครอบทั้งสอง canvas (ใช้ทำ zoom/pan)
   */
  constructor(baseCanvas, overlayCanvas, viewportEl, layersCanvas = null) {
    this.baseCanvas = baseCanvas;
    this.overlayCanvas = overlayCanvas;
    this.layersCanvas = layersCanvas;
    this.viewportEl = viewportEl;
    this.overlayCtx = overlayCanvas.getContext("2d");

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    this.selection = null; // {x,y,width,height} พิกัด canvas จริง
    this.dragMode = null;  // 'create' | 'move' | 'resize-<handle>' | 'pan'
    this.dragStart = null;

    this._moveMode = false;
    this.onLayerPointer = null; // function({type:'down'|'move'|'up', pt:{x,y}})
    this.onSelectionChange = () => {};

    this._bindEvents();
  }

  /* ---------- Sizing: ให้ overlay ตามขนาด base เป๊ะ ---------- */
  syncOverlaySize() {
    this.overlayCanvas.width = this.baseCanvas.width;
    this.overlayCanvas.height = this.baseCanvas.height;
    if (this.layersCanvas) {
      this.layersCanvas.width = this.baseCanvas.width;
      this.layersCanvas.height = this.baseCanvas.height;
    }
    this._applyTransform();
    this._redrawOverlay();
  }

  _applyTransform() {
    const t = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    this.baseCanvas.style.transform = t;
    this.overlayCanvas.style.transform = t;
    if (this.layersCanvas) this.layersCanvas.style.transform = t;
  }

  setZoom(zoom, focalClientX, focalClientY) {
    const clamped = Math.min(4, Math.max(0.25, zoom));
    this.zoom = clamped;
    this._applyTransform();
  }

  zoomBy(factor) { this.setZoom(this.zoom * factor); }
  resetView() { this.zoom = 1; this.panX = 0; this.panY = 0; this._applyTransform(); }

  /* ---------- พิกัด: client(screen) -> canvas จริง ---------- */
  clientToCanvas(clientX, clientY) {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const scaleX = this.overlayCanvas.width / rect.width;
    const scaleY = this.overlayCanvas.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  /* ---------- Pointer events ---------- */
  _bindEvents() {
    const el = this.overlayCanvas;
    el.style.touchAction = "none";

    el.addEventListener("pointerdown", (e) => this._onDown(e));
    el.addEventListener("pointermove", (e) => this._onMove(e));
    el.addEventListener("pointerup", (e) => this._onUp(e));
    el.addEventListener("pointercancel", (e) => this._onUp(e));

    // pinch-zoom / two-finger pan บนอุปกรณ์สัมผัส ทำแบบง่ายด้วย wheel (trackpad) และปุ่ม +/- ในหมวดควบคุม
    this.viewportEl.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return; // ให้ ctrl+wheel = zoom, wheel เฉยๆ = scroll หน้าเว็บตามปกติ
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });
  }

  _handleAtPoint(canvasPt) {
    if (!this.selection) return null;
    const { x, y, width, height } = this.selection;
    const centers = {
      nw: [x, y], n: [x + width / 2, y], ne: [x + width, y],
      e: [x + width, y + height / 2], se: [x + width, y + height],
      s: [x + width / 2, y + height], sw: [x, y + height], w: [x, y + height / 2],
    };
    for (const h of HANDLES) {
      const [hx, hy] = centers[h];
      if (Math.abs(canvasPt.x - hx) <= HANDLE_SIZE && Math.abs(canvasPt.y - hy) <= HANDLE_SIZE) {
        return h;
      }
    }
    return null;
  }

  _isInsideSelection(pt) {
    if (!this.selection) return false;
    const { x, y, width, height } = this.selection;
    return pt.x >= x && pt.x <= x + width && pt.y >= y && pt.y <= y + height;
  }

  _onDown(e) {
    this.overlayCanvas.setPointerCapture(e.pointerId);
    const pt = this.clientToCanvas(e.clientX, e.clientY);

    if (this._moveMode) {
      this.onLayerPointer?.({ type: "down", pt });
      this._lastMovePt = pt;
      return;
    }

    const handle = this._handleAtPoint(pt);
    if (handle) {
      this.dragMode = `resize-${handle}`;
    } else if (this._isInsideSelection(pt)) {
      this.dragMode = "move";
    } else {
      this.dragMode = "create";
      this.selection = { x: pt.x, y: pt.y, width: 0, height: 0 };
    }
    this.dragStart = pt;
    this._selectionAtDragStart = this.selection ? { ...this.selection } : null;
  }

  _onMove(e) {
    const pt = this.clientToCanvas(e.clientX, e.clientY);

    if (this._moveMode) {
      if (this._lastMovePt) this.onLayerPointer?.({ type: "move", pt });
      return;
    }

    if (!this.dragMode) return;
    const start = this._selectionAtDragStart;

    if (this.dragMode === "create") {
      const x0 = this.dragStart.x, y0 = this.dragStart.y;
      this.selection = {
        x: Math.min(x0, pt.x), y: Math.min(y0, pt.y),
        width: Math.abs(pt.x - x0), height: Math.abs(pt.y - y0),
      };
    } else if (this.dragMode === "move" && start) {
      const dx = pt.x - this.dragStart.x, dy = pt.y - this.dragStart.y;
      this.selection = { ...start, x: start.x + dx, y: start.y + dy };
      this._clampSelectionToCanvas();
    } else if (this.dragMode.startsWith("resize-") && start) {
      this.selection = this._resizeSelection(start, this.dragMode.replace("resize-", ""), pt);
    }
    this._redrawOverlay();
  }

  _onUp(e) {
    const pt = this.clientToCanvas(e?.clientX ?? 0, e?.clientY ?? 0);

    if (this._moveMode) {
      if (this._lastMovePt) this.onLayerPointer?.({ type: "up", pt });
      this._lastMovePt = null;
      return;
    }

    this.dragMode = null;
    this.dragStart = null;
    if (this.selection && (this.selection.width < 4 || this.selection.height < 4)) {
      this.selection = null; // คลิกเฉยๆ ไม่ได้ลาก ถือว่าไม่มี selection
    }
    this._redrawOverlay();
    this.onSelectionChange(this.selection);
  }

  _resizeSelection(start, handle, pt) {
    let { x, y, width, height } = start;
    const right = x + width, bottom = y + height;
    let nx = x, ny = y, nRight = right, nBottom = bottom;

    if (handle.includes("w")) nx = pt.x;
    if (handle.includes("e")) nRight = pt.x;
    if (handle.includes("n")) ny = pt.y;
    if (handle.includes("s")) nBottom = pt.y;

    const result = {
      x: Math.min(nx, nRight), y: Math.min(ny, nBottom),
      width: Math.abs(nRight - nx), height: Math.abs(nBottom - ny),
    };
    return result;
  }

  _clampSelectionToCanvas() {
    if (!this.selection) return;
    const w = this.baseCanvas.width, h = this.baseCanvas.height;
    this.selection.x = Math.max(0, Math.min(this.selection.x, w - this.selection.width));
    this.selection.y = Math.max(0, Math.min(this.selection.y, h - this.selection.height));
  }

  /* ---------- Actions ---------- */

  /** ครอบตัดใบงานให้เหลือเฉพาะ selection แล้วปรับ layers ที่ส่งเข้ามาให้เลื่อนตำแหน่งตาม (mutate ในที่) */
  crop(layers = []) {
    if (!this.selection) throw new Error("กรุณาลากเลือกบริเวณที่ต้องการครอบตัดก่อน");
    const { x, y, width, height } = this.selection;
    const cropped = document.createElement("canvas");
    cropped.width = Math.round(width);
    cropped.height = Math.round(height);
    cropped.getContext("2d").drawImage(this.baseCanvas, x, y, width, height, 0, 0, width, height);

    this.baseCanvas.width = cropped.width;
    this.baseCanvas.height = cropped.height;
    this.baseCanvas.getContext("2d").drawImage(cropped, 0, 0);

    layers.forEach((l) => { l.x -= x; l.y -= y; });

    this.selection = null;
    this.syncOverlaySize();
    return layers;
  }

  /** ลบ (ทาสีขาวทับ) เนื้อหาภายใน selection บนใบงานเดิม เช่น ลบคำตอบเก่าก่อนเขียนใหม่ */
  deleteSelectionContent() {
    if (!this.selection) throw new Error("กรุณาลากเลือกบริเวณที่ต้องการลบก่อน");
    const { x, y, width, height } = this.selection;
    const ctx = this.baseCanvas.getContext("2d");
    ctx.save();
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(x, y, width, height);
    ctx.restore();
    this._redrawOverlay();
  }

  clearSelection() {
    this.selection = null;
    this._redrawOverlay();
    this.onSelectionChange(null);
  }

  reset() {
    this.selection = null;
    this.resetView();
    this._redrawOverlay();
    this.onSelectionChange(null);
  }

  /* ---------- Move-layer mode ---------- */

  setMoveLayerMode(enabled) {
    this._moveMode = !!enabled;
    this._lastMovePt = null;
    this.overlayCanvas.style.cursor = enabled ? "grab" : "";
    if (!enabled) this._redrawOverlay();
  }

  /** วาดเส้นประรอบ layer ทุกตัวบน overlayCanvas (เฉพาะโหมดย้ายเลเยอร์) */
  drawLayerOutlines(layers, selectedId) {
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    layers.forEach((layer) => {
      const isSelected = layer.id === selectedId;
      const w = layer.width * layer.scale;
      // ประมาณจำนวนบรรทัด (ตรงกับ estimateLayerBounds ใน layers.js)
      const charsPerLine = Math.max(6, Math.floor(layer.width / (layer.fontSize * 0.65)));
      const lines = Math.max(1, Math.ceil((layer.text || "").length / charsPerLine));
      const h = layer.lineHeight * layer.scale * (lines + 0.5);
      const cx = layer.x + w / 2;
      const cy = layer.y + h / 2;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(layer.rotation);

      ctx.strokeStyle = isSelected ? "#2e7d32" : "rgba(46,125,50,0.5)";
      ctx.lineWidth = isSelected ? 3 : 1.5;
      ctx.setLineDash([8, 5]);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.setLineDash([]);

      if (isSelected) {
        ctx.fillStyle = "rgba(46,125,50,0.08)";
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }
      ctx.restore();
    });
  }

  /* ---------- Drawing overlay ---------- */
  _redrawOverlay() {
    if (this._moveMode) return; // drawLayerOutlines รับผิดชอบใน move mode แทน
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    if (!this.selection) return;
    const { x, y, width, height } = this.selection;

    ctx.save();
    ctx.strokeStyle = "#D65B5B";
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 6]);
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(214,91,91,0.08)";
    ctx.fillRect(x, y, width, height);

    // handles
    ctx.fillStyle = "#D65B5B";
    const centers = {
      nw: [x, y], n: [x + width / 2, y], ne: [x + width, y],
      e: [x + width, y + height / 2], se: [x + width, y + height],
      s: [x + width / 2, y + height], sw: [x, y + height], w: [x, y + height / 2],
    };
    Object.values(centers).forEach(([hx, hy]) => {
      ctx.beginPath();
      ctx.arc(hx, hy, HANDLE_SIZE / 2.6, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }
}
