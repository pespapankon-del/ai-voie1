/**
 * netlify/functions/generate.js — เวอร์ชัน Netlify Functions ของ /api/generate
 * ใช้ตรรกะเดียวกับ api/generate.js (สำหรับ Vercel) แต่ export ในรูปแบบ Netlify
 * ถ้า deploy บน Netlify ต้องตั้งค่า netlify.toml ให้ redirect /api/generate -> ฟังก์ชันนี้ (ดู README)
 */

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "ใช้ได้เฉพาะ POST method" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 501, body: JSON.stringify({ error: "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY" }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "JSON ไม่ถูกต้อง" }) }; }

  const { question, subject, language = "th", detailLevel = "step-by-step" } = body;
  if (!question || typeof question !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "ต้องระบุ question เป็นข้อความ" }) };
  }

  const systemPrompt = [
    `คุณเป็นครูผู้ช่วยที่อธิบายวิธีทำการบ้านวิชา "${subject || "ทั่วไป"}" ให้นักเรียนเข้าใจทีละขั้นตอน`,
    language === "th" ? "ตอบเป็นภาษาไทยเท่านั้น" : `ตอบเป็นภาษา ${language}`,
    detailLevel === "step-by-step"
      ? "แสดงวิธีทำเป็นขั้นตอนลำดับเลข 1. 2. 3. ตามด้วยคำตอบสุดท้ายในบรรทัดท้ายสุด ขึ้นต้นด้วย 'คำตอบ:'"
      : "ตอบให้กระชับตรงประเด็น",
    "เขียนให้สั้นพอที่จะคัดลอกลงสมุดด้วยลายมือได้จริง",
  ].join(" ");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!response.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "เรียก AI provider ไม่สำเร็จ" }) };
    }

    const data = await response.json();
    const rawText = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
    const steps = lines.filter((l) => /^\d+[.)]/.test(l)).map((l) => l.replace(/^\d+[.)]\s*/, ""));

    return { statusCode: 200, body: JSON.stringify({ answer: rawText, steps }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุบนเซิร์ฟเวอร์" }) };
  }
};
