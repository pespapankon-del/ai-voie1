/**
 * ocr-service.js
 * -----------------------------------------------------------------------
 * แยก "OCR provider" ออกจาก UI เพื่อสลับผู้ให้บริการภายหลังได้ง่าย (adapter pattern)
 * ผู้ให้บริการทุกตัวต้อง implement: async recognize(imageSource, onProgress) -> string
 *
 * ค่าเริ่มต้น: TesseractProvider (รันในเบราว์เซอร์ล้วนๆ ผ่าน WASM, โหลดจาก CDN)
 * มี EndpointProvider ไว้เป็นตัวอย่างสำหรับต่อ OCR endpoint ของคุณเองในอนาคต (เช่น Google Vision, Textract)
 * ทั้งสองไม่มีการวาง secret key ใน frontend เด็ดขาด — EndpointProvider ยิงไป backend ของคุณเท่านั้น
 * -----------------------------------------------------------------------
 */

const TESSERACT_CDN_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

/* ============================ Providers ============================ */

class TesseractProvider {
  constructor() { this.worker = null; }

  async _ensureLibLoaded() {
    if (window.Tesseract) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = TESSERACT_CDN_URL;
      script.onload = resolve;
      script.onerror = () => reject(new Error("โหลด Tesseract.js จาก CDN ไม่สำเร็จ (ตรวจสอบอินเทอร์เน็ต)"));
      document.head.appendChild(script);
    });
  }

  async recognize(imageSource, onProgress) {
    await this._ensureLibLoaded();
    if (!window.Tesseract) throw new Error("ไม่พบไลบรารี Tesseract.js หลังโหลดเสร็จ");

    onProgress?.({ status: "กำลังเตรียมตัวอ่านข้อความ...", progress: 0 });
    const { data } = await window.Tesseract.recognize(imageSource, "tha+eng", {
      logger: (m) => {
        if (m.status && typeof m.progress === "number") {
          onProgress?.({ status: translateStatus(m.status), progress: m.progress });
        }
      },
    });
    return (data?.text || "").trim();
  }
}

/** ตัวอย่าง adapter สำหรับต่อ OCR endpoint ของคุณเอง (server ทำ OCR แทน ไม่มี key ฝั่ง client) */
class EndpointProvider {
  constructor(endpointUrl = "/api/ocr") { this.endpointUrl = endpointUrl; }

  async recognize(imageBlob, onProgress) {
    onProgress?.({ status: "กำลังส่งภาพไปประมวลผล...", progress: 0.2 });
    const form = new FormData();
    form.append("image", imageBlob, "selection.png");

    const res = await fetch(this.endpointUrl, { method: "POST", body: form });
    if (!res.ok) throw new Error(`OCR endpoint ตอบกลับผิดพลาด (${res.status})`);
    onProgress?.({ status: "กำลังอ่านผลลัพธ์...", progress: 0.8 });
    const data = await res.json();
    return (data.text || "").trim();
  }
}

/** ใช้ตอนไม่มีอินเทอร์เน็ต/ยังไม่ตั้งค่า provider จริง — ให้ทดสอบ UI/flow ได้ครบโดยไม่ล้ม */
class DemoProvider {
  async recognize(_imageSource, onProgress) {
    onProgress?.({ status: "โหมดทดลอง: กำลังจำลองการอ่านข้อความ...", progress: 0.3 });
    await new Promise((r) => setTimeout(r, 500));
    onProgress?.({ status: "โหมดทดลอง: เกือบเสร็จแล้ว...", progress: 0.8 });
    await new Promise((r) => setTimeout(r, 400));
    return "[โหมดทดลอง] จงอธิบายความแตกต่างระหว่างพันธะไอออนิกกับพันธะโคเวเลนต์ พร้อมยกตัวอย่างสารประกอบอย่างละ 2 ชนิด";
  }
}

function translateStatus(status) {
  const map = {
    "loading tesseract core": "กำลังโหลดตัวอ่านข้อความ...",
    "initializing tesseract": "กำลังเริ่มต้นระบบ...",
    "loading language traineddata": "กำลังโหลดชุดภาษา...",
    "initializing api": "กำลังเตรียมพร้อม...",
    "recognizing text": "กำลังอ่านข้อความ...",
  };
  return map[status] || status;
}

/* ============================ Public API ============================ */

export const OCR_PROVIDERS = {
  tesseract: () => new TesseractProvider(),
  endpoint: (url) => new EndpointProvider(url),
  demo: () => new DemoProvider(),
};

/**
 * ตัดพื้นที่ที่เลือก (selection rectangle เป็นพิกัด canvas จริง) ออกมาเป็น canvas ใหม่
 */
export function cropSelectionToCanvas(sourceCanvas, selection) {
  const { x, y, width, height } = selection;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(width));
  out.height = Math.max(1, Math.round(height));
  const ctx = out.getContext("2d");
  ctx.drawImage(sourceCanvas, x, y, width, height, 0, 0, out.width, out.height);
  return out;
}

/**
 * ฟังก์ชันหลักที่ UI เรียกใช้: อ่านข้อความจากบริเวณที่เลือกบนใบงาน
 * @param {HTMLCanvasElement} sourceCanvas ใบงานเต็มที่แสดงบนจอ (พิกัด canvas จริง)
 * @param {{x,y,width,height}} selection กรอบที่ผู้ใช้ลากเลือก (พิกัด canvas จริง)
 * @param {object} opts { provider, onProgress }
 * @returns {Promise<string>} ข้อความที่อ่านได้ (ให้ผู้ใช้ตรวจ/แก้ในกล่องข้อความต่อ ไม่ใช่ใช้ทันที)
 */
export async function extractQuestionFromSelection(sourceCanvas, selection, opts = {}) {
  const provider = opts.provider || OCR_PROVIDERS.tesseract();
  const onProgress = opts.onProgress || (() => {});

  if (!selection || selection.width < 8 || selection.height < 8) {
    throw new Error("กรุณาลากเลือกบริเวณโจทย์บนใบงานก่อน (พื้นที่เล็กเกินไป)");
  }

  const cropped = cropSelectionToCanvas(sourceCanvas, selection);

  try {
    const text = await provider.recognize(cropped, onProgress);
    if (!text) throw new Error("อ่านข้อความไม่พบ ลองลากเลือกให้ครอบคลุมโจทย์ให้ชัดเจนขึ้น");
    return text;
  } catch (err) {
    // ห่อ error ให้มีข้อความที่พร้อมแสดงผู้ใช้ตรงๆ พร้อมช่องให้ retry ทำที่ชั้น UI
    throw new Error(err.message || "อ่านข้อความจากภาพไม่สำเร็จ");
  }
}
