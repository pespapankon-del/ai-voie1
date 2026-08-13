/**
 * api/autofill.js — Vercel Serverless Function
 * รับภาพหน้าใบงาน → Claude Vision วิเคราะห์ตาราง → ส่งกลับรายการช่องว่าง + คำตอบ + พิกัด
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(501).json({ isDemo: true, cells: [] });
  }

  const { imageBase64, subject = "ชีววิทยา", pageWidth = 800, pageHeight = 1100 } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "imageBase64 required" });
  }

  const base64Data = imageBase64.replace(/^data:image\/[\w+]+;base64,/, "");
  const mimeMatch = imageBase64.match(/^data:(image\/[\w+]+);base64,/);
  const mediaType = mimeMatch?.[1] || "image/png";

  const prompt =
    `ดูภาพใบงานวิชา${subject}นี้ มีตารางที่มีคอลัมน์ "บทบาท/หน้าที่" (คอลัมน์ขวาสุด) ซึ่งมีช่องว่างให้เติม\n\n` +
    `สำหรับแต่ละช่องว่างในคอลัมน์นั้น ให้ระบุ:\n` +
    `1. ชื่อฮอร์โมน/สาร/ต่อมที่แถวนั้นถามถึง\n` +
    `2. คำตอบสั้นๆ ภาษาไทย (1-2 ประโยค) อธิบายบทบาทหน้าที่\n` +
    `3. ตำแหน่งโดยประมาณของช่องว่างในภาพ (หน่วย: พิกเซล ขนาดภาพ ${pageWidth}×${pageHeight}px)\n` +
    `   x=ขอบซ้าย, y=ขอบบน, width=ความกว้างช่อง, height=ความสูงช่อง\n\n` +
    `ตอบเป็น JSON เท่านั้น ไม่มี markdown:\n` +
    `{"cells":[{"hormone":"ชื่อ","answer":"คำตอบ","x":400,"y":100,"width":300,"height":45},...]}`;

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    if (!aiRes.ok) {
      const errData = await aiRes.json().catch(() => ({}));
      return res.status(502).json({ error: errData.error?.message || `AI request failed (${aiRes.status})` });
    }

    const aiData = await aiRes.json();
    const raw = (aiData.content?.[0]?.text || "").trim().replace(/^```(?:json)?\n?|\n?```$/gm, "").trim();

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return res.status(502).json({ error: "AI ตอบกลับไม่ใช่ JSON ที่ถูกต้อง", raw: raw.slice(0, 300) }); }

    return res.json({ cells: Array.isArray(parsed.cells) ? parsed.cells : [], isDemo: false });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
