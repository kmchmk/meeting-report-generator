import type { ProgressEvent } from '../progress'
import type { TranscriptResult } from '../types'
import { validateMeetingReport, type MeetingReport } from '../../api/_lib/report-core'

export const SAMPLE_RATE = 16_000
export const CHUNK_SECONDS = 100

export function floatToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    output[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return output
}

export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const pcm = floatToInt16(samples)
  const dataSize = pcm.byteLength
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataSize, true)
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer))
  return new Uint8Array(buffer)
}

export function chunkSamples(samples: Float32Array, seconds = CHUNK_SECONDS): Float32Array[] {
  const maxSamples = seconds * SAMPLE_RATE
  if (samples.length <= maxSamples) return [samples]
  const chunks: Float32Array[] = []
  for (let offset = 0; offset < samples.length; offset += maxSamples) {
    chunks.push(samples.subarray(offset, Math.min(offset + maxSamples, samples.length)))
  }
  return chunks
}

export function createNdjsonParser(onLine: (value: unknown) => void) {
  const decoder = new TextDecoder()
  let pending = ''
  return {
    push(chunk: Uint8Array) {
      pending += decoder.decode(chunk, { stream: true })
      let newlineIndex = pending.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex).trim()
        pending = pending.slice(newlineIndex + 1)
        if (line) onLine(JSON.parse(line))
        newlineIndex = pending.indexOf('\n')
      }
    },
    flush() {
      const line = (pending + decoder.decode()).trim()
      if (line) onLine(JSON.parse(line))
    },
  }
}

async function readErrorMessage(response: Response) {
  try {
    const data = await response.json() as { error?: unknown }
    if (typeof data.error === 'string' && data.error) return data.error
  } catch { /* ignore body parse issues */ }
  return null
}

function requestFailure(error: unknown): Error {
  if (error instanceof TypeError) {
    return new Error('ไม่พบ API ของเซิร์ฟเวอร์ โหมดคลาวด์ต้องรันผ่าน `vercel dev` หรือ deploy บน Vercel')
  }
  return error instanceof Error ? error : new Error(String(error))
}

export async function transcribeRemote(
  samples: Float32Array,
  onProgress: (event: ProgressEvent) => void,
): Promise<TranscriptResult> {
  onProgress({ step: 'whisper-model', progress: 100, status: 'done', detail: 'ถอดเสียงผ่าน Whisper Large V3 บนคลาวด์' })
  const chunks = chunkSamples(samples)
  const texts: string[] = []
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const base = index / chunks.length * 100
      onProgress({
        step: 'transcription',
        progress: Math.round(base),
        status: 'active',
        detail: chunks.length > 1 ? `กำลังส่งช่วงเสียง ${index + 1} จาก ${chunks.length} ไปถอดเสียง…` : 'กำลังส่งเสียงไปถอดข้อความ…',
      })
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: encodeWav(chunks[index]),
      })
      if (!response.ok) throw new Error(await readErrorMessage(response) ?? `ถอดเสียงผ่านคลาวด์ไม่สำเร็จ (${response.status})`)
      const data = await response.json() as { text?: unknown }
      if (typeof data.text !== 'string') throw new Error('คำตอบการถอดเสียงจากเซิร์ฟเวอร์ไม่ถูกต้อง')
      texts.push(data.text.trim())
      onProgress({
        step: 'transcription',
        progress: Math.min(99, Math.round((index + 1) / chunks.length * 100)),
        status: 'active',
        detail: chunks.length > 1 ? `ถอดเสียงครบ ${index + 1} จาก ${chunks.length} ช่วง` : 'ถอดเสียงเรียบร้อย',
      })
    }
  } catch (error) {
    throw requestFailure(error)
  }
  onProgress({ step: 'transcription', progress: 100, status: 'done', detail: 'ถอดเสียงเรียบร้อย' })
  const text = texts.filter(Boolean).join('\n').trim()
  if (!text) throw new Error('ไม่พบเสียงพูดที่ถอดได้ในไฟล์นี้')
  return { text }
}

export type ReportStreamEvent =
  | { type: 'progress'; event: ProgressEvent }
  | { type: 'report'; report: MeetingReport }
  | { type: 'error'; message: string }

function parseStreamEvent(value: unknown): ReportStreamEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.type === 'progress' && typeof record.event === 'object' && record.event !== null) {
    return { type: 'progress', event: record.event as ProgressEvent }
  }
  if (record.type === 'report') return { type: 'report', report: record.report as MeetingReport }
  if (record.type === 'error' && typeof record.message === 'string') return { type: 'error', message: record.message }
  return null
}

export async function generateReportRemote(
  transcript: string,
  onProgress: (event: ProgressEvent) => void,
): Promise<MeetingReport> {
  onProgress({ step: 'gemma-download', progress: 100, status: 'done', detail: 'ใช้โมเดลภาษาบนคลาวด์ (Groq)' })
  onProgress({ step: 'gemma-compile', progress: 100, status: 'done', detail: 'ไม่ต้องเตรียมโมเดลบนเครื่อง' })
  let response: Response
  try {
    response = await fetch('/api/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript }),
    })
  } catch (error) {
    throw requestFailure(error)
  }
  const streamBody = response.body
  if (!response.ok || !streamBody) {
    throw new Error(await readErrorMessage(response) ?? `สร้างรายงานผ่านคลาวด์ไม่สำเร็จ (${response.status})`)
  }
  return new Promise<MeetingReport>((resolve, reject) => {
    const parser = createNdjsonParser((value) => {
      const event = parseStreamEvent(value)
      if (!event) return
      if (event.type === 'progress') {
        onProgress(event.event)
      } else if (event.type === 'report') {
        if (!validateMeetingReport(event.report)) {
          reject(new Error('รายงานจากเซิร์ฟเวอร์ไม่ตรงกับโครงสร้างที่กำหนด'))
          return
        }
        resolve(event.report)
      } else {
        reject(new Error(event.message))
      }
    })
    const reader = streamBody.getReader()
    const consume = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          parser.push(value)
        }
        parser.flush()
      } catch (error) {
        reject(requestFailure(error))
        return
      }
      reject(new Error('การเชื่อมต่อเซิร์ฟเวอร์ถูกปิดก่อนได้รับรายงาน'))
    }
    void consume()
  })
}
