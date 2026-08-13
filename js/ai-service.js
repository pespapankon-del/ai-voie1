/**
 * ai-service.js
 * -----------------------------------------------------------------------
 * เรียกใช้ AI ผ่าน serverless endpoint /api/generate เท่านั้น
 * ห้ามยิง AI provider ตรงจาก browser เด็ดขาด (จะทำให้ API key รั่วใน devtools)
 *
 * Request:  { question, subject, language, detailLevel }
 * Response: { answer, steps: string[] }
 *
 * ถ้า endpoint ไม่พร้อม (ยังไม่ตั้งค่า API key บนเซิร์ฟเวอร์ หรือ dev รันแบบ static ล้วนๆ
 * โดยไม่มี serverless function) จะ fallback เป็น "demo mode" อัตโนมัติ เพื่อให้ทดสอบ UI
 * ทั้งหมดได้โดยไม่ต้องมี backend จริง
 * -----------------------------------------------------------------------
 */

export async function generateSolution({ question, subject, language = "th", detailLevel = "step-by-step" }) {
  if (!question || !question.trim()) {
    throw new Error("กรุณาระบุโจทย์ก่อนให้ AI ช่วยตอบ");
  }

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, subject, language, detailLevel }),
    });

    // 404 = ไม่มี endpoint นี้เลย (เช่นรันเป็น static site ล้วนๆ), 501 = endpoint บอกว่ายังไม่ตั้งค่า key
    if (res.status === 404 || res.status === 501) {
      return demoModeAnswer(question, subject);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `เซิร์ฟเวอร์ตอบกลับผิดพลาด (${res.status})`);
    }

    const data = await res.json();
    if (!data.answer) throw new Error("รูปแบบข้อมูลที่ได้จากเซิร์ฟเวอร์ไม่ถูกต้อง (ไม่มี answer)");
    return {
      answer: data.answer,
      steps: Array.isArray(data.steps) ? data.steps : [],
      isDemo: false,
    };
  } catch (err) {
    if (err instanceof TypeError) {
      // fetch ล้มเหลวระดับเน็ตเวิร์ก (เช่นไม่มี /api ตอน dev แบบ static)
      return demoModeAnswer(question, subject);
    }
    throw err;
  }
}

function demoModeAnswer(question, subject) {
  const steps = [
    `อ่านโจทย์ให้เข้าใจก่อนว่าโจทย์วิชา${subject || "ทั่วไป"}ข้อนี้ถามอะไร`,
    "แตกโจทย์เป็นประเด็นย่อยๆ ที่ต้องตอบให้ครบ",
    "เรียบเรียงคำตอบทีละประเด็น พร้อมยกตัวอย่างประกอบ",
    "ทบทวนคำตอบอีกครั้งก่อนคัดลง",
  ];
  const answer =
    `[โหมดทดลอง — ยังไม่ได้เชื่อมต่อ AI จริง]\n\n` +
    `นี่คือคำตอบตัวอย่างสำหรับโจทย์: "${question.slice(0, 80)}${question.length > 80 ? "..." : ""}"\n\n` +
    steps.map((s, i) => `${i + 1}. ${s}`).join("\n") +
    `\n\nกรุณาแก้ไขข้อความนี้เป็นคำตอบจริง หรือเชื่อมต่อ /api/generate กับ AI provider ` +
    `พร้อมตั้งค่า ANTHROPIC_API_KEY (หรือ provider อื่น) บนเซิร์ฟเวอร์ เพื่อให้ได้คำตอบจริง`;

  return { answer, steps, isDemo: true };
}
