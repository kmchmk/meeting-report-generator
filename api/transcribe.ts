export const maxDuration = 60

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GROQ_ASR_MODEL = 'whisper-large-v3'
const MAX_UPLOAD_BYTES = 4_400_000

function jsonResponse(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ error: 'ต้องใช้เมธอด POST เท่านั้น' }, 405)

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return jsonResponse({ error: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GROQ_API_KEY' }, 500)

  const contentLength = Number(request.headers.get('content-length')) || 0
  if (contentLength > MAX_UPLOAD_BYTES) return jsonResponse({ error: 'ไฟล์เสียงช่วงนี้ใหญ่เกินที่เซิร์ฟเวอร์รับได้' }, 413)

  const audio = await request.arrayBuffer()
  if (audio.byteLength === 0) return jsonResponse({ error: 'ไม่พบข้อมูลเสียงในคำขอ' }, 400)
  if (audio.byteLength > MAX_UPLOAD_BYTES) return jsonResponse({ error: 'ไฟล์เสียงช่วงนี้ใหญ่เกินที่เซิร์ฟเวอร์รับได้' }, 413)

  const form = new FormData()
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'chunk.wav')
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
    return jsonResponse({ error: 'เชื่อมต่อบริการถอดเสียง (Groq) ไม่สำเร็จ กรุณาลองอีกครั้ง' }, 502)
  }

  if (!groqResponse.ok) {
    let detail = ''
    try {
      const data = await groqResponse.json() as { error?: { message?: unknown } }
      detail = typeof data.error?.message === 'string' ? data.error.message : ''
    } catch { /* keep empty detail */ }
    const rateLimited = groqResponse.status === 429
    return jsonResponse({
      error: rateLimited
        ? 'บริการถอดเสียงฟรีถึงขีดจำกัดชั่วคราว กรุณารอสักครู่แล้วลองอีกครั้ง'
        : `บริการถอดเสียงผิดพลาด (${groqResponse.status})${detail ? `: ${detail}` : ''}`,
    }, groqResponse.status === 429 ? 429 : 502)
  }

  let payload: { text?: unknown }
  try {
    payload = await groqResponse.json() as { text?: unknown }
  } catch {
    return jsonResponse({ error: 'คำตอบจากบริการถอดเสียงไม่ถูกต้อง' }, 502)
  }
  return jsonResponse({ text: typeof payload.text === 'string' ? payload.text : '' }, 200)
}
