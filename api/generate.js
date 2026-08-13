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

  const { mode, question, subject, language = "th", detailLevel = "step-by-step", imageBase64, mediaType } = req.body || {};

  // ─── autofill mode: วิเคราะห์ภาพใบงาน หาทุกช่องโจทย์ และตอบพร้อมกัน ───
  if (mode === "autofill") {
    if (!imageBase64 || typeof imageBase64 !== "string") {
      res.status(400).json({ error: "ต้องส่ง imageBase64 สำหรับ autofill" });
      return;
    }
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 4000,
          system: buildAutofillSystemPrompt(subject),
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageBase64 } },
              { type: "text", text: "วิเคราะห์ใบงานนี้แล้วตอบเป็น JSON ตามที่กำหนด" },
            ],
          }],
        }),
      });
      if (!response.ok) { res.status(502).json({ error: "เรียก AI provider ไม่สำเร็จ" }); return; }
      const data = await response.json();
      const rawText = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { res.status(502).json({ error: "AI ไม่ตอบ JSON ที่คาดหวัง" }); return; }
      const parsed = JSON.parse(jsonMatch[0]);
      res.status(200).json({ cells: Array.isArray(parsed.cells) ? parsed.cells : [] });
    } catch (err) {
      console.error("autofill handler error:", err);
      res.status(500).json({ error: "เกิดข้อผิดพลาดขณะวิเคราะห์ใบงาน" });
    }
    return;
  }

  // ─── mode ปกติ: ตอบโจทย์ข้อเดียว ───
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
        model: "claude-sonnet-5",
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

function buildAutofillSystemPrompt(subject) {
  return [
    `คุณเป็นครูที่ช่วยวิเคราะห์ใบงาน/ข้อสอบวิชา "${subject || "ทั่วไป"}"`,
    "มองหาทุกช่องที่ว่าง ทุกโจทย์ หรือทุกตารางที่รอคำตอบในภาพ",
    "สำหรับแต่ละช่อง ให้ระบุตำแหน่งกรอบของช่องนั้นเป็นสัดส่วน (0.0-1.0) ของขนาดภาพทั้งหมด",
    "และเขียนคำตอบสั้นๆ เหมาะสำหรับคัดด้วยลายมือ ไม่เกิน 3-4 บรรทัดต่อช่อง",
    'ตอบเป็น JSON รูปแบบ: {"cells":[{"question":"...","answer":"...","xFrac":0.1,"yFrac":0.2,"wFrac":0.4,"hFrac":0.08}]}',
    "ห้ามมีข้อความอื่นนอกจาก JSON เด็ดขาด",
  ].join(" ");
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
