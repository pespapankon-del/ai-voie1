/**
 * /api/generate-image — Vercel Serverless Function
 * -----------------------------------------------------------------------
 * เรียก OpenAI GPT Image 2 (model: gpt-image-2) เพื่อสร้างภาพประกอบ โดยใช้ API key
 * ที่เก็บเป็น Environment Variable บนเซิร์ฟเวอร์เท่านั้น (ตั้งค่าใน Vercel Dashboard)
 *
 * ตั้งค่า OPENAI_API_KEY ก่อน deploy จริง — ถ้ายังไม่ตั้งค่า จะตอบ 501 กลับไป
 * ให้ frontend (image-service.js) สลับไปใช้ demo mode เองอัตโนมัติ
 * -----------------------------------------------------------------------
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "ใช้ได้เฉพาะ POST method" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(501).json({ error: "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า OPENAI_API_KEY" });
    return;
  }

  const { prompt, size = "1024x1024" } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "ต้องระบุ prompt เป็นข้อความ" });
    return;
  }

  const ALLOWED_SIZES = ["1024x1024", "1024x1536", "1536x1024"];
  const finalSize = ALLOWED_SIZES.includes(size) ? size : "1024x1024";

  try {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-image-2", // ตรวจสอบชื่อรุ่นล่าสุดใน OpenAI API docs ก่อน deploy จริง เผื่อมีการเปลี่ยนชื่อ
        prompt,
        n: 1,
        size: finalSize,
        moderation: "auto",
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error("OpenAI Images API error:", errBody);
      res.status(502).json({ error: "เรียก OpenAI Images API ไม่สำเร็จ" });
      return;
    }

    const data = await response.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      res.status(502).json({ error: "OpenAI ไม่ได้ส่งข้อมูลภาพกลับมา" });
      return;
    }

    res.status(200).json({ imageBase64: b64, mimeType: "image/png" });
  } catch (err) {
    console.error("generate-image handler error:", err);
    res.status(500).json({ error: "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุบนเซิร์ฟเวอร์" });
  }
}
