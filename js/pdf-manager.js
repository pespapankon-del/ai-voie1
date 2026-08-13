/**
 * pdf-manager.js
 * -----------------------------------------------------------------------
 * โหลด PDF.js จาก CDN แบบ dynamic import (ไม่ผูกเป็น build step)
 * ทำ 3 อย่าง: (1) parse PDF จากไฟล์ผู้ใช้ (2) สร้าง thumbnail ทุกหน้า (3) เรนเดอร์หน้าที่เลือกที่ความละเอียดที่ต้องการ
 *
 * ถ้าโหลด PDF.js จาก CDN ไม่ได้ (เช่นไม่มีอินเทอร์เน็ต) จะ throw error ที่มีข้อความชัดเจน
 * ให้ UI ชั้นบนแสดง error state แทนที่แอปจะพังเงียบๆ
 * -----------------------------------------------------------------------
 */

const PDFJS_VERSION = "4.6.82";
const PDFJS_ESM_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
const PDFJS_WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

let pdfjsLibPromise = null;

async function getPdfjsLib() {
  if (pdfjsLibPromise) return pdfjsLibPromise;
  pdfjsLibPromise = import(/* webpackIgnore: true */ PDFJS_ESM_URL)
    .then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return lib;
    })
    .catch((err) => {
      pdfjsLibPromise = null;
      throw new Error("โหลด PDF.js จากอินเทอร์เน็ตไม่สำเร็จ (ต้องมีการเชื่อมต่ออินเทอร์เน็ตครั้งแรกเพื่อเปิดไฟล์ PDF): " + err.message);
    });
  return pdfjsLibPromise;
}

/**
 * เปิดไฟล์ PDF จาก File object คืนค่า pdfDocument proxy ของ pdf.js
 */
export async function loadPdfFile(file) {
  const pdfjsLib = await getPdfjsLib();
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  return loadingTask.promise;
}

/**
 * สร้าง thumbnail (dataURL) สำหรับทุกหน้าใน PDF เพื่อแสดงเป็นแถบเลือกหน้า
 * @param {*} pdfDocument
 * @param {number} maxWidth ความกว้างสูงสุดของ thumbnail (px)
 */
export async function generateThumbnails(pdfDocument, maxWidth = 140) {
  const thumbs = [];
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const scale = maxWidth / viewport.width;
    const scaledViewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;

    thumbs.push({ pageNumber: pageNum, dataUrl: canvas.toDataURL("image/png") });
  }
  return thumbs;
}

/**
 * เรนเดอร์หน้า PDF ที่เลือกลงบน canvas เป้าหมาย ที่ความละเอียดเหมาะกับการ export
 * @param {*} pdfDocument
 * @param {number} pageNumber เริ่มที่ 1
 * @param {HTMLCanvasElement} targetCanvas
 * @param {number} resolutionMultiplier 1 / 2 / 3 เท่า (สำหรับ export คมชัด)
 */
export async function renderPdfPageToCanvas(pdfDocument, pageNumber, targetCanvas, resolutionMultiplier = 1) {
  const page = await pdfDocument.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });

  // จำกัดความละเอียดสูงสุดคร่าวๆ กันเบราว์เซอร์ล้ม (canvas ใหญ่เกินไปบน iPad memory จำกัด)
  const MAX_DIMENSION = 4000;
  let scale = resolutionMultiplier;
  if (baseViewport.width * scale > MAX_DIMENSION || baseViewport.height * scale > MAX_DIMENSION) {
    scale = Math.min(MAX_DIMENSION / baseViewport.width, MAX_DIMENSION / baseViewport.height);
  }

  const viewport = page.getViewport({ scale });
  targetCanvas.width = viewport.width;
  targetCanvas.height = viewport.height;
  const ctx = targetCanvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  return { width: viewport.width, height: viewport.height, pageNumber };
}

export function getPdfPageCount(pdfDocument) {
  return pdfDocument.numPages;
}
