/**
 * app.js — จุดเริ่มต้นของแอป "เขียนให้"
 * เชื่อม module ทั้งหมดเข้าด้วยกัน: canvas-editor, handwriting-engine, handwriting-trainer,
 * pdf-manager, ocr-service, ai-service, storage, exporter, layers
 * -----------------------------------------------------------------------
 */

import { WorkAreaEditor } from "./js/canvas-editor.js";
import { renderLayer, computeTrainingProgress, computeCoreProgress, computeTextCoverage, FALLBACK_FONT_FAMILY } from "./js/handwriting-engine.js";
import { HandwritingTrainer, createEmptyProfile, TRAINING_SETS } from "./js/handwriting-trainer.js";
import { loadPdfFile, generateThumbnails, renderPdfPageToCanvas, getPdfPageCount } from "./js/pdf-manager.js";
import { extractQuestionFromSelection, OCR_PROVIDERS } from "./js/ocr-service.js";
import { generateSolution, autofillWorksheet } from "./js/ai-service.js";
import { generateImage } from "./js/image-service.js";
import { createLayer, duplicateLayer, LayerHistory, isPointInLayer } from "./js/layers.js";
import * as storage from "./js/storage.js";
import { renderPageToExportCanvas, downloadCanvasAsPNG, exportAllPagesAsZip, exportAllPagesAsPDF } from "./js/exporter.js";

/* ============================ DOM refs ============================ */
const $ = (id) => document.getElementById(id);

const els = {
  tabs: document.querySelectorAll(".tab"),
  panels: { worksheet: $("tab-worksheet"), trainer: $("tab-trainer"), settings: $("tab-settings") },

  newDocBtn: $("newDocBtn"), openLastBtn: $("openLastBtn"),

  dropZone: $("dropZone"), fileInput: $("fileInput"), importError: $("importError"),
  pdfThumbs: $("pdfThumbs"),

  workArea: $("workArea"), viewport: $("viewport"),
  baseCanvas: $("baseCanvas"), layersCanvas: $("layersCanvas"), overlayCanvas: $("overlayCanvas"),
  zoomOutBtn: $("zoomOutBtn"), zoomInBtn: $("zoomInBtn"), zoomResetBtn: $("zoomResetBtn"),
  autofillBtn: $("autofillBtn"), moveLayerBtn: $("moveLayerBtn"),
  cropBtn: $("cropBtn"), deleteSelBtn: $("deleteSelBtn"), clearSelBtn: $("clearSelBtn"), resetViewBtn: $("resetViewBtn"),

  ocrBtn: $("ocrBtn"), ocrProgress: $("ocrProgress"), ocrProgressFill: $("ocrProgressFill"),
  ocrProgressStatus: $("ocrProgressStatus"), ocrErrorBox: $("ocrErrorBox"), ocrErrorText: $("ocrErrorText"),
  ocrRetryBtn: $("ocrRetryBtn"), questionText: $("questionText"),

  subjectSelect: $("subjectSelect"), generateBtn: $("generateBtn"), demoModeNotice: $("demoModeNotice"),
  stepsList: $("stepsList"), answerText: $("answerText"), addLayerBtn: $("addLayerBtn"),
  coverageNotice: $("coverageNotice"),

  undoBtn: $("undoBtn"), redoBtn: $("redoBtn"), duplicateLayerBtn: $("duplicateLayerBtn"),
  deleteLayerBtn: $("deleteLayerBtn"), layersList: $("layersList"), layersEmpty: $("layersEmpty"),

  profileSelect: $("profileSelect"), newProfileBtn: $("newProfileBtn"),
  exportProfileBtn: $("exportProfileBtn"), importProfileInput: $("importProfileInput"), profileImportError: $("profileImportError"),
  progressBars: $("progressBars"),
  coreProgressFill: $("coreProgressFill"), coreProgressLabel: $("coreProgressLabel"),
  trainingSetSelect: $("trainingSetSelect"), charGrid: $("charGrid"),
  currentCharLabel: $("currentCharLabel"), trainerCanvas: $("trainerCanvas"),
  variantCountLabel: $("variantCountLabel"), clearStrokeBtn: $("clearStrokeBtn"),
  saveVariantBtn: $("saveVariantBtn"), variantList: $("variantList"),

  slantRange: $("slantRange"), charSpacingRange: $("charSpacingRange"), wordSpacingRange: $("wordSpacingRange"),
  jitterRange: $("jitterRange"), thicknessRange: $("thicknessRange"),
  slantVal: $("slantVal"), charSpacingVal: $("charSpacingVal"), wordSpacingVal: $("wordSpacingVal"),
  jitterVal: $("jitterVal"), thicknessVal: $("thicknessVal"),

  noLayerSelectedHint: $("noLayerSelectedHint"), layerEditFields: $("layerEditFields"),
  layerX: $("layerX"), layerY: $("layerY"), layerWidth: $("layerWidth"),
  layerFontSize: $("layerFontSize"), layerLineHeight: $("layerLineHeight"),
  layerInkColor: $("layerInkColor"), layerRotation: $("layerRotation"), layerScale: $("layerScale"),
  layerXVal: $("layerXVal"), layerYVal: $("layerYVal"), layerWidthVal: $("layerWidthVal"),
  layerFontSizeVal: $("layerFontSizeVal"), layerLineHeightVal: $("layerLineHeightVal"),
  layerRotationVal: $("layerRotationVal"), layerScaleVal: $("layerScaleVal"),

  resolutionSelect: $("resolutionSelect"), exportPagePngBtn: $("exportPagePngBtn"),
  exportZipBtn: $("exportZipBtn"), exportPdfBtn: $("exportPdfBtn"),
  exportProgress: $("exportProgress"), exportProgressFill: $("exportProgressFill"),
  exportProgressStatus: $("exportProgressStatus"), untrainedNotice: $("untrainedNotice"),

  fontUploadInput: $("fontUploadInput"), fontUploadStatus: $("fontUploadStatus"),

  imagePrompt: $("imagePrompt"), generateImageBtn: $("generateImageBtn"),
  imageDemoModeNotice: $("imageDemoModeNotice"), imageResultBox: $("imageResultBox"),
  imageResultPreview: $("imageResultPreview"), downloadImageBtn: $("downloadImageBtn"),

  toast: $("toast"),
  dialogBackdrop: $("confirmDialog"), dialogTitle: $("dialogTitle"),
  dialogCancelBtn: $("dialogCancelBtn"), dialogConfirmBtn: $("dialogConfirmBtn"),
};

/* ============================ App state ============================ */
const state = {
  doc: null,
  pageIndex: 0,
  profile: null,
  profiles: [],
  selectedLayerId: null,
  pdfDoc: null,
  fallbackFontFamily: FALLBACK_FONT_FAMILY,
  moveLayerMode: false,
};

let _layerDrag = null; // {layerId, startPt, startX, startY}

const history = new LayerHistory();
const editor = new WorkAreaEditor(els.baseCanvas, els.overlayCanvas, els.viewport, els.layersCanvas);
editor.onSelectionChange = (sel) => { els.ocrBtn.disabled = !sel; };

editor.onLayerPointer = ({ type, pt }) => {
  const layers = currentLayers();
  if (type === "down") {
    const hit = [...layers].reverse().find((l) => isPointInLayer(l, pt.x, pt.y));
    if (hit) {
      if (hit.id !== state.selectedLayerId) {
        history.push(layers); // บันทึกก่อน drag เริ่ม
        selectLayer(hit.id);
      }
      _layerDrag = { layerId: hit.id, startPt: pt, startX: hit.x, startY: hit.y };
    } else {
      _layerDrag = null;
    }
  } else if (type === "move" && _layerDrag) {
    const layer = currentLayers().find((l) => l.id === _layerDrag.layerId);
    if (layer) {
      layer.x = Math.max(0, _layerDrag.startX + (pt.x - _layerDrag.startPt.x));
      layer.y = Math.max(0, _layerDrag.startY + (pt.y - _layerDrag.startPt.y));
      renderLayersCanvas();
      syncLayerEditFields();
    }
  } else if (type === "up" && _layerDrag) {
    debounceAutosave();
    _layerDrag = null;
  }
};

/* ============================ Utilities ============================ */
function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.className = "toast" + (isError ? " error" : "");
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.hidden = true; }, 3600);
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    els.dialogTitle.textContent = message;
    els.dialogBackdrop.hidden = false;
    const cleanup = (result) => {
      els.dialogBackdrop.hidden = true;
      els.dialogConfirmBtn.removeEventListener("click", onConfirm);
      els.dialogCancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    els.dialogConfirmBtn.addEventListener("click", onConfirm);
    els.dialogCancelBtn.addEventListener("click", onCancel);
  });
}

function currentPage() { return state.doc?.pages?.[state.pageIndex] || null; }
function currentLayers() { return currentPage()?.layers || []; }

function makeNewDocument(name = "งานใหม่") {
  return { id: `doc_${Date.now().toString(36)}`, name, pages: [], createdAt: Date.now(), updatedAt: Date.now() };
}

/* ============================ Tabs ============================ */
els.tabs.forEach((tabBtn) => {
  tabBtn.addEventListener("click", () => {
    els.tabs.forEach((b) => b.setAttribute("aria-selected", String(b === tabBtn)));
    Object.entries(els.panels).forEach(([key, panel]) => { panel.hidden = key !== tabBtn.dataset.tab; });
  });
});

/* ============================ File import ============================ */
const MAX_FILE_MB = 30;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];

["dragover", "dragenter"].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => { e.preventDefault(); els.dropZone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => { e.preventDefault(); els.dropZone.classList.remove("dragover"); })
);
els.dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files?.[0];
  if (file) handleImportFile(file);
});
els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleImportFile(file);
});

function validateFile(file) {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return "รองรับเฉพาะไฟล์ PNG, JPG, WebP หรือ PDF เท่านั้น";
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    return `ไฟล์ใหญ่เกินไป (สูงสุด ${MAX_FILE_MB}MB)`;
  }
  return null;
}

async function handleImportFile(file) {
  els.importError.hidden = true;
  const err = validateFile(file);
  if (err) { els.importError.hidden = false; els.importError.textContent = err; return; }

  state.doc = makeNewDocument(file.name.replace(/\.[^.]+$/, ""));
  state.pageIndex = 0;
  history.clear();

  try {
    if (file.type === "application/pdf") {
      await importPdf(file);
    } else {
      await importImage(file);
    }
    els.workArea.hidden = false;
    await autosaveDocument();
    toast("นำเข้าไฟล์สำเร็จ");
  } catch (e) {
    els.importError.hidden = false;
    els.importError.textContent = e.message || "นำเข้าไฟล์ไม่สำเร็จ";
  }
}

async function importImage(file) {
  els.pdfThumbs.hidden = true;
  els.pdfThumbs.innerHTML = "";
  state.pdfDoc = null;

  const dataUrl = await fileToDataUrl(file);
  const img = await loadImageEl(dataUrl);

  const MAX_DIM = 2400;
  let { width, height } = img;
  if (width > MAX_DIM || height > MAX_DIM) {
    const scale = Math.min(MAX_DIM / width, MAX_DIM / height);
    width = Math.round(width * scale); height = Math.round(height * scale);
  }
  els.baseCanvas.width = width; els.baseCanvas.height = height;
  els.baseCanvas.getContext("2d").drawImage(img, 0, 0, width, height);
  editor.syncOverlaySize();
  editor.reset();

  state.doc.pages = [{ id: `page_1`, imageDataUrl: els.baseCanvas.toDataURL("image/png"), width, height, layers: [] }];
  refreshLayersUI();
  renderLayersCanvas();
}

async function importPdf(file) {
  const pdfDoc = await loadPdfFile(file);
  state.pdfDoc = pdfDoc;
  const pageCount = getPdfPageCount(pdfDoc);
  const thumbs = await generateThumbnails(pdfDoc);

  els.pdfThumbs.hidden = false;
  els.pdfThumbs.innerHTML = "";
  state.doc.pages = new Array(pageCount).fill(null);

  thumbs.forEach((t) => {
    const wrap = document.createElement("button");
    wrap.type = "button";
    wrap.className = "pdf-thumb" + (t.pageNumber === 1 ? " active" : "");

    const img = document.createElement("img");
    img.src = t.dataUrl;
    img.alt = `หน้า ${t.pageNumber}`;

    const label = document.createElement("div");
    label.className = "pdf-thumb__label";
    label.textContent = `หน้า ${t.pageNumber}`;

    wrap.appendChild(img);
    wrap.appendChild(label);
    wrap.addEventListener("click", () => selectPdfPage(t.pageNumber));
    els.pdfThumbs.appendChild(wrap);
  });

  await selectPdfPage(1);
}

async function selectPdfPage(pageNumber) {
  [...els.pdfThumbs.children].forEach((el, i) => el.classList.toggle("active", i === pageNumber - 1));
  state.pageIndex = pageNumber - 1;

  const existingPage = state.doc.pages[pageNumber - 1];
  if (existingPage) {
    // เคยเปิดหน้านี้มาก่อนแล้ว (อาจครอบตัด/ลบพื้นที่ไปแล้ว) -> โหลดจากภาพที่บันทึกไว้ ไม่ render ใหม่จาก PDF ดิบ
    await loadPageIntoCanvas(pageNumber - 1);
    return;
  }

  const { width, height } = await renderPdfPageToCanvas(state.pdfDoc, pageNumber, els.baseCanvas, 1);
  editor.syncOverlaySize();
  editor.reset();

  state.doc.pages[pageNumber - 1] = {
    id: `page_${pageNumber}`, imageDataUrl: els.baseCanvas.toDataURL("image/png"),
    width, height, layers: [],
  };
  refreshLayersUI();
  renderLayersCanvas();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("อ่านไฟล์ไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });
}
function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("เปิดรูปภาพไม่สำเร็จ (ไฟล์อาจเสียหาย)"));
    img.src = src;
  });
}

/* ============================ Work area toolbar ============================ */
els.zoomInBtn.addEventListener("click", () => editor.zoomBy(1.2));
els.zoomOutBtn.addEventListener("click", () => editor.zoomBy(1 / 1.2));
els.zoomResetBtn.addEventListener("click", () => editor.resetView());
els.resetViewBtn.addEventListener("click", () => editor.reset());

/* ──── Feature 2: ย้ายเลเยอร์โดยตรงบน canvas ──── */
els.moveLayerBtn.addEventListener("click", () => {
  state.moveLayerMode = !state.moveLayerMode;
  editor.setMoveLayerMode(state.moveLayerMode);
  els.moveLayerBtn.classList.toggle("active", state.moveLayerMode);
  if (state.moveLayerMode) {
    editor.drawLayerOutlines(currentLayers(), state.selectedLayerId);
  }
});

/* ──── Feature 1: เติมทั้งตาราง (Auto) ──── */
els.autofillBtn.addEventListener("click", async () => {
  if (!currentPage()) { toast("กรุณานำเข้าใบงานก่อน", true); return; }
  setBtnLoading(els.autofillBtn, true, "กำลังวิเคราะห์...");
  try {
    const imageDataUrl = shrinkCanvasForApi(els.baseCanvas, 1200);
    const subject = els.subjectSelect.value;
    const result = await autofillWorksheet(imageDataUrl, subject);
    if (result.isDemo) toast("โหมดทดลอง: ยังไม่ได้เชื่อมต่อ AI จริง (ดู README)", false);

    const page = currentPage();
    history.push(currentLayers());
    result.cells.forEach((cell) => {
      const x = Math.round(cell.xFrac * page.width);
      const y = Math.round(cell.yFrac * page.height);
      const w = Math.round(cell.wFrac * page.width);
      const layer = createLayer({
        text: cell.answer,
        x, y,
        width: Math.max(200, w),
        handwritingProfileId: state.profile?.id || null,
        inkColor: "#1f3a5f",
      });
      page.layers.push(layer);
    });

    refreshLayersUI();
    renderLayersCanvas();
    autosaveDocument();

    // สลับไปโหมดย้ายเลเยอร์อัตโนมัติ เพื่อให้ปรับตำแหน่งได้ทันที
    if (!state.moveLayerMode) {
      state.moveLayerMode = true;
      editor.setMoveLayerMode(true);
      els.moveLayerBtn.classList.add("active");
    }
    editor.drawLayerOutlines(currentLayers(), state.selectedLayerId);
    toast(`เพิ่ม ${result.cells.length} เลเยอร์แล้ว — ลากปรับตำแหน่งได้เลย`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    setBtnLoading(els.autofillBtn, false, "✨ เติมทั้งตาราง");
  }
});

/** ย่อ canvas เป็น JPEG base64 data URL สำหรับส่ง API (ประหยัด payload) */
function shrinkCanvasForApi(canvas, maxPx) {
  const { width, height } = canvas;
  if (width <= maxPx && height <= maxPx) return canvas.toDataURL("image/jpeg", 0.85);
  const scale = Math.min(maxPx / width, maxPx / height);
  const tmp = document.createElement("canvas");
  tmp.width = Math.round(width * scale);
  tmp.height = Math.round(height * scale);
  tmp.getContext("2d").drawImage(canvas, 0, 0, tmp.width, tmp.height);
  return tmp.toDataURL("image/jpeg", 0.85);
}

els.cropBtn.addEventListener("click", () => {
  try {
    editor.crop(currentLayers());
    const page = currentPage();
    page.width = els.baseCanvas.width; page.height = els.baseCanvas.height;
    page.imageDataUrl = els.baseCanvas.toDataURL("image/png");
    renderLayersCanvas();
    autosaveDocument();
    toast("ครอบตัดใบงานแล้ว");
  } catch (e) { toast(e.message, true); }
});
els.deleteSelBtn.addEventListener("click", () => {
  try {
    editor.deleteSelectionContent();
    currentPage().imageDataUrl = els.baseCanvas.toDataURL("image/png");
    autosaveDocument();
    toast("ลบพื้นที่ที่เลือกแล้ว");
  } catch (e) { toast(e.message, true); }
});
els.clearSelBtn.addEventListener("click", () => editor.clearSelection());

/* ============================ OCR ============================ */
els.ocrBtn.addEventListener("click", () => runOcr());
els.ocrRetryBtn.addEventListener("click", () => runOcr());

async function runOcr() {
  if (!editor.selection) return;
  els.ocrErrorBox.hidden = true;
  els.ocrProgress.hidden = false;
  els.ocrBtn.disabled = true;

  const onProgress = ({ status, progress }) => {
    els.ocrProgressStatus.textContent = status;
    els.ocrProgressFill.style.width = `${Math.round((progress || 0) * 100)}%`;
  };

  try {
    let text;
    try {
      text = await extractQuestionFromSelection(els.baseCanvas, editor.selection, {
        provider: OCR_PROVIDERS.tesseract(), onProgress,
      });
    } catch (tesseractErr) {
      // Tesseract โหลดไม่ได้ (เช่นไม่มีเน็ต) -> ใช้โหมดทดลองแทนเพื่อให้ทดสอบ flow ต่อได้
      console.warn("[ocr] tesseract ล้มเหลว ใช้โหมดทดลองแทน:", tesseractErr.message);
      text = await extractQuestionFromSelection(els.baseCanvas, editor.selection, {
        provider: OCR_PROVIDERS.demo(), onProgress,
      });
      toast("อ่าน OCR จริงไม่สำเร็จ ใช้โหมดทดลองชั่วคราวแทน (ตรวจสอบอินเทอร์เน็ต)", true);
    }
    els.questionText.value = text;
    els.ocrProgress.hidden = true;
  } catch (e) {
    els.ocrProgress.hidden = true;
    els.ocrErrorBox.hidden = false;
    els.ocrErrorText.textContent = e.message;
  } finally {
    els.ocrBtn.disabled = false;
  }
}

/* ============================ AI generation ============================ */
els.generateBtn.addEventListener("click", async () => {
  const question = els.questionText.value.trim();
  if (!question) { toast("กรุณาระบุโจทย์ก่อน", true); els.questionText.focus(); return; }

  setBtnLoading(els.generateBtn, true, "กำลังคิดคำตอบ...");
  els.demoModeNotice.hidden = true;
  try {
    const result = await generateSolution({ question, subject: els.subjectSelect.value, language: "th", detailLevel: "step-by-step" });
    els.answerText.value = result.answer;
    els.stepsList.innerHTML = "";
    if (result.steps?.length) {
      result.steps.forEach((s) => { const li = document.createElement("li"); li.textContent = s; els.stepsList.appendChild(li); });
      els.stepsList.hidden = false;
    } else {
      els.stepsList.hidden = true;
    }
    els.demoModeNotice.hidden = !result.isDemo;
    els.addLayerBtn.disabled = false;
    updateCoverageNotice();
  } catch (e) {
    toast(e.message, true);
  } finally {
    setBtnLoading(els.generateBtn, false, "ให้ AI ช่วยแก้โจทย์");
  }
});

/** แสดง % ของข้อความคำตอบที่จะแสดงด้วยลายมือจริง (ที่ฝึกไว้) ก่อนวางลงกระดาษจริง ไม่บล็อกการใช้งาน แค่แจ้งให้ทราบ */
function updateCoverageNotice() {
  const text = els.answerText.value;
  if (!text.trim()) { els.coverageNotice.hidden = true; return; }
  const coverage = computeTextCoverage(text, state.profile);
  els.coverageNotice.hidden = false;
  if (coverage.percent >= 95) {
    els.coverageNotice.textContent = `✓ ${coverage.percent}% ของคำตอบนี้จะเป็นลายมือจริงของคุณ`;
  } else {
    const missingPreview = [...coverage.missingChars].slice(0, 12).join(" ");
    els.coverageNotice.textContent =
      `${coverage.percent}% จะเป็นลายมือจริง ส่วนที่เหลือใช้ฟอนต์แทนชั่วคราว (ยังไม่ได้ฝึก: ${missingPreview}${coverage.missingChars.size > 12 ? " ..." : ""})`;
  }
}
els.answerText.addEventListener("input", debounce(updateCoverageNotice, 300));

function setBtnLoading(btn, loading, label) {
  btn.disabled = loading;
  const spinner = btn.querySelector(".btn__spinner");
  const labelEl = btn.querySelector(".btn__label");
  if (spinner) spinner.hidden = !loading;
  if (labelEl) labelEl.textContent = label;
  else btn.textContent = label;
}

/* ============================ Layers ============================ */
els.addLayerBtn.addEventListener("click", () => {
  if (!currentPage()) { toast("กรุณานำเข้าใบงานก่อน", true); return; }
  history.push(currentLayers());
  const sel = editor.selection;
  const layer = createLayer({
    text: els.answerText.value,
    x: sel ? sel.x : 60,
    y: sel ? sel.y + sel.height + 20 : 60,
    width: Math.min(currentPage().width - 80, sel ? Math.max(sel.width, 300) : 400),
    handwritingProfileId: state.profile?.id || null,
    inkColor: "#1f3a5f",
  });
  currentPage().layers.push(layer);
  selectLayer(layer.id);
  refreshLayersUI();
  renderLayersCanvas();
  autosaveDocument();
  toast("เพิ่มเลเยอร์ลายมือแล้ว");
});

function selectLayer(id) {
  state.selectedLayerId = id;
  refreshLayersUI();
  syncLayerEditFields();
  els.duplicateLayerBtn.disabled = !id;
  els.deleteLayerBtn.disabled = !id;
}

function refreshLayersUI() {
  const layers = currentLayers();
  els.layersEmpty.hidden = layers.length > 0;
  els.layersList.innerHTML = "";
  layers.forEach((layer) => {
    const li = document.createElement("li");
    li.className = layer.id === state.selectedLayerId ? "selected" : "";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = layer.inkColor;
    const txt = document.createElement("span");
    txt.className = "txt";
    txt.textContent = layer.text.slice(0, 40) || "(ว่างเปล่า)";
    li.appendChild(swatch); li.appendChild(txt);
    li.addEventListener("click", () => selectLayer(layer.id));
    els.layersList.appendChild(li);
  });
  els.undoBtn.disabled = !history.canUndo();
  els.redoBtn.disabled = !history.canRedo();
}

els.duplicateLayerBtn.addEventListener("click", () => {
  const layer = currentLayers().find((l) => l.id === state.selectedLayerId);
  if (!layer) return;
  history.push(currentLayers());
  const copy = duplicateLayer(layer);
  currentPage().layers.push(copy);
  selectLayer(copy.id);
  refreshLayersUI(); renderLayersCanvas(); autosaveDocument();
});

els.deleteLayerBtn.addEventListener("click", () => {
  const idx = currentLayers().findIndex((l) => l.id === state.selectedLayerId);
  if (idx === -1) return;
  history.push(currentLayers());
  currentPage().layers.splice(idx, 1);
  selectLayer(null);
  refreshLayersUI(); renderLayersCanvas(); autosaveDocument();
});

els.undoBtn.addEventListener("click", () => {
  currentPage().layers = history.undo(currentLayers());
  refreshLayersUI(); renderLayersCanvas(); autosaveDocument();
});
els.redoBtn.addEventListener("click", () => {
  currentPage().layers = history.redo(currentLayers());
  refreshLayersUI(); renderLayersCanvas(); autosaveDocument();
});

function renderLayersCanvas() {
  const ctx = els.layersCanvas.getContext("2d");
  ctx.clearRect(0, 0, els.layersCanvas.width, els.layersCanvas.height);
  const untrained = new Set();
  currentLayers().forEach((layer) => {
    const result = renderLayer(ctx, layer, state.profile, { fallbackFontFamily: state.fallbackFontFamily });
    result.untrainedChars.forEach((c) => untrained.add(c));
  });
  if (untrained.size > 0) {
    els.untrainedNotice.hidden = false;
    els.untrainedNotice.textContent = `ตัวอักษรที่ยังไม่ได้ฝึก จะแสดงด้วยฟอนต์ตัวอย่างแทน: ${[...untrained].slice(0, 20).join(" ")}`;
  } else {
    els.untrainedNotice.hidden = true;
  }
  if (state.moveLayerMode) {
    editor.drawLayerOutlines(currentLayers(), state.selectedLayerId);
  }
}

/* ---------- Layer edit fields (แท็บตั้งค่า) ---------- */
function syncLayerEditFields() {
  const layer = currentLayers().find((l) => l.id === state.selectedLayerId);
  els.noLayerSelectedHint.hidden = !!layer;
  els.layerEditFields.hidden = !layer;
  if (!layer) return;

  const page = currentPage();
  els.layerX.max = page.width; els.layerY.max = page.height; els.layerWidth.max = page.width;

  els.layerX.value = layer.x; els.layerXVal.textContent = Math.round(layer.x);
  els.layerY.value = layer.y; els.layerYVal.textContent = Math.round(layer.y);
  els.layerWidth.value = layer.width; els.layerWidthVal.textContent = Math.round(layer.width);
  els.layerFontSize.value = layer.fontSize; els.layerFontSizeVal.textContent = layer.fontSize;
  els.layerLineHeight.value = layer.lineHeight; els.layerLineHeightVal.textContent = layer.lineHeight;
  els.layerInkColor.value = layer.inkColor;
  els.layerRotation.value = Math.round((layer.rotation * 180) / Math.PI);
  els.layerRotationVal.textContent = els.layerRotation.value;
  els.layerScale.value = layer.scale;
  els.layerScaleVal.textContent = layer.scale;
}

function bindLayerField(input, key, transform = (v) => Number(v), display) {
  input.addEventListener("input", () => {
    const layer = currentLayers().find((l) => l.id === state.selectedLayerId);
    if (!layer) return;
    layer[key] = transform(input.value);
    if (display) display.textContent = input.value;
    renderLayersCanvas();
    debounceAutosave();
  });
}
bindLayerField(els.layerX, "x", Number, els.layerXVal);
bindLayerField(els.layerY, "y", Number, els.layerYVal);
bindLayerField(els.layerWidth, "width", Number, els.layerWidthVal);
bindLayerField(els.layerFontSize, "fontSize", Number, els.layerFontSizeVal);
bindLayerField(els.layerLineHeight, "lineHeight", Number, els.layerLineHeightVal);
bindLayerField(els.layerRotation, "rotation", (v) => (Number(v) * Math.PI) / 180, els.layerRotationVal);
bindLayerField(els.layerScale, "scale", Number, els.layerScaleVal);
els.layerInkColor.addEventListener("input", () => {
  const layer = currentLayers().find((l) => l.id === state.selectedLayerId);
  if (!layer) return;
  layer.inkColor = els.layerInkColor.value;
  renderLayersCanvas(); debounceAutosave();
});

/* ============================ Handwriting profile & trainer ============================ */
let trainer = null;

async function initProfiles() {
  state.profiles = await storage.listProfiles();
  if (state.profiles.length === 0) {
    const p = createEmptyProfile("ลายมือของฉัน");
    await storage.saveProfile(p);
    state.profiles = [p];
  }
  const lastProfileId = storage.getPrefs().lastProfileId;
  state.profile = state.profiles.find((p) => p.id === lastProfileId) || state.profiles[0];
  refreshProfileSelect();
  setupTrainer();
  refreshProgressBars();
  syncSettingsSlidersFromProfile();
}

function refreshProfileSelect() {
  els.profileSelect.innerHTML = "";
  state.profiles.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id; opt.textContent = p.name;
    if (p.id === state.profile.id) opt.selected = true;
    els.profileSelect.appendChild(opt);
  });
}
els.profileSelect.addEventListener("change", async () => {
  state.profile = state.profiles.find((p) => p.id === els.profileSelect.value);
  storage.setPrefs({ lastProfileId: state.profile.id });
  setupTrainer(); refreshProgressBars(); syncSettingsSlidersFromProfile(); renderLayersCanvas();
});

els.newProfileBtn.addEventListener("click", async () => {
  const name = `ลายมือใหม่ ${state.profiles.length + 1}`;
  const p = createEmptyProfile(name);
  await storage.saveProfile(p);
  state.profiles.push(p); state.profile = p;
  storage.setPrefs({ lastProfileId: p.id });
  refreshProfileSelect(); setupTrainer(); refreshProgressBars(); syncSettingsSlidersFromProfile();
  toast("สร้างโปรไฟล์ลายมือใหม่แล้ว");
});

els.exportProfileBtn.addEventListener("click", () => {
  const json = storage.exportProfileAsJSON(state.profile);
  const blob = new Blob([json], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.profile.name}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 3000);
});

els.importProfileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  els.profileImportError.hidden = true;
  try {
    const text = await file.text();
    const { valid, error, data } = storage.validateProfileJSON(text);
    if (!valid) throw new Error(error);
    data.id = `profile_${Date.now().toString(36)}`; // กัน id ชนของเดิม
    await storage.saveProfile(data);
    state.profiles.push(data); state.profile = data;
    refreshProfileSelect(); setupTrainer(); refreshProgressBars(); syncSettingsSlidersFromProfile();
    toast("นำเข้าโปรไฟล์ลายมือสำเร็จ");
  } catch (err) {
    els.profileImportError.hidden = false;
    els.profileImportError.textContent = err.message;
  } finally {
    e.target.value = "";
  }
});

function setupTrainer() {
  if (!trainer) {
    // สร้าง instance เดียวตลอดอายุแอป เพื่อไม่ให้ pointer event listener ซ้อนกันบน canvas เดิม
    trainer = new HandwritingTrainer(els.trainerCanvas, state.profile, ({ variantCount }) => {
      els.variantCountLabel.textContent = `${variantCount} / 5 ตัวอย่าง`;
      els.saveVariantBtn.disabled = variantCount >= 5;
      refreshVariantList();
      refreshCharGrid();
      refreshProgressBars();
      storage.saveProfile(state.profile).catch((e) => toast(e.message, true));
    });
  } else {
    trainer.setProfile(state.profile);
  }
  els.currentCharLabel.textContent = "เลือกตัวอักษรด้านบนเพื่อเริ่มฝึก";
  els.variantCountLabel.textContent = "0 / 5 ตัวอย่าง";
  els.saveVariantBtn.disabled = true;
  els.variantList.innerHTML = "";
  renderCharGrid();
}

function renderCharGrid() {
  const set = TRAINING_SETS[els.trainingSetSelect.value];
  els.charGrid.innerHTML = "";
  set.chars.forEach((ch) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "char-chip";
    btn.textContent = ch;
    btn.addEventListener("click", () => selectTrainingChar(ch));
    els.charGrid.appendChild(btn);
  });
  refreshCharGrid();
}
els.trainingSetSelect.addEventListener("change", renderCharGrid);

function refreshCharGrid() {
  [...els.charGrid.children].forEach((btn) => {
    const ch = btn.textContent;
    const count = state.profile.samples[ch]?.length || 0;
    btn.classList.toggle("trained", count > 0);
    btn.classList.toggle("active", ch === trainer?.currentChar);
    let dot = btn.querySelector(".count-dot");
    if (count > 0) {
      if (!dot) { dot = document.createElement("span"); dot.className = "count-dot"; btn.appendChild(dot); }
      dot.textContent = count;
    } else if (dot) { dot.remove(); }
  });
}

function selectTrainingChar(ch) {
  trainer.setChar(ch);
  els.currentCharLabel.textContent = `กำลังฝึก: "${ch}"`;
  els.variantCountLabel.textContent = `${trainer.savedVariantCount()} / 5 ตัวอย่าง`;
  els.saveVariantBtn.disabled = !trainer.canSaveMore();
  refreshVariantList();
  refreshCharGrid();
}

els.clearStrokeBtn.addEventListener("click", () => trainer?.clearCurrentStrokes());
els.saveVariantBtn.addEventListener("click", () => {
  try { trainer.saveVariant(); toast("บันทึกตัวอย่างลายมือแล้ว"); }
  catch (e) { toast(e.message, true); }
});

function refreshVariantList() {
  els.variantList.innerHTML = "";
  if (!trainer?.currentChar) return;
  const variants = state.profile.samples[trainer.currentChar] || [];
  variants.forEach((_, i) => {
    const li = document.createElement("li");
    li.textContent = `ตัวอย่าง ${i + 1}`;
    const delBtn = document.createElement("button");
    delBtn.type = "button"; delBtn.textContent = "✕";
    delBtn.setAttribute("aria-label", `ลบตัวอย่าง ${i + 1}`);
    delBtn.addEventListener("click", () => {
      trainer.deleteVariant(i);
      toast("ลบตัวอย่างแล้ว");
    });
    li.appendChild(delBtn);
    els.variantList.appendChild(li);
  });
}

function refreshProgressBars() {
  const progress = computeTrainingProgress(state.profile);
  const labels = { thai: "ไทย", english: "อังกฤษ", number: "ตัวเลข", math: "คณิตศาสตร์" };
  els.progressBars.innerHTML = "";
  Object.entries(progress).forEach(([cat, p]) => {
    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = labels[cat];

    const bar = document.createElement("div");
    bar.className = "progress__bar";
    const fill = document.createElement("div");
    fill.className = "progress__fill";
    fill.style.width = `${p.percent}%`;
    bar.appendChild(fill);

    const pct = document.createElement("span");
    pct.className = "pct";
    pct.textContent = `${p.percent}%`;

    row.appendChild(label); row.appendChild(bar); row.appendChild(pct);
    els.progressBars.appendChild(row);
  });
  refreshCoreProgress();
}

/** progress ของ "ชุดจำเป็น" (37 ตัวที่ใช้บ่อยสุด) แยกต่างหาก แสดงเด่นเพราะเป็นเป้าหมายหลักที่แนะนำให้ฝึกก่อน */
function refreshCoreProgress() {
  const core = computeCoreProgress(state.profile);
  els.coreProgressFill.style.width = `${core.percent}%`;
  els.coreProgressLabel.textContent = `${core.trained} / ${core.total} ตัว (${core.percent}%)`;
}

/* ============================ Settings sliders (profile-level) ============================ */
function syncSettingsSlidersFromProfile() {
  const s = state.profile.settings;
  els.slantRange.value = Math.round((s.slant * 180) / Math.PI);
  els.slantVal.textContent = els.slantRange.value;
  els.charSpacingRange.value = s.charSpacing; els.charSpacingVal.textContent = s.charSpacing;
  els.wordSpacingRange.value = s.wordSpacing; els.wordSpacingVal.textContent = s.wordSpacing;
  els.jitterRange.value = s.baselineJitter; els.jitterVal.textContent = s.baselineJitter;
  els.thicknessRange.value = s.strokeThickness; els.thicknessVal.textContent = s.strokeThickness;
}

function bindProfileSetting(input, key, display, transform = Number) {
  input.addEventListener("input", () => {
    state.profile.settings[key] = transform(input.value);
    display.textContent = input.value;
    renderLayersCanvas();
    debounce(() => storage.saveProfile(state.profile), 400)();
  });
}
bindProfileSetting(els.slantRange, "slant", els.slantVal, (v) => (Number(v) * Math.PI) / 180);
bindProfileSetting(els.charSpacingRange, "charSpacing", els.charSpacingVal);
bindProfileSetting(els.wordSpacingRange, "wordSpacing", els.wordSpacingVal);
bindProfileSetting(els.jitterRange, "baselineJitter", els.jitterVal);
bindProfileSetting(els.thicknessRange, "strokeThickness", els.thicknessVal);

/* ============================ Export ============================ */
els.exportPagePngBtn.addEventListener("click", async () => {
  if (!currentPage()) return;
  const resolution = Number(els.resolutionSelect.value);
  try {
    const { canvas } = await renderPageToExportCanvas(currentPage(), state.profile, resolution, state.fallbackFontFamily);
    downloadCanvasAsPNG(canvas, `${state.doc.name}-page${state.pageIndex + 1}.png`);
  } catch (e) { toast(e.message, true); }
});

els.exportZipBtn.addEventListener("click", async () => {
  await runExportWithProgress(async () => {
    await ensureAllPagesRendered(updateExportProgress);
    await exportAllPagesAsZip(state.doc, state.profile, Number(els.resolutionSelect.value), state.fallbackFontFamily, updateExportProgress);
  });
});
els.exportPdfBtn.addEventListener("click", async () => {
  await runExportWithProgress(async () => {
    await ensureAllPagesRendered(updateExportProgress);
    await exportAllPagesAsPDF(state.doc, state.profile, Number(els.resolutionSelect.value), state.fallbackFontFamily, updateExportProgress);
  });
});

/** Feature 3: render หน้า PDF ที่ยังไม่เคยเปิด (null) ก่อน export เพื่อไม่ให้ crash */
async function ensureAllPagesRendered(onProgress) {
  if (!state.pdfDoc || !state.doc) return;
  const nullPages = state.doc.pages.reduce((acc, p, i) => { if (!p) acc.push(i); return acc; }, []);
  if (nullPages.length === 0) return;

  const tmp = document.createElement("canvas");
  for (const i of nullPages) {
    onProgress?.({ current: i + 1, total: state.doc.pages.length, status: `กำลังเตรียมหน้า ${i + 1}/${state.doc.pages.length}...` });
    const { width, height } = await renderPdfPageToCanvas(state.pdfDoc, i + 1, tmp, 1);
    state.doc.pages[i] = {
      id: `page_${i + 1}`,
      imageDataUrl: tmp.toDataURL("image/png"),
      width, height, layers: [],
    };
  }
}

async function runExportWithProgress(task) {
  if (!state.doc?.pages?.length) { toast("ยังไม่มีเอกสารให้ส่งออก", true); return; }
  els.exportProgress.hidden = false;
  try {
    await task();
    toast("ส่งออกไฟล์สำเร็จ");
  } catch (e) {
    toast(e.message, true);
  } finally {
    els.exportProgress.hidden = true;
  }
}
function updateExportProgress({ current, total, status }) {
  els.exportProgressStatus.textContent = status;
  els.exportProgressFill.style.width = `${Math.round((current / total) * 100)}%`;
}

/* ============================ Local persistence (documents) ============================ */
function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}
const debounceAutosave = debounce(() => autosaveDocument(), 500);

async function autosaveDocument() {
  if (!state.doc) return;
  try {
    await storage.saveDocument(state.doc);
    storage.setPrefs({ lastDocId: state.doc.id });
  } catch (e) {
    toast(e.message, true);
  }
}

els.newDocBtn.addEventListener("click", async () => {
  if (state.doc) {
    const ok = await confirmDialog("เริ่มงานใหม่? งานปัจจุบันถูกบันทึกไว้อัตโนมัติแล้ว สามารถกลับมาเปิดได้ภายหลัง");
    if (!ok) return;
  }
  resetWorkspace();
});

function resetWorkspace() {
  state.doc = null; state.pageIndex = 0; state.selectedLayerId = null; state.pdfDoc = null;
  history.clear();
  els.workArea.hidden = true;
  els.pdfThumbs.hidden = true; els.pdfThumbs.innerHTML = "";
  els.questionText.value = ""; els.answerText.value = "";
  els.stepsList.hidden = true; els.demoModeNotice.hidden = true;
  els.addLayerBtn.disabled = true;
  refreshLayersUI(); syncLayerEditFields();
}

els.openLastBtn.addEventListener("click", async () => {
  const lastId = storage.getPrefs().lastDocId;
  if (!lastId) return;
  try {
    const doc = await storage.loadDocument(lastId);
    if (!doc) { toast("ไม่พบงานล่าสุด", true); return; }
    state.doc = doc; state.pageIndex = 0; state.pdfDoc = null;
    history.clear();
    await loadPageIntoCanvas(0);
    els.workArea.hidden = false;
    toast("เปิดงานล่าสุดแล้ว");
  } catch (e) { toast(e.message, true); }
});

async function loadPageIntoCanvas(pageIndex) {
  const page = state.doc.pages[pageIndex];
  const img = await loadImageEl(page.imageDataUrl);
  els.baseCanvas.width = page.width; els.baseCanvas.height = page.height;
  els.baseCanvas.getContext("2d").drawImage(img, 0, 0, page.width, page.height);
  editor.syncOverlaySize();
  editor.reset();
  refreshLayersUI();
  renderLayersCanvas();
}

/* ============================ Custom fallback font upload ============================ */
els.fontUploadInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  els.fontUploadStatus.textContent = "กำลังโหลดฟอนต์...";
  try {
    const buffer = await file.arrayBuffer();
    const family = "CustomHandwritingFont";
    const face = new FontFace(family, buffer);
    await face.load();
    document.fonts.add(face);
    state.fallbackFontFamily = family;
    els.fontUploadStatus.textContent = `ใช้ฟอนต์ "${file.name}" เป็น fallback แล้ว`;
    renderLayersCanvas();
    toast("โหลดฟอนต์ลายมือสำเร็จ");
  } catch (err) {
    els.fontUploadStatus.textContent = "โหลดฟอนต์ไม่สำเร็จ ไฟล์อาจเสียหายหรือไม่ใช่ฟอนต์ที่ถูกต้อง";
    toast("โหลดฟอนต์ไม่สำเร็จ: " + err.message, true);
  } finally {
    e.target.value = "";
  }
});

/* ============================ AI Image generation (GPT Image 2) ============================ */
let lastGeneratedImageDataUrl = null;

els.generateImageBtn.addEventListener("click", async () => {
  const prompt = els.imagePrompt.value.trim();
  if (!prompt) { toast("กรุณาอธิบายภาพที่ต้องการก่อน", true); els.imagePrompt.focus(); return; }

  setBtnLoading(els.generateImageBtn, true, "กำลังสร้างภาพ...");
  els.imageDemoModeNotice.hidden = true;
  els.imageResultBox.hidden = true;

  try {
    const result = await generateImage({ prompt });
    if (result.isDemo) {
      els.imageDemoModeNotice.hidden = false;
      els.imageDemoModeNotice.textContent = result.message;
      return;
    }
    lastGeneratedImageDataUrl = result.dataUrl;
    els.imageResultPreview.src = result.dataUrl;
    els.imageResultBox.hidden = false;
    toast("สร้างภาพสำเร็จ");
  } catch (e) {
    toast(e.message, true);
  } finally {
    setBtnLoading(els.generateImageBtn, false, "สร้างภาพ");
  }
});

els.downloadImageBtn.addEventListener("click", () => {
  if (!lastGeneratedImageDataUrl) return;
  const link = document.createElement("a");
  link.download = `ai-image-${Date.now()}.png`;
  link.href = lastGeneratedImageDataUrl;
  link.click();
});

/* ============================ Init ============================ */
(async function init() {
  const lastDocId = storage.getPrefs().lastDocId;
  els.openLastBtn.hidden = !lastDocId;
  await initProfiles();
})();
