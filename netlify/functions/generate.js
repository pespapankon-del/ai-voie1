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

  const { mode, question, subject, language = "th", detailLevel = "step-by-step", imageBase64, mediaType } = body;

  // ─── autofill mode ───
  if (mode === "autofill") {
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return { statusCode: 400, body: JSON.stringify({ error: "ต้องส่ง imageBase64 สำหรับ autofill" }) };
    }
    const autofillSystem = [
      `คุณเป็นครูที่ช่วยวิเคราะห์ใบงาน/ข้อสอบวิชา "${subject || "ทั่วไป"}"`,
      "มองหาทุกช่องที่ว่าง ทุกโจทย์ หรือทุกตารางที่รอคำตอบในภาพ",
      "สำหรับแต่ละช่อง ให้ระบุตำแหน่งกรอบของช่องนั้นเป็นสัดส่วน (0.0-1.0) ของขนาดภาพทั้งหมด",
      "และเขียนคำตอบสั้นๆ เหมาะสำหรับคัดด้วยลายมือ ไม่เกิน 3-4 บรรทัดต่อช่อง",
      'ตอบเป็น JSON รูปแบบ: {"cells":[{"question":"...","answer":"...","xFrac":0.1,"yFrac":0.2,"wFrac":0.4,"hFrac":0.08}]}',
      "ห้ามมีข้อความอื่นนอกจาก JSON เด็ดขาด",
    ].join(" ");
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 4000,
          system: autofillSystem,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageBase64 } },
              { type: "text", text: "วิเคราะห์ใบงานนี้แล้วตอบเป็น JSON ตามที่กำหนด" },
            ],
          }],
        }),
      });
      if (!response.ok) return { statusCode: 502, body: JSON.stringify({ error: "เรียก AI ไม่สำเร็จ" }) };
      const data = await response.json();
      const rawText = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { statusCode: 502, body: JSON.stringify({ error: "AI ไม่ตอบ JSON ที่คาดหวัง" }) };
      const parsed = JSON.parse(jsonMatch[0]);
      return { statusCode: 200, body: JSON.stringify({ cells: Array.isArray(parsed.cells) ? parsed.cells : [] }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: "เกิดข้อผิดพลาดขณะวิเคราะห์ใบงาน" }) };
    }
  }

  // ─── mode ปกติ ───
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
