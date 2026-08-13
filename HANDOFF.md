# HANDOFF — บริบทสำหรับ Claude Code (อ่านไฟล์นี้ก่อนเริ่มแก้ไข)

โปรเจกต์นี้พัฒนาต่อเนื่องมาจากการคุยกับ Claude (แชท) หลายรอบ ไฟล์นี้สรุปทุกอย่างที่ตัดสินใจไปแล้ว
เพื่อไม่ให้ Claude Code ต้องถามซ้ำหรือย้อนกลับไปแก้สิ่งที่ตกลงกันแล้ว

## คอนเซปโปรเจกต์

เว็บแอป "เขียนให้" — ผู้ใช้ (นักเรียนขี้เกียจเขียนการบ้าน) อัปโหลดใบงานจาก iPad
(Goodnotes/Notability/Files) → เลือกโจทย์ → AI ช่วยตอบ → เขียนคำตอบด้วย **ลายมือจริงของผู้ใช้เอง**
(ไม่ใช่ฟอนต์ ไม่ใช่ AI สร้างรูปลายมือ) ลงบนใบงานเดิม → export เป็นไฟล์

**หลักการสำคัญที่ตัดสินใจไปแล้วและห้ามเปลี่ยนโดยไม่ปรึกษาก่อน:**
ลายมือใช้วิธี "บันทึกเส้นจริงจาก Apple Pencil แล้วเล่นซ้ำ" (`js/handwriting-engine.js` +
`js/handwriting-trainer.js`) — ไม่ใช่ AI image generation สร้างลายมือ เหตุผล: ควบคุมตำแหน่ง/แก้ไขได้
100% และไม่มีความเสี่ยงสะกดผิด ต่างจาก AI image-gen ที่ยังพลาดเรื่องข้อความยาวๆ ได้เสมอ
(ตรวจสอบแล้วกับข้อมูล 2026: แม้แต่ GPT Image 2 / Nano Banana Pro ที่เก่งสุดก็ยังไม่การันตี 100%
โดยเฉพาะภาษาไทยที่ไม่มีใคร benchmark ไว้ชัดเจน)

## Tech stack (ห้ามเปลี่ยน)

HTML + CSS + Vanilla JavaScript (ES Modules) ล้วน — ไม่มี framework ไม่มี build step
พร้อม deploy บน Vercel/Netlify

## โครงสร้างไฟล์ปัจจุบัน

```
index.html, styles.css, app.js        entry point หลัก
js/canvas-editor.js                    work area: selection, resize handles, zoom/pan, crop
js/handwriting-engine.js               เรนเดอร์ layer ด้วยลายเส้นจริง/ฟอนต์ fallback
js/handwriting-trainer.js              ฝึกลายมือด้วย Apple Pencil
js/pdf-manager.js                      PDF.js: import, thumbnail, render หน้า
js/ocr-service.js                      adapter อ่านข้อความจากภาพ (Tesseract.js/endpoint/demo)
js/ai-service.js                       เรียก /api/generate (ตอบโจทย์)
js/image-service.js                    เรียก /api/generate-image (สร้างภาพประกอบ GPT Image 2)
js/layers.js                           โมเดล text layer + undo/redo
js/storage.js                          IndexedDB (เอกสาร/โปรไฟล์) + localStorage (pref เล็กๆ)
js/exporter.js                         export PNG/ZIP/PDF ที่ 1x/2x/3x
api/generate.js, netlify/functions/generate.js              serverless: AI ตอบโจทย์ (ANTHROPIC_API_KEY)
api/generate-image.js, netlify/functions/generate-image.js  serverless: สร้างภาพ (OPENAI_API_KEY)
```

**กฎที่ตกลงกันแล้ว:** API key ทุกตัวต้องอยู่เป็น Environment Variable บน Vercel/Netlify dashboard
เท่านั้น **ห้ามสร้างช่องกรอก API key ในหน้าเว็บ** เพราะไม่มีระบบ auth จึงไม่ปลอดภัย (คุยกันไปแล้วในแชท)

## บั๊กที่เจอและแก้ไปแล้ว (อย่าทำซ้ำ)

1. Pointer-event listener ซ้อนกันตอนสลับ handwriting profile — แก้ด้วย `trainer.setProfile()`
   แทนการสร้าง `HandwritingTrainer` instance ใหม่ทุกครั้ง
2. Layer edit หายเมื่อย้อนกลับไปหน้า PDF ที่เคยครอบตัด — แก้ให้ `selectPdfPage()` โหลดจาก
   `page.imageDataUrl` ที่บันทึกไว้แทนการ render ใหม่จาก PDF.js ดิบทุกครั้ง
3. Canvas บิดเบี้ยวเพราะ fix `aspect-ratio: 3/4` — เปลี่ยนเป็น CSS grid stacking + `height:auto`
4. เคยใช้ `innerHTML` กับข้อมูลจากไฟล์ผู้ใช้ (PDF thumbnail, progress bar) — เปลี่ยนเป็น
   `createElement`/`textContent` ทั้งหมดแล้วตามกฎ "ห้ามใช้ innerHTML กับข้อมูลผู้ใช้"

## ฟีเจอร์ที่ทำเสร็จแล้ว (ดูรายละเอียดเต็มใน README.md)

ครบ 10 หมวดตามสเปคเดิม + เพิ่มเติมจากการคุยกันภายหลัง:

- **"ชุดจำเป็น" (core training set) 37 ตัวอักษร** — คัดจากความถี่ใช้งานจริงภาษาไทย
  (พยัญชนะ 20 ตัวที่พบบ่อยสุด + สระ/วรรณยุกต์จำเป็น) เป็นชุดฝึกเริ่มต้น ไม่ต้องฝึกครบ 44 ตัว
  ก็ใช้งานได้จริง — อยู่ใน `CORE_THAI_CHARS` ที่ `js/handwriting-engine.js`
- **Coverage notice** — ก่อนวางคำตอบลงกระดาษ ระบบคำนวณ % ที่จะเป็นลายมือจริง vs ฟอนต์ fallback
  ให้ผู้ใช้เห็นล่วงหน้า (ฟังก์ชัน `computeTextCoverage()`)
- **สร้างภาพประกอบด้วย GPT Image 2** — เครื่องมือแยกต่างหาก ดาวน์โหลดเก็บเองได้
  **ยังไม่ได้ผูกเป็นเลเยอร์ลากวางบนใบงาน** (ดู "งานที่ยังไม่เสร็จ" ด้านล่าง)

## งานที่ยังไม่เสร็จ / เป็นโจทย์ต่อไปได้เลย

เรียงตามลำดับที่น่าจะมีประโยชน์สุดก่อน:

1. **ผูกภาพจาก GPT Image 2 เป็น layer ลากวาง/ปรับขนาดบนใบงานได้** เหมือน text layer
   (ตอนนี้แค่ preview + ดาวน์โหลดแยก ไม่อยู่ใน layer system ของ `js/layers.js`)
   ต้องเพิ่ม layer type ใหม่ (image layer) และแก้ `js/exporter.js` ให้ composite ภาพด้วย
2. **ลาก-ย้าย text layer โดยตรงบน canvas** — ตอนนี้ใช้ slider ในแท็บตั้งค่าแทน เพราะ overlay
   canvas ถูกใช้กับ selection rectangle ของ OCR อยู่แล้ว ต้องออกแบบ dual-mode ที่ไม่งง
3. **Pinch-to-zoom สองนิ้วบน iPad** — ตอนนี้มีแค่ปุ่ม +/− และ ctrl+scroll
4. **ยังไม่เคยทดสอบบนเบราว์เซอร์จริง/iPad จริงเลย** — ทดสอบมาแค่ `node --check` +
   jsdom simulation (โหลดแอป + จำลอง interaction หลักๆ ผ่านหมด) จุดที่เสี่ยงสุดคือ
   Apple Pencil pressure/palm rejection ซึ่งจำลองด้วย jsdom ไม่ได้ ต้องทดสอบบนเครื่องจริงก่อนใช้จริงจัง
5. **History undo/redo เป็น stack เดียวรวมทุกหน้า PDF** ไม่ได้แยกต่อหน้า — สลับหน้าถี่ๆ
   แล้ว undo อาจสับสน

## วิธีทดสอบที่ใช้อยู่ (ไม่มี headless browser จริงในสภาพแวดล้อมที่พัฒนามา)

ใช้ `jsdom` + `fake-indexeddb` จำลอง DOM/IndexedDB แล้วโหลด `app.js` จริง ตรวจว่าไม่ throw
error ตอน init และตอน dispatch event หลักๆ (สลับแท็บ, สร้างโปรไฟล์, เลือกตัวอักษรฝึก, ปรับ slider,
กดปุ่มสร้างภาพ) — เป็นการทดสอบระดับ "ไม่มี reference error / wiring ผิด" เท่านั้น
**ไม่ได้ทดสอบพฤติกรรมจริงบน canvas 2D/PDF.js/Tesseract.js** เพราะ jsdom ไม่รองรับเต็มรูปแบบ
แนะนำให้ Claude Code รันบน browser จริง (Playwright/Puppeteer ถ้ามี) เพื่อทดสอบให้ลึกกว่านี้

## คำสั่งที่ควรรันก่อนส่งมอบทุกครั้ง

```bash
# ตรวจ syntax ทุกไฟล์ JS
for f in js/*.js app.js api/*.js netlify/functions/*.js; do node --check --input-type=module < "$f" || echo "FAIL: $f"; done

# ตรวจ id ที่ app.js อ้างอิงกับ index.html ตรงกันครบ
comm -23 <(grep -oE '\$\("[a-zA-Z0-9_-]+"\)' app.js | sed -E 's/\$\("(.*)"\)/\1/' | sort -u) \
         <(grep -oE 'id="[a-zA-Z0-9_-]+"' index.html | sed -E 's/id="(.*)"/\1/' | sort -u)
# ควรไม่มี output ใดๆ ถ้ามี = มี id หาย
```
