import {
  SECRETARY_SYSTEM_PROMPT,
  buildFinalReportPrompt,
  buildRepairPrompt,
  buildSummarizePrompt,
  parseMeetingReport,
  reduceTranscriptSequentially,
  type MeetingReport,
} from '../src/lib/report-core'

export const maxDuration = 300

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_LLM_MODEL = 'llama-3.3-70b-versatile'
const MAX_TRANSCRIPT_CHARS = 400_000

function chatBody(content: string, maxTokens: number, jsonMode: boolean) {
  return JSON.stringify({
    model: GROQ_LLM_MODEL,
    temperature: 0.1,
    seed: 42,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: SECRETARY_SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  })
}

async function complete(apiKey: string, prompt: string, maxTokens: number, jsonMode: boolean): Promise<string> {
  let response: Response
  try {
    response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: chatBody(prompt, maxTokens, jsonMode),
    })
  } catch {
    throw new Error('เชื่อมต่อบริการโมเดลภาษา (Groq) ไม่สำเร็จ กรุณาลองอีกครั้ง')
  }
  if (!response.ok) {
    let detail = ''
    try {
      const data = await response.json() as { error?: { message?: unknown } }
      detail = typeof data.error?.message === 'string' ? data.error.message : ''
    } catch { /* keep empty detail */ }
    if (response.status === 429) throw new Error('บริการโมเดลฟรีถึงขีดจำกัดชั่วคราว กรุณารอสักครู่แล้วลองอีกครั้ง')
    throw new Error(`บริการโมเดลภาษาผิดพลาด (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
  const output = data.choices?.[0]?.message?.content
  if (typeof output !== 'string') throw new Error('คำตอบจากบริการโมเดลภาษาไม่ถูกต้อง')
  return output
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'ต้องใช้เมธอด POST เท่านั้น' }, { status: 405 })

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return Response.json({ error: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GROQ_API_KEY' }, { status: 500 })

  let transcript = ''
  try {
    const body = await request.json() as { transcript?: unknown }
    if (typeof body.transcript === 'string') transcript = body.transcript
  } catch {
    return Response.json({ error: 'รูปแบบคำขอไม่ถูกต้อง' }, { status: 400 })
  }
  transcript = transcript.trim()
  if (!transcript) return Response.json({ error: 'ไม่พบบทถอดเสียงในคำขอ' }, { status: 400 })
  if (transcript.length > MAX_TRANSCRIPT_CHARS) return Response.json({ error: 'บทถอดเสียงยาวเกินที่โหมดคลาวด์รองรับ กรุณาแบ่งไฟล์เสียง' }, { status: 413 })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (event: Record<string, unknown>) => {
        if (closed) return
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }
      const progress = (stepProgress: number | null, detail: string) => {
        send({ type: 'progress', event: { step: 'report', progress: stepProgress, status: 'active', detail } })
      }
      try {
        progress(0, 'กำลังเตรียมบทถอดเสียงสำหรับสรุป…')
        let reportProgress = 0
        const source = await reduceTranscriptSequentially(transcript, async (part, index, total, pass) => {
          const detail = `กำลังย่อบทถอดเสียง รอบ ${pass} ส่วน ${index + 1} จาก ${total} (ผ่าน Groq)`
          progress(Math.min(45, reportProgress + 2), detail)
          const summary = await complete(apiKey, buildSummarizePrompt(part, index, total, pass), 512, false)
          reportProgress = Math.min(50, reportProgress + 5)
          progress(reportProgress, `ย่อส่วน ${index + 1} จาก ${total} เรียบร้อย`)
          return summary
        })

        progress(Math.max(50, reportProgress), 'กำลังเรียบเรียงรายงานฉบับสมบูรณ์…')
        const raw = await complete(apiKey, buildFinalReportPrompt(source), 2_048, true)
        let report: MeetingReport
        try {
          report = parseMeetingReport(raw)
        } catch (initialError) {
          progress(95, 'กำลังตรวจและซ่อมรูปแบบรายงาน…')
          const repaired = await complete(apiKey, buildRepairPrompt(raw), 2_048, true)
          try {
            report = parseMeetingReport(repaired)
          } catch (repairError) {
            throw new Error(`สร้างบทถอดเสียงสำเร็จ แต่รายงานยังมีรูปแบบไม่ถูกต้อง (${initialError instanceof Error ? initialError.message : String(initialError)}; ${repairError instanceof Error ? repairError.message : String(repairError)})`)
          }
        }
        send({ type: 'progress', event: { step: 'report', progress: 100, status: 'done', detail: 'สร้างรายงานเรียบร้อย' } })
        send({ type: 'report', report })
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        closed = true
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}
