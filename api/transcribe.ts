import type { IncomingMessage, ServerResponse } from 'node:http'

export const maxDuration = 60

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GROQ_ASR_MODEL = 'whisper-large-v3'
const MAX_UPLOAD_BYTES = 4_400_000

class RequestTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_UPLOAD_BYTES) {
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
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'ต้องใช้เมธอด POST เท่านั้น' }); return }
  if (process.env.ENABLE_CLOUD_MODE !== 'true') { sendJson(res, 404, { error: 'ไม่ได้เปิดใช้งานโหมดคลาวด์' }); return }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) { sendJson(res, 500, { error: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GROQ_API_KEY' }); return }

  let audio: Buffer
  try {
    audio = await readBody(req)
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      sendJson(res, 413, { error: 'ไฟล์เสียงช่วงนี้ใหญ่เกินที่เซิร์ฟเวอร์รับได้' })
      return
    }
    sendJson(res, 400, { error: 'ไม่สามารถอ่านข้อมูลเสียงในคำขอได้' })
    return
  }
  if (audio.byteLength === 0) { sendJson(res, 400, { error: 'ไม่พบข้อมูลเสียงในคำขอ' }); return }
  if (audio.byteLength > MAX_UPLOAD_BYTES) { sendJson(res, 413, { error: 'ไฟล์เสียงช่วงนี้ใหญ่เกินที่เซิร์ฟเวอร์รับได้' }); return }

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'chunk.wav')
  form.append('model', GROQ_ASR_MODEL)
  form.append('language', 'th')
  form.append('temperature', '0')
  form.append('response_format', 'json')

  let groqResponse: Response
  try {
    groqResponse = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    })
  } catch {
    sendJson(res, 502, { error: 'เชื่อมต่อบริการถอดเสียง (Groq) ไม่สำเร็จ กรุณาลองอีกครั้ง' })
    return
  }

  if (!groqResponse.ok) {
    let detail = ''
    try {
      const data = await groqResponse.json() as { error?: { message?: unknown } }
      detail = typeof data.error?.message === 'string' ? data.error.message : ''
    } catch { /* keep empty detail */ }
    if (groqResponse.status === 429) {
      const retryAfter = groqResponse.headers.get('retry-after')
      sendJson(res, 429, { error: 'บริการถอดเสียงฟรีถึงขีดจำกัดชั่วคราว กรุณารอสักครู่แล้วลองอีกครั้ง' }, retryAfter ? { 'retry-after': retryAfter } : {})
      return
    }
    if (groqResponse.status === 401) {
      sendJson(res, 502, { error: 'Groq ไม่ยอมรับ API key กรุณาตรวจสอบ GROQ_API_KEY ใน Vercel' })
      return
    }
    if (groqResponse.status === 403) {
      sendJson(res, 502, { error: 'Groq ปฏิเสธการเชื่อมต่อ กรุณาตรวจสอบสิทธิ์บัญชีและการตั้งค่าเครือข่าย' })
      return
    }
    sendJson(res, 502, { error: `บริการถอดเสียงผิดพลาด (${groqResponse.status})${detail ? `: ${detail}` : ''}` })
    return
  }

  try {
    const payload = await groqResponse.json() as { text?: unknown }
    sendJson(res, 200, { text: typeof payload.text === 'string' ? payload.text : '' })
  } catch {
    sendJson(res, 502, { error: 'คำตอบจากบริการถอดเสียงไม่ถูกต้อง' })
  }
}
