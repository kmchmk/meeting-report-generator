import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  SECRETARY_SYSTEM_PROMPT,
  buildFinalReportPrompt,
  buildRepairPrompt,
  buildSummarizePrompt,
  parseMeetingReport,
  reduceTranscriptSequentially,
  type MeetingReport,
} from './_lib/report-core.js'

export const maxDuration = 300

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_LLM_MODEL = 'openai/gpt-oss-120b'
const MAX_TRANSCRIPT_CHARS = 400_000
const MAX_BODY_BYTES = 1_500_000

class RequestTooLargeError extends Error {}

function chatBody(content: string, maxTokens: number, jsonMode: boolean) {
  return JSON.stringify({
    model: GROQ_LLM_MODEL,
    temperature: 0.1,
    seed: 42,
    reasoning_effort: 'low',
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: SECRETARY_SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  })
}

async function complete(apiKey: string, prompt: string, maxTokens: number, jsonMode: boolean): Promise<string> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 20_000))
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
      const tpmExceeded = response.status === 413 && /tokens per minute/i.test(detail)
      if (response.status === 429 || tpmExceeded) {
        lastError = new Error(`บริการโมเดลฟรีถึงขีดจำกัดชั่วคราว${detail ? `: ${detail}` : ''}`)
        continue
      }
      if (response.status === 401) throw new Error('Groq ไม่ยอมรับ API key กรุณาตรวจสอบ GROQ_API_KEY ใน Vercel')
      if (response.status === 403) throw new Error('Groq ปฏิเสธการเชื่อมต่อ กรุณาตรวจสอบสิทธิ์บัญชีและการตั้งค่าเครือข่าย')
      throw new Error(`บริการโมเดลภาษาผิดพลาด (${response.status})${detail ? `: ${detail}` : ''}`)
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    const output = data.choices?.[0]?.message?.content
    if (typeof output !== 'string') { lastError = new Error('คำตอบจากบริการโมเดลภาษาไม่ถูกต้อง'); continue }
    if (!output.trim()) { lastError = new Error('โมเดลไม่ส่งคืนข้อความ'); continue }
    return output
  }
  throw lastError ?? new Error('บริการโมเดลภาษาไม่ตอบสนอง')
}

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        reject(new RequestTooLargeError('request body too large'))
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'ต้องใช้เมธอด POST เท่านั้น' })
    return
  }
  if (process.env.ENABLE_CLOUD_MODE !== 'true') {
    sendJson(res, 404, { error: 'ไม่ได้เปิดใช้งานโหมดคลาวด์' })
    return
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    sendJson(res, 500, { error: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GROQ_API_KEY' })
    return
  }

  let transcript = ''
  try {
    const rawBody = JSON.parse(await readJsonBody(req)) as { transcript?: unknown }
    if (typeof rawBody.transcript === 'string') transcript = rawBody.transcript
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      sendJson(res, 413, { error: 'คำขอมีขนาดใหญ่เกินที่โหมดคลาวด์รองรับ' })
      return
    }
    sendJson(res, 400, { error: 'รูปแบบคำขอไม่ถูกต้อง' })
    return
  }
  transcript = transcript.trim()
  if (!transcript) {
    sendJson(res, 400, { error: 'ไม่พบบทถอดเสียงในคำขอ' })
    return
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    sendJson(res, 413, { error: 'บทถอดเสียงยาวเกินที่โหมดคลาวด์รองรับ กรุณาแบ่งไฟล์เสียง' })
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
      const summary = await complete(apiKey, buildSummarizePrompt(part, index, total, pass), 800, false)
      reportProgress = Math.min(50, reportProgress + 5)
      progress(reportProgress, `ย่อส่วน ${index + 1} จาก ${total} เรียบร้อย`)
      return summary
    })

    progress(Math.max(50, reportProgress), 'กำลังเรียบเรียงรายงานฉบับสมบูรณ์…')
    const raw = await complete(apiKey, buildFinalReportPrompt(source), 2_500, true)
    let report: MeetingReport
    try {
      report = parseMeetingReport(raw)
    } catch (initialError) {
      progress(95, 'กำลังตรวจและซ่อมรูปแบบรายงาน…')
      const repaired = await complete(apiKey, buildRepairPrompt(raw), 2_500, true)
      try {
        report = parseMeetingReport(repaired)
      } catch (repairError) {
        throw new Error(`สร้างบทถอดเสียงสำเร็จ แต่รายงานยังมีรูปแบบไม่ถูกต้อง (${initialError instanceof Error ? initialError.message : String(initialError)}; ${repairError instanceof Error ? repairError.message : String(repairError)}) | ตัวอย่างคำตอบจากโมเดล: ${raw.slice(0, 240)}`)
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
