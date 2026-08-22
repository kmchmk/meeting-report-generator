import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  SECRETARY_SYSTEM_PROMPT,
  buildFinalReportPrompt,
  buildRepairPrompt,
  buildSummarizePrompt,
  parseMeetingReport,
  reduceTranscriptSequentially,
  type MeetingReport,
} from './_lib/report-core'

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

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'ต้องใช้เมธอด POST เท่านั้น' }))
    return
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    res.statusCode = 500
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GROQ_API_KEY' }))
    return
  }

  let transcript = ''
  try {
    const rawBody = JSON.parse(await readJsonBody(req)) as { transcript?: unknown }
    if (typeof rawBody.transcript === 'string') transcript = rawBody.transcript
  } catch {
    res.statusCode = 400
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'รูปแบบคำขอไม่ถูกต้อง' }))
    return
  }
  transcript = transcript.trim()
  if (!transcript) {
    res.statusCode = 400
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'ไม่พบบทถอดเสียงในคำขอ' }))
    return
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    res.statusCode = 413
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'บทถอดเสียงยาวเกินที่โหมดคลาวด์รองรับ กรุณาแบ่งไฟล์เสียง' }))
    return
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  })
  const send = (event: Record<string, unknown>) => {
    if (res.writableEnded || res.destroyed) throw new Error('client-disconnected')
    res.write(`${JSON.stringify(event)}\n`)
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
    if (!(error instanceof Error && error.message === 'client-disconnected')) {
      try {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      } catch { /* client already gone */ }
    }
  } finally {
    res.end()
  }
}
