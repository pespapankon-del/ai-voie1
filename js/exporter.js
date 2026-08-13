/**
 * exporter.js
 * -----------------------------------------------------------------------
 * ประกอบภาพพื้นหลังของหน้า + text layers (ผ่าน handwriting-engine) ที่ resolution ที่เลือก (1x/2x/3x)
 * แล้วส่งออกเป็น PNG ทีละหน้า, ZIP ทุกหน้า (JSZip), หรือ PDF รวมทุกหน้า (jsPDF) — โหลด lib จาก CDN แบบ lazy
 * -----------------------------------------------------------------------
 */

import { renderLayer } from "./handwriting-engine.js";

const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";

function loadScriptOnce(url, globalCheck) {
  return new Promise((resolve, reject) => {
    if (globalCheck()) { resolve(); return; }
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`โหลดไลบรารีจาก ${url} ไม่สำเร็จ (ตรวจสอบอินเทอร์เน็ต)`));
    document.head.appendChild(script);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("โหลดรูปพื้นหลังของหน้านี้ไม่สำเร็จ"));
    img.src = src;
  });
}

/**
 * เรนเดอร์หนึ่งหน้าเป็น canvas ที่ resolution ตามที่เลือก (fallbackFontFamily ใช้กับตัวอักษรที่ยังไม่ได้ฝึก)
 * @param {{imageDataUrl:string,width:number,height:number,layers:object[]}} page
 * @param {object} profile handwriting profile
 * @param {number} resolutionMultiplier 1|2|3
 * @param {string} fallbackFontFamily
 */
export async function renderPageToExportCanvas(page, profile, resolutionMultiplier, fallbackFontFamily) {
  const img = await loadImage(page.imageDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(page.width * resolutionMultiplier);
  canvas.height = Math.round(page.height * resolutionMultiplier);
  const ctx = canvas.getContext("2d");

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.scale(resolutionMultiplier, resolutionMultiplier);
  const untrained = new Set();
  (page.layers || []).forEach((layer) => {
    const result = renderLayer(ctx, layer, profile, { fallbackFontFamily });
    result.untrainedChars.forEach((c) => untrained.add(c));
  });
  ctx.restore();

  return { canvas, untrainedChars: untrained };
}

export function downloadCanvasAsPNG(canvas, filename) {
  const link = document.createElement("a");
  link.download = filename;
  link.href = canvas.toDataURL("image/png", 1.0);
  link.click();
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png", 1.0));
}

/**
 * ส่งออกทุกหน้าของเอกสารเป็น PNG แยกไฟล์ zip เดียว
 */
export async function exportAllPagesAsZip(doc, profile, resolutionMultiplier, fallbackFontFamily, onProgress) {
  await loadScriptOnce(JSZIP_URL, () => window.JSZip);
  const zip = new window.JSZip();

  for (let i = 0; i < doc.pages.length; i++) {
    onProgress?.({ current: i + 1, total: doc.pages.length, status: `กำลังเรนเดอร์หน้า ${i + 1}/${doc.pages.length}` });
    const { canvas } = await renderPageToExportCanvas(doc.pages[i], profile, resolutionMultiplier, fallbackFontFamily);
    const blob = await canvasToBlob(canvas);
    zip.file(`page-${String(i + 1).padStart(2, "0")}.png`, blob);
  }

  onProgress?.({ current: doc.pages.length, total: doc.pages.length, status: "กำลังบีบอัดไฟล์..." });
  const zipBlob = await zip.generateAsync({ type: "blob" });
  const link = document.createElement("a");
  link.download = `${doc.name || "homework"}.zip`;
  link.href = URL.createObjectURL(zipBlob);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

/**
 * ส่งออกทุกหน้าของเอกสารรวมเป็น PDF เดียว รักษาขนาด/ลำดับหน้า
 */
export async function exportAllPagesAsPDF(doc, profile, resolutionMultiplier, fallbackFontFamily, onProgress) {
  await loadScriptOnce(JSPDF_URL, () => window.jspdf);
  const { jsPDF } = window.jspdf;

  let pdf = null;
  for (let i = 0; i < doc.pages.length; i++) {
    onProgress?.({ current: i + 1, total: doc.pages.length, status: `กำลังเรนเดอร์หน้า ${i + 1}/${doc.pages.length}` });
    const page = doc.pages[i];
    const { canvas } = await renderPageToExportCanvas(page, profile, resolutionMultiplier, fallbackFontFamily);
    const imgData = canvas.toDataURL("image/jpeg", 0.95);

    // หน่วย pt, ใช้ขนาดหน้าเดิม (px -> pt โดยประมาณที่ 96dpi: pt = px * 72/96)
    const pageWidthPt = page.width * 0.75;
    const pageHeightPt = page.height * 0.75;

    if (!pdf) {
      pdf = new jsPDF({ orientation: pageWidthPt > pageHeightPt ? "landscape" : "portrait", unit: "pt", format: [pageWidthPt, pageHeightPt] });
    } else {
      pdf.addPage([pageWidthPt, pageHeightPt], pageWidthPt > pageHeightPt ? "landscape" : "portrait");
    }
    pdf.addImage(imgData, "JPEG", 0, 0, pageWidthPt, pageHeightPt);
  }

  onProgress?.({ current: doc.pages.length, total: doc.pages.length, status: "กำลังบันทึกไฟล์ PDF..." });
  pdf.save(`${doc.name || "homework"}.pdf`);
}
