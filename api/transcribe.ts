import type { IncomingMessage, ServerResponse } from 'node:http'
import { transcribeWithFallback, type ProviderName } from './_lib/transcription-providers.js'

export const maxDuration = 60
const MAX_UPLOAD_BYTES = 4_400_000
const PROVIDERS = new Set(['auto', 'groq', 'deepgram', 'assemblyai', 'cloudflare', 'azure', 'google'])
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
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received <= MAX_UPLOAD_BYTES) chunks.push(chunk)
    })
    req.on('end', () => received > MAX_UPLOAD_BYTES ? reject(new RequestTooLargeError()) : resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'ต้องใช้เมธอด POST เท่านั้น' }); return }
  if (process.env.ENABLE_CLOUD_MODE !== 'true') { sendJson(res, 404, { error: 'ไม่ได้เปิดใช้งานโหมดคลาวด์' }); return }
  const headers = req.headers ?? {}
  const rawProvider = Array.isArray(headers['x-transcription-provider']) ? headers['x-transcription-provider'][0] : headers['x-transcription-provider'] ?? 'auto'
  if (!PROVIDERS.has(rawProvider)) { sendJson(res, 400, { error: 'ไม่รู้จักผู้ให้บริการถอดเสียงที่เลือก' }); return }
  let audio: Buffer
  try { audio = await readBody(req) }
  catch (error) {
    sendJson(res, error instanceof RequestTooLargeError ? 413 : 400, { error: error instanceof RequestTooLargeError ? 'ไฟล์เสียงช่วงนี้ใหญ่เกินที่เซิร์ฟเวอร์รับได้' : 'ไม่สามารถอ่านข้อมูลเสียงในคำขอได้' })
    return
  }
  if (!audio.length) { sendJson(res, 400, { error: 'ไม่พบข้อมูลเสียงในคำขอ' }); return }
  const encodedGlossary = Array.isArray(headers['x-meeting-glossary']) ? headers['x-meeting-glossary'][0] : headers['x-meeting-glossary']
  let glossary = ''
  try { glossary = encodedGlossary ? decodeURIComponent(encodedGlossary).slice(0, 1_000) : '' } catch { glossary = '' }
  try {
    const result = await transcribeWithFallback(audio, rawProvider as ProviderName | 'auto', { glossary, speakerLabels: headers['x-speaker-labels'] === 'true' })
    sendJson(res, 200, result)
  } catch (error) {
    const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 502
    const retryAfter = typeof error === 'object' && error && 'retryAfter' in error && typeof error.retryAfter === 'string' ? error.retryAfter : null
    sendJson(res, status === 429 ? 429 : 502, { error: error instanceof Error ? error.message : String(error) }, retryAfter ? { 'retry-after': retryAfter } : {})
  }
}
