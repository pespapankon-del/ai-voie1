/**
 * handwriting-engine.js
 * -----------------------------------------------------------------------
 * รับผิดชอบการ "วาด" ข้อความหนึ่ง layer ลงบน canvas โดย:
 *  - ถ้ามีลายเส้นที่ผู้ใช้ฝึกไว้ (profile.samples[char]) ใช้ลายเส้นจริง (seeded random เลือก variant)
 *  - ถ้ายังไม่ได้ฝึกตัวอักษรนั้น ใช้ฟอนต์ fallback แทน และรายงานกลับว่าตัวไหนยังไม่ได้ฝึก
 *  - จัดวางสระบน/ล่าง วรรณยุกต์ภาษาไทยแบบ stack ไม่ให้ทับกัน
 *  - รองรับ character spacing, word spacing, baseline jitter, ความเอียง (slant), stroke thickness
 * -----------------------------------------------------------------------
 */

export const FALLBACK_FONT_FAMILY = "Mali"; // โหลดจาก Google Fonts ใน index.html — ผู้ใช้อัปโหลดฟอนต์ของตัวเองแทนได้ (ดู app.js: loadCustomFallbackFont)

/* ---------- Seeded random (deterministic ต่อ layer+ตำแหน่ง เพื่อไม่ให้ preview กระพริบทุกครั้ง) ---------- */
function hashStringToInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seededRandom(seedString) {
  return mulberry32(hashStringToInt(seedString))();
}

/* ---------- Thai combining marks: อยู่เหนือ/ใต้พยัญชนะ ไม่กินความกว้างของตัวเอง ---------- */
const THAI_ABOVE = new Set(["ั", "ิ", "ี", "ึ", "ื", "็", "่", "้", "๊", "๋", "์", "ํ"]);
const THAI_BELOW = new Set(["ุ", "ู", "ฺ"]);
export function isCombiningAbove(ch) { return THAI_ABOVE.has(ch); }
export function isCombiningBelow(ch) { return THAI_BELOW.has(ch); }
export function isCombiningMark(ch) { return isCombiningAbove(ch) || isCombiningBelow(ch); }

/* ---------- ตัดคำ: ใช้ Intl.Segmenter (รองรับไทย) ถ้ามี ไม่งั้น fallback เป็นตัดทีละตัวอักษร ---------- */
let thSegmenter = null;
try {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    thSegmenter = new Intl.Segmenter("th", { granularity: "word" });
  }
} catch { thSegmenter = null; }

function segmentWords(text) {
  if (thSegmenter) {
    return Array.from(thSegmenter.segment(text), (s) => s.segment);
  }
  // fallback: แยกด้วยช่องว่าง (ภาษาอังกฤษ) ตัวอักษรไทยจะติดกันเป็นก้อนเดียว ซึ่งยัง wrap ทีละตัวได้ในชั้นถัดไป
  return text.split(/(\s+)/);
}

/**
 * ตัดข้อความให้พอดีกับความกว้าง layer.width โดยวัดความกว้างจริงด้วย ctx.measureText
 * คืนค่าเป็น array ของบรรทัด (string[])
 */
export function wrapLayerText(ctx, text, maxWidth, fontFamily, fontSizePx) {
  ctx.font = `${fontSizePx}px ${fontFamily}`;
  const paragraphs = text.split("\n");
  const lines = [];

  paragraphs.forEach((para) => {
    if (para.trim() === "") { lines.push(""); return; }
    const words = segmentWords(para);
    let current = "";
    words.forEach((word) => {
      const test = current + word;
      if (ctx.measureText(test).width > maxWidth && current.trim() !== "") {
        lines.push(current);
        current = word.trimStart();
      } else {
        current = test;
      }
      // คำเดี่ยวยาวเกิน maxWidth เอง (เช่นคำอังกฤษยาวๆ) -> ตัดทีละตัวอักษรเพิ่ม
      while (ctx.measureText(current).width > maxWidth && current.length > 1) {
        let cut = current.length - 1;
        while (cut > 1 && ctx.measureText(current.slice(0, cut)).width > maxWidth) cut--;
        lines.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    });
    if (current) lines.push(current);
  });

  return lines;
}

/**
 * วาด layer หนึ่งชิ้นลงบน ctx (พิกัด canvas จริง)
 * options: { fallbackFontFamily, showSelection:boolean }
 * คืนค่า { untrainedChars: Set<string>, lineCount:number }
 */
export function renderLayer(ctx, layer, profile, options = {}) {
  const fallbackFont = options.fallbackFontFamily || FALLBACK_FONT_FAMILY;
  const settings = (profile && profile.settings) || {
    slant: 0, charSpacing: 0, baselineJitter: 0, wordSpacing: 0, strokeThickness: 2,
  };
  const untrainedChars = new Set();

  ctx.save();
  ctx.translate(layer.x, layer.y);
  ctx.rotate(layer.rotation || 0);
  ctx.scale(layer.scale || 1, layer.scale || 1);

  const lines = wrapLayerText(ctx, layer.text, layer.width, fallbackFont, layer.fontSize);

  lines.forEach((line, lineIdx) => {
    let penX = 0;
    const baseY = lineIdx * layer.lineHeight;
    let lastBaseCharAdvance = 0;
    let aboveStack = 0;
    let belowStack = 0;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const seed = `${layer.id}:${lineIdx}:${i}:${ch}`;
      const jitterY = settings.baselineJitter ? (seededRandom(seed) - 0.5) * settings.baselineJitter : 0;

      if (ch === " ") {
        penX += (layer.fontSize * 0.28) + (settings.wordSpacing || 0);
        aboveStack = 0; belowStack = 0;
        continue;
      }

      const trained = profile && profile.samples && profile.samples[ch] && profile.samples[ch].length > 0;

      if (isCombiningMark(ch)) {
        // วางซ้อนบน/ล่างตัวก่อนหน้า ไม่เดินหน้าตำแหน่งปากกา
        const stackOffset = isCombiningAbove(ch)
          ? -(layer.fontSize * 0.55) - aboveStack * layer.fontSize * 0.28
          : (layer.fontSize * 0.15) + belowStack * layer.fontSize * 0.28;
        drawGlyph(ctx, ch, penX - lastBaseCharAdvance * 0.5, baseY + stackOffset + jitterY,
          layer, profile, trained, settings, fallbackFont, untrainedChars, seed);
        if (isCombiningAbove(ch)) aboveStack++; else belowStack++;
        continue;
      }

      aboveStack = 0; belowStack = 0;
      drawGlyph(ctx, ch, penX, baseY + jitterY, layer, profile, trained, settings, fallbackFont, untrainedChars, seed);

      const advance = trained
        ? (profile.samples[ch][0].advance || layer.fontSize * 0.6)
        : ctx.measureText(ch).width || layer.fontSize * 0.55;
      lastBaseCharAdvance = advance;
      penX += advance + (settings.charSpacing || 0);
    }
  });

  ctx.restore();
  return { untrainedChars, lineCount: lines.length };
}

function drawGlyph(ctx, ch, x, y, layer, profile, trained, settings, fallbackFont, untrainedChars, seed) {
  ctx.save();
  ctx.translate(x, y);
  if (settings.slant) ctx.transform(1, 0, Math.tan(settings.slant), 1, 0, 0);

  if (trained) {
    const variants = profile.samples[ch];
    const idx = Math.floor(seededRandom(seed) * variants.length) % variants.length;
    drawStrokeVariant(ctx, variants[idx], layer, layer.inkColor, settings.strokeThickness || 2);
  } else {
    untrainedChars.add(ch);
    ctx.fillStyle = layer.inkColor;
    ctx.font = `${layer.fontSize}px ${fallbackFont}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(ch, 0, 0);
  }
  ctx.restore();
}

/** วาดลายเส้นที่ฝึกไว้ (แต้ม pointer events ที่บันทึกมา) เป็นเส้นโค้ง พร้อมความหนาตามแรงกด */
function drawStrokeVariant(ctx, variant, layer, inkColor, baseThickness) {
  if (!variant || !variant.points || variant.points.length < 2) return;
  const scale = layer.fontSize / (variant.emSize || 100);

  ctx.strokeStyle = inkColor;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const pts = variant.points;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    if (p0.penUp) continue; // ข้ามช่วงที่ยกปากกา (คนละ stroke)
    const pressure = ((p0.pressure ?? 0.5) + (p1.pressure ?? 0.5)) / 2;
    ctx.lineWidth = Math.max(0.6, baseThickness * (0.5 + pressure));
    ctx.beginPath();
    ctx.moveTo(p0.x * scale, p0.y * scale);
    ctx.lineTo(p1.x * scale, p1.y * scale);
    ctx.stroke();
  }
}

/* ---------- Progress ต่อหมวดตัวอักษร (ไทย/อังกฤษ/ตัวเลข/คณิตศาสตร์) ---------- */
export const CHAR_CATEGORIES = {
  thai: [..."กขคฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮะัาิีึืุูเแโใไ่้๊๋์ๆฯ"],
  english: [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"],
  number: [..."0123456789๐๑๒๓๔๕๖๗๘๙"],
  math: ["+", "-", "×", "÷", "=", "≠", "≈", "^", "√", "∑", "π", "/", "(", ")", "₂", "₃", "²", "³"],
};

/**
 * "ชุดจำเป็น" — ตัวอักษรไทยที่คัดจากความถี่การใช้งานจริง (พยัญชนะ 20 ตัวที่พบบ่อยที่สุด
 * ตามงานวิจัยคลังข้อมูลภาษาไทย + สระ/วรรณยุกต์ที่จำเป็นต้องมีในแทบทุกคำ) รวม 37 ตัว
 * แนวคิด: ฝึกแค่ชุดนี้ก็ครอบคลุมข้อความภาษาไทยทั่วไปได้ส่วนใหญ่ โดยไม่ต้องฝึกครบ 44 พยัญชนะ + สระ/วรรณยุกต์ทั้งหมด
 */
export const CORE_THAI_CHARS = [
  // พยัญชนะ 20 ตัวที่พบบ่อยที่สุดในภาษาไทย (ก ถึง ป)
  ..."กขคงจชดนมรลสทพบตอหยป",
  // สระที่จำเป็น (เกือบทุกคำต้องมีสระ ตัดออกไม่ได้)
  ..."ะาิีึืุูเแโไัำ",
  // วรรณยุกต์/เครื่องหมายที่พบบ่อยที่สุด
  ..."่้็",
];

export function computeCoreProgress(profile) {
  const trained = CORE_THAI_CHARS.filter((c) => profile?.samples?.[c]?.length > 0).length;
  return { trained, total: CORE_THAI_CHARS.length, percent: Math.round((trained / CORE_THAI_CHARS.length) * 100) };
}

export function computeTrainingProgress(profile) {
  const result = {};
  Object.entries(CHAR_CATEGORIES).forEach(([cat, chars]) => {
    const trained = chars.filter((c) => profile?.samples?.[c]?.length > 0).length;
    result[cat] = { trained, total: chars.length, percent: Math.round((trained / chars.length) * 100) };
  });
  return result;
}

/**
 * คำนวณว่าข้อความหนึ่งชิ้น (เช่นคำตอบที่กำลังจะวางลงกระดาษ) จะแสดงด้วย "ลายมือจริง" กี่ %
 * ตัวที่เหลือจะตกไปใช้ฟอนต์ fallback — ใช้เตือนผู้ใช้ก่อนวางคำตอบลงใบงาน ไม่ใช่บล็อกการใช้งาน
 * ช่องว่างและ newline ไม่นับ (ไม่ต้องฝึก)
 */
export function computeTextCoverage(text, profile) {
  const chars = [...(text || "")].filter((c) => c !== " " && c !== "\n" && c !== "\t");
  if (chars.length === 0) return { coveredCount: 0, totalCount: 0, percent: 100, missingChars: new Set() };

  const missingChars = new Set();
  let coveredCount = 0;
  chars.forEach((c) => {
    if (profile?.samples?.[c]?.length > 0) coveredCount++;
    else missingChars.add(c);
  });

  return {
    coveredCount,
    totalCount: chars.length,
    percent: Math.round((coveredCount / chars.length) * 100),
    missingChars,
  };
}
