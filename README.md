# เขียนให้ — AI Handwriting Homework Generator

อัปโหลดใบงานจาก iPad (Goodnotes, Notability, Files) → เลือกโจทย์ → ให้ AI ช่วยแก้ → เขียนวิธีทำด้วย
"ลายมือของคุณเอง" (ฝึกด้วย Apple Pencil) ลงบนใบงานเดิม → ส่งออกเป็น PNG/ZIP/PDF

Tech stack: **HTML + CSS + Vanilla JavaScript (ES Modules)** ล้วน ไม่มี build step, ไม่มี framework
พร้อม deploy บน Vercel หรือ Netlify ได้ทันที

---

## โครงสร้างโปรเจกต์

```
handwriting-homework/
├── index.html                 หน้า UI หลัก (3 แท็บ: ใบงาน / ฝึกลายมือ / ตั้งค่า-ส่งออก)
├── styles.css                 สไตล์ทั้งหมด (ธีมปกสมุดเขียว, responsive, iPad safe-area)
├── app.js                     entry point หลัก เชื่อมทุก module เข้าด้วยกัน
├── js/
│   ├── canvas-editor.js       work area: selection rectangle, resize handles, zoom/pan, crop/delete
│   ├── handwriting-engine.js  เรนเดอร์ text layer ด้วยลายเส้นที่ฝึกไว้ / ฟอนต์ fallback
│   ├── handwriting-trainer.js หน้าฝึกลายมือด้วย Apple Pencil (Pointer Events)
│   ├── pdf-manager.js         เปิด PDF ด้วย PDF.js, thumbnail, เรนเดอร์หน้า
│   ├── ocr-service.js         adapter สำหรับอ่านข้อความจากรูป (Tesseract.js / endpoint / demo)
│   ├── ai-service.js          เรียก /api/generate (ไม่มี key ฝั่ง client)
│   ├── image-service.js       เรียก /api/generate-image สำหรับสร้างภาพประกอบ (GPT Image 2)
│   ├── layers.js              โมเดล text layer + undo/redo
│   ├── storage.js             IndexedDB (เอกสาร/โปรไฟล์) + localStorage (preference)
│   └── exporter.js            ส่งออก PNG / ZIP / PDF ที่ 1x/2x/3x
├── api/
│   ├── generate.js            Vercel Serverless Function (เรียก AI provider ฝั่งเซิร์ฟเวอร์)
│   └── generate-image.js      Vercel Serverless Function (เรียก GPT Image 2 สร้างภาพประกอบ)
├── netlify/functions/
│   ├── generate.js            เวอร์ชัน Netlify Functions ของ endpoint เดียวกัน
│   └── generate-image.js      เวอร์ชัน Netlify Functions ของ /api/generate-image
├── netlify.toml                redirect /api/* → netlify function
└── assets/fonts/                วางไฟล์ฟอนต์ลายมือ (.ttf/.woff2) ที่นี่ถ้าต้องการ (หรืออัปโหลดผ่าน UI ก็ได้)
```

---

## รันทดสอบในเครื่อง

โปรเจกต์ใช้ ES Modules (`type="module"`) จึงต้องรันผ่าน HTTP server ท้องถิ่น เปิดจาก `file://` ตรงๆ ไม่ได้:

```bash
cd handwriting-homework
npx serve .
# หรือ
python3 -m http.server 5500
```

แล้วเปิด `http://localhost:5500` (หรือพอร์ตที่ serve แจ้ง)

> **หมายเหตุ:** ฟีเจอร์ที่ต้อง fetch จาก `/api/generate` (ให้ AI ตอบ) จะไม่พบ endpoint นี้เมื่อรันด้วย static server เฉยๆ — ระบบจะสลับเป็น **โหมดทดลอง (demo mode)** ให้อัตโนมัติ เพื่อให้ทดสอบ UI/UX ได้ครบทุกฟีเจอร์โดยไม่ต้องมี backend จริง ถ้าต้องการทดสอบ AI จริง ให้รันผ่าน `vercel dev` แทน (ดูหัวข้อ Deploy)

---

## ตั้งค่า AI ให้ทำงานจริง (ไม่บังคับสำหรับทดสอบ UI)

1. สมัครและสร้าง API key จาก Anthropic (หรือ AI provider อื่นที่ต้องการ — ปรับโค้ดใน `api/generate.js` ได้)
2. **Vercel:** Project Settings → Environment Variables → เพิ่ม `ANTHROPIC_API_KEY`
3. **Netlify:** Site configuration → Environment variables → เพิ่ม `ANTHROPIC_API_KEY`
4. ตรวจสอบชื่อรุ่น (model) ล่าสุดใน Anthropic API docs ก่อน deploy จริง เพราะชื่อรุ่นอาจเปลี่ยนหลังจากไฟล์นี้ถูกเขียน (ปัจจุบันตั้งไว้เป็น `claude-sonnet-5` ใน `api/generate.js` และ `netlify/functions/generate.js`)

ถ้าไม่ตั้งค่า key: endpoint จะตอบ `501` และ frontend จะสลับไปโหมดทดลองให้เองอัตโนมัติ (ไม่มีอะไรพัง)

### สร้างภาพประกอบด้วย GPT Image 2 (ฟีเจอร์เสริม ไม่บังคับ)

แท็บ "ตั้งค่า/ส่งออก" มีช่องสร้างภาพประกอบแยกต่างหาก (เช่น ไดอะแกรมประกอบคำตอบ) เรียกผ่าน `/api/generate-image` ด้วยหลักการเดียวกัน: **ไม่มี key ฝั่ง frontend เด็ดขาด**

1. สมัคร API key จาก OpenAI ([platform.openai.com](https://platform.openai.com)) — โมเดล `gpt-image-2` อาจต้องผ่าน Organization Verification ก่อนใช้งานได้ ตรวจสอบในหน้า developer console
2. **Vercel:** Project Settings → Environment Variables → เพิ่ม `OPENAI_API_KEY`
3. **Netlify:** Site configuration → Environment variables → เพิ่ม `OPENAI_API_KEY`
4. **ห้ามใส่ค่านี้ในหน้าเว็บ ในโค้ด หรือใน `.env` ที่ commit ขึ้น git เด็ดขาด** — ใส่ผ่านหน้า dashboard ของ Vercel/Netlify เท่านั้น เพราะเป็นที่เดียวที่เข้ารหัสเก็บอย่างปลอดภัยและไม่ถูกส่งไปให้ browser ผู้ใช้เห็น

ถ้าไม่ตั้งค่า key: ปุ่ม "สร้างภาพ" จะแจ้งโหมดทดลองแทน ไม่ error/พัง

> ฟีเจอร์นี้เป็นเครื่องมือสร้างภาพแยกต่างหาก (ดาวน์โหลดเก็บไว้ใช้เอง) ยังไม่ได้ผูกเป็นเลเยอร์บนใบงานอัตโนมัติเหมือน text layer — ถ้าต้องการให้วางภาพที่ AI สร้างลงบนใบงานโดยตรงและลาก/ปรับขนาดได้แบบเดียวกับ text layer เป็นส่วนขยายที่ทำเพิ่มได้ในรอบถัดไป

---

## Deploy

### Vercel
```bash
npm i -g vercel
vercel
```
Vercel จะเจอ `api/generate.js` และสร้าง serverless function ให้อัตโนมัติ ไม่ต้องตั้งค่าเพิ่ม
(นอกจาก Environment Variable ด้านบน)

### Netlify
```bash
npm i -g netlify-cli
netlify deploy
```
ไฟล์ `netlify.toml` ตั้งค่า redirect `/api/*` ไปยัง `netlify/functions/*` ให้แล้ว
เพื่อให้ frontend เรียก `/api/generate` ได้เหมือนกันทั้งสองแพลตฟอร์มโดยไม่ต้องแก้โค้ด

---

## Workflow การใช้งาน

1. **แท็บ "ใบงาน"** — ลากไฟล์ (PNG/JPG/WebP/PDF) มาวาง หรือเลือกไฟล์ ถ้าเป็น PDF จะมีแถบ thumbnail ให้เลือกหน้า
2. ลากเลือกกรอบบริเวณโจทย์บนใบงาน (ลากมุมเพื่อปรับขนาด, ลากกลางกรอบเพื่อย้าย)
3. กด **"อ่านข้อความจากบริเวณที่เลือก"** (OCR) → ตรวจ/แก้ข้อความในกล่องโจทย์
4. เลือกวิชา แล้วกด **"ให้ AI ช่วยแก้โจทย์"** → ได้วิธีทำ + คำตอบ แก้ไขได้ก่อนใช้จริง
5. กด **"วางคำตอบนี้ลงบนใบงาน"** → สร้างเป็น text layer เลือก/คัดลอก/ลบ/undo-redo ได้จากช่อง "เลเยอร์ลายมือ"
6. **แท็บ "ฝึกลายมือ"** — เลือกชุดฝึก (ไทย/อังกฤษ/ตัวเลข/คณิตศาสตร์) → เขียนด้วย Apple Pencil/นิ้ว → บันทึกได้สูงสุด 5 ตัวอย่างต่อตัวอักษร
7. **แท็บ "ตั้งค่า/ส่งออก"** — ปรับความเอียง/ระยะห่าง/ความหนาเส้นของลายมือ, ปรับตำแหน่ง/ขนาด/หมุนของเลเยอร์ที่เลือก, เลือกความละเอียด แล้วดาวน์โหลด PNG/ZIP/PDF

---

## ฟีเจอร์ที่ทำเสร็จแล้ว

- นำเข้าไฟล์ PNG/JPG/WebP/PDF ทั้ง drag-and-drop และ file picker พร้อมตรวจชนิด/ขนาดไฟล์
- เปิด PDF หลายหน้าด้วย PDF.js พร้อมแถบ thumbnail และ render ตามความละเอียดที่เลือก
- Work area: selection rectangle + resize handles (8 จุด), crop, ลบพื้นที่ที่เลือก, รีเซ็ต, ซูมด้วยปุ่ม/ctrl+wheel, แพน — ใช้พิกัด canvas จริงตลอด (ซูม/แพนไม่กระทบตำแหน่ง layer ตอน export)
- OCR ผ่าน adapter pattern (Tesseract.js เป็นค่าเริ่มต้น, มี endpoint adapter ตัวอย่าง, มี demo fallback เมื่อโหลด Tesseract ไม่ได้) พร้อม loading/progress/error/retry
- เรียก AI ผ่าน `/api/generate` เท่านั้น ไม่มี key ฝั่ง client, มี demo mode อัตโนมัติ
- Text layers หลายชิ้นต่อหน้า: เพิ่ม/คัดลอก/ลบ/undo-redo ได้ ปรับตำแหน่ง/ขนาดกรอบ/ฟอนต์ไซส์/ระยะบรรทัด/สี/หมุน/scale ได้ทีละ layer
- ระบบฝึกลายมือ Apple Pencil เดิม (Pointer Events, บันทึกพิกัด+แรงกด) ยังทำงานอยู่ครบ + เพิ่ม 5 ตัวอย่าง/ตัวอักษร, seeded random เลือก variant (preview ไม่กระพริบ), ปรับความเอียง/character spacing/baseline jitter/word spacing/stroke thickness ได้, จัดวางสระบน-ล่างและวรรณยุกต์ไทยแบบ stack ไม่ชนกัน, ชุดฝึกคณิตศาสตร์/เคมี/เลขยกกำลัง/เศษส่วน, progress แยกตามหมวด, export/import โปรไฟล์เป็น JSON พร้อม validate
- **"ชุดจำเป็น" (core set) — 37 ตัวอักษรที่คัดจากความถี่การใช้งานจริงของภาษาไทย** (พยัญชนะ 20 ตัวที่พบบ่อยที่สุด + สระ/วรรณยุกต์ที่จำเป็น) เป็นชุดฝึกเริ่มต้น พร้อม progress bar "ความพร้อมใช้งาน" แยกเด่นในแท็บฝึกลายมือ — ไม่ต้องฝึกครบ 44 พยัญชนะก็ใช้งานได้จริง
- **Coverage notice ก่อนวางคำตอบลงกระดาษ** — เมื่อพิมพ์/ได้คำตอบจาก AI มา ระบบคำนวณและแจ้งทันทีว่าคำตอบนี้จะแสดงด้วย "ลายมือจริง" กี่ % ส่วนที่เหลือ (ตัวที่ยังไม่ได้ฝึก) จะใช้ฟอนต์ fallback แทนชั่วคราว พร้อมบอกว่าตัวไหนที่ยังไม่ได้ฝึก — ไม่บล็อกการใช้งาน แค่แจ้งให้ทราบก่อนตัดสินใจ
- Export: PNG ต่อหน้า, ZIP ทุกหน้า (JSZip), PDF ทุกหน้า (jsPDF) ที่ความละเอียด 1x/2x/3x
- IndexedDB เก็บเอกสาร+โปรไฟล์ลายมือแบบ autosave, localStorage เก็บ preference เล็กๆ, ปุ่มเริ่มงานใหม่ (มี confirmation) และเปิดงานล่าสุด, จัดการ storage quota error
- iPad UI: ปุ่มสัมผัส ≥44×44px, safe-area padding, `touch-action:none` บน canvas ระหว่างเขียน/เลือกพื้นที่กันหน้าเว็บเลื่อน, แท็บที่เข้าถึงง่าย, ข้อความไทยสั้นเข้าใจง่าย, คงธีมปกสมุดเขียวเดิมไว้ทั้งหมด
- Code quality: แยกเป็น ES modules ตามที่ระบุ, ไม่มี global variable รั่ว (ครอบด้วย module scope), ไม่ใช้ `innerHTML` กับข้อมูลผู้ใช้/ไฟล์ (ใช้ `textContent`/`createElement` แทนทั้งหมด), มี error handling ครอบทุก async operation หลัก

---

## ข้อจำกัดที่ยังเหลือ (ตรงไปตรงมา)

- **ลาก-ย้าย layer โดยตรงบน canvas ยังไม่รองรับ** — ตอนนี้ย้ายตำแหน่ง/ขนาด/หมุนเลเยอร์ผ่าน slider ในแท็บ "ตั้งค่า" แทน (เพราะ overlay canvas ถูกใช้สำหรับ selection rectangle ของ OCR อยู่แล้ว การทำ dual-mode drag ต้องออกแบบ UX เพิ่มเติมเพื่อไม่ให้ผู้ใช้สับสนระหว่างสองโหมด) — เป็นทางเลือกที่แม่นยำกว่าแต่ไม่ใช่ gesture โดยตรงตามที่ระบุไว้ในสเปค
- **Pinch-to-zoom ด้วยสองนิ้วบน iPad ยังไม่รองรับ** — รองรับเฉพาะปุ่ม +/− และ ctrl+scroll (trackpad) เพราะ `touch-action:none` ปิด native pinch ของเบราว์เซอร์ไปด้วย การทำ multi-touch pinch เองต้องมี pointer tracking เพิ่มเติมที่ยังไม่ได้ implement
- **OCR ความแม่นยำภาษาไทยมือเขียน** — Tesseract.js อ่านลายมือ (ไม่ใช่ตัวพิมพ์) ได้ไม่แม่นยำนัก โดยเฉพาะลายมือไทย แนะนำให้ผู้ใช้ตรวจ/แก้ในกล่องข้อความเสมอ (มี UI รองรับอยู่แล้ว) หรือสลับไปใช้ EndpointProvider ต่อ OCR service ที่แม่นยำกว่า เช่น Google Vision ผ่าน backend ของคุณเอง
- **Multi-page layer sync ระหว่างสลับหน้า PDF** — layer ผูกกับหน้าเดิมถูกต้อง แต่ history undo/redo เป็น stack เดียวใช้ร่วมกันทุกหน้า ไม่ได้แยกประวัติต่อหน้า (สลับหน้าแล้วกด undo จะย้อนของหน้าปัจจุบัน แต่ stack ที่สะสมมาจากหน้าอื่นก่อนหน้านี้อาจปนกัน) — ใช้งานได้จริงแต่ควรระวังเวลาทำงานหลายหน้าสลับไปมาถี่ๆ
- **ยังไม่ได้ทดสอบบน iPad/Safari จริง** — ตรวจสอบด้วย static analysis + jsdom simulation (โหลดแอปจริง จำลอง event หลักๆ ผ่านไม่มี error) แต่ยังไม่ได้รันบนอุปกรณ์จริง โดยเฉพาะพฤติกรรม Apple Pencil pressure/palm rejection ที่ควรทดสอบบนเครื่องจริงก่อนใช้งานจริงจัง
- **ระบบเก่า (Firebase Auth/Firestore) ของโปรเจกต์ตัวอย่างแรก ไม่ได้นำมาใช้ในเวอร์ชันนี้** — เวอร์ชันนี้ใช้ IndexedDB + localStorage ตามสเปคที่ระบุแทน (ไม่มีระบบล็อกอิน/sync ข้ามเครื่อง นอกจาก export/import โปรไฟล์เป็น JSON ด้วยมือ)
- **CDN dependencies** — PDF.js, Tesseract.js, JSZip, jsPDF โหลดจาก CDN แบบ lazy (โหลดเมื่อใช้ฟีเจอร์นั้นจริง) ต้องมีอินเทอร์เน็ตตอนใช้ครั้งแรก ถ้าอยากให้ทำงาน offline ทั้งหมดต้อง self-host ไฟล์เหล่านี้เอง

---

## การทดสอบที่ทำไปแล้ว

- `node --check` ผ่านทุกไฟล์ JS ทั้งแบบ CommonJS และ ESM
- ตรวจสอบ id ทุกตัวที่ `app.js` อ้างอิงกับ `index.html` ตรงกันครบ (ไม่มี id ขาดหาย)
- ตรวจสอบทุก `els.xxx` ที่ใช้ในโค้ดมีการประกาศ key ไว้จริง (ไม่มี `undefined` reference)
- จำลองโหลดแอปเต็มรูปแบบด้วย `jsdom` + `fake-indexeddb`: โหลดหน้าเว็บ, รัน `app.js`, ตรวจว่าไม่มี error ตอน initialize (รวม autosave/profile setup/IndexedDB)
- จำลอง interaction จริง: สลับแท็บ, สร้างโปรไฟล์ลายมือใหม่, เปลี่ยนชุดฝึก, เลือกตัวอักษรฝึก, ปรับ slider ความเอียง — ผ่านทั้งหมดโดยไม่มี error
- **ยังไม่ได้ทดสอบ**: การอัปโหลดไฟล์รูป/PDF จริง, OCR จริง, เรียก AI จริง, export ไฟล์จริง (เพราะ sandbox นี้ไม่มี headless browser ที่รองรับ canvas 2D/PDF.js/Tesseract.js เต็มรูปแบบ) — แนะนำให้ทดสอบ workflow เต็มบนเบราว์เซอร์จริงก่อนใช้งานจริง โดยเฉพาะบน Safari/iPad ตามเป้าหมายของโปรเจกต์
