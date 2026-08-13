/**
 * netlify/functions/generate-image.js — เวอร์ชัน Netlify Functions ของ /api/generate-image
 * ตรรกะเดียวกับ api/generate-image.js (Vercel) ตั้งค่า OPENAI_API_KEY ใน Netlify env vars
 */

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "ใช้ได้เฉพาะ POST method" }) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { statusCode: 501, body: JSON.stringify({ error: "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า OPENAI_API_KEY" }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "JSON ไม่ถูกต้อง" }) }; }

  const { prompt, size = "1024x1024" } = body;
  if (!prompt || typeof prompt !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "ต้องระบุ prompt เป็นข้อความ" }) };
  }

  const ALLOWED_SIZES = ["1024x1024", "1024x1536", "1536x1024"];
  const finalSize = ALLOWED_SIZES.includes(size) ? size : "1024x1024";

  try {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "gpt-image-2", prompt, n: 1, size: finalSize, moderation: "auto" }),
    });

    if (!response.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "เรียก OpenAI Images API ไม่สำเร็จ" }) };
    }

    const data = await response.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      return { statusCode: 502, body: JSON.stringify({ error: "OpenAI ไม่ได้ส่งข้อมูลภาพกลับมา" }) };
    }

    return { statusCode: 200, body: JSON.stringify({ imageBase64: b64, mimeType: "image/png" }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุบนเซิร์ฟเวอร์" }) };
  }
};
