/**
 * image-service.js
 * -----------------------------------------------------------------------
 * เรียกใช้ AI สร้างภาพผ่าน serverless endpoint /api/generate-image เท่านั้น
 * ห้ามยิง OpenAI ตรงจาก browser เด็ดขาด (จะทำให้ API key รั่วใน devtools)
 * -----------------------------------------------------------------------
 */

export async function generateImage({ prompt, size = "1024x1024" }) {
  if (!prompt || !prompt.trim()) {
    throw new Error("กรุณาระบุคำอธิบายภาพที่ต้องการก่อน");
  }

  try {
    const res = await fetch("/api/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, size }),
    });

    if (res.status === 404 || res.status === 501) {
      return { isDemo: true, dataUrl: null, message: "ยังไม่ได้ตั้งค่า OPENAI_API_KEY บนเซิร์ฟเวอร์ — ดูวิธีตั้งค่าใน README" };
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `เซิร์ฟเวอร์ตอบกลับผิดพลาด (${res.status})`);
    }

    const data = await res.json();
    if (!data.imageBase64) throw new Error("รูปแบบข้อมูลที่ได้จากเซิร์ฟเวอร์ไม่ถูกต้อง");

    return { isDemo: false, dataUrl: `data:${data.mimeType || "image/png"};base64,${data.imageBase64}` };
  } catch (err) {
    if (err instanceof TypeError) {
      return { isDemo: true, dataUrl: null, message: "ไม่พบ /api/generate-image (รันแบบ static server เฉยๆ หรือยังไม่ deploy)" };
    }
    throw err;
  }
}
