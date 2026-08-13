/**
 * /api/generate — Vercel Serverless Function
 * -----------------------------------------------------------------------
 * รับโจทย์จาก frontend แล้วส่งต่อไปยัง AI provider โดยใช้ API key ที่เก็บเป็น
 * Environment Variable บนเซิร์ฟเวอร์เท่านั้น (ตั้งค่าใน Vercel Dashboard > Settings > Environment Variables)
 *
 * ตั้งค่า ANTHROPIC_API_KEY ก่อน deploy จริง — ถ้ายังไม่ตั้งค่า จะตอบ 501 กลับไป
 * ให้ frontend (ai-service.js) สลับไปใช้ demo mode เองอัตโนมัติ เพื่อให้ทดสอบ UI ได้ครบ
 * -----------------------------------------------------------------------
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "ใช้ได้เฉพาะ POST method" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(501).json({ error: "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY" });
    return;
  }

  const { question, subject, language = "th", detailLevel = "step-by-step" } = req.body || {};
  if (!question || typeof question !== "string") {
    res.status(400).json({ error: "ต้องระบุ question เป็นข้อความ" });
    return;
  }

  const systemPrompt = buildSystemPrompt({ subject, language, detailLevel });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5", // ตรวจสอบชื่อรุ่นล่าสุดใน Anthropic API docs ก่อน deploy จริง
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", errText);
      res.status(502).json({ error: "เรียก AI provider ไม่สำเร็จ" });
      return;
    }

    const data = await response.json();
    const rawText = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    const { answer, steps } = splitAnswerAndSteps(rawText);
    res.status(200).json({ answer, steps });
  } catch (err) {
    console.error("generate handler error:", err);
    res.status(500).json({ error: "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุบนเซิร์ฟเวอร์" });
  }
}

function buildSystemPrompt({ subject, language, detailLevel }) {
  return [
    `คุณเป็นครูผู้ช่วยที่อธิบายวิธีทำการบ้านวิชา "${subject || "ทั่วไป"}" ให้นักเรียนเข้าใจทีละขั้นตอน`,
    language === "th" ? "ตอบเป็นภาษาไทยเท่านั้น" : `ตอบเป็นภาษา ${language}`,
    detailLevel === "step-by-step"
      ? "แสดงวิธีทำเป็นขั้นตอนลำดับเลข 1. 2. 3. ตามด้วยคำตอบสุดท้ายในบรรทัดท้ายสุด ขึ้นต้นด้วย 'คำตอบ:'"
      : "ตอบให้กระชับตรงประเด็น",
    "เขียนให้สั้นพอที่จะคัดลอกลงสมุดด้วยลายมือได้จริง ไม่ต้องมีคำนำหรือคำลงท้ายเกินจำเป็น",
  ].join(" ");
}

/** แยกข้อความดิบจาก AI เป็น { answer, steps[] } ตามรูปแบบ response ที่ frontend คาดหวัง */
function splitAnswerAndSteps(rawText) {
  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
  const steps = lines
    .filter((l) => /^\d+[.)]/.test(l))
    .map((l) => l.replace(/^\d+[.)]\s*/, ""));
  return { answer: rawText, steps };
}
