import type { ProgressEvent } from '../progress'
import type { CloudReportProvider, CloudTranscriptionProvider, TranscriptChunk, TranscriptResult } from '../types'
import { validateMeetingReport, type MeetingReport } from '../../api/_lib/report-core'
import { createOverlappingSlices, isSilentAudio, mergeTranscriptChunks, transcriptText } from './transcript'

export const SAMPLE_RATE = 16_000
// Kept for the generic fixed-size helper; the live cloud pipeline uses 55-second overlapping slices.
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

export function retryDelayMs(value: string | null, fallbackMs = 5_000) {
  if (!value) return fallbackMs
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(20_000, Math.ceil(seconds * 1_000))
  const timestamp = Date.parse(value)
  if (Number.isFinite(timestamp)) return Math.min(20_000, Math.max(0, timestamp - Date.now()))
  return fallbackMs
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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
  options: {
    provider?: CloudTranscriptionProvider
    glossary?: string
    diarization?: boolean
    resumeChunks?: Record<number, TranscriptChunk[]>
    onPartial?: (index: number, chunks: TranscriptChunk[]) => void
  } = {},
): Promise<TranscriptResult> {
  const requestedProvider = options.provider ?? 'auto'
  onProgress({ step: 'whisper-model', progress: 100, status: 'done', detail: 'บริการถอดเสียงออนไลน์พร้อมใช้งาน' })
  const slices = createOverlappingSlices(samples)
  const collected: TranscriptChunk[] = []
  let actualProvider = requestedProvider
  try {
    for (let index = 0; index < slices.length; index += 1) {
      const slice = slices[index]
      const base = index / slices.length * 100
      const resumed = options.resumeChunks?.[index]
      if (options.resumeChunks && index in options.resumeChunks) {
        collected.push(...(resumed ?? []))
        onProgress({ step: 'transcription', progress: Math.round((index + 1) / slices.length * 100), status: 'active', detail: `ใช้ผลที่บันทึกไว้ช่วง ${index + 1} จาก ${slices.length}` })
        continue
      }
      if (isSilentAudio(slice.samples)) {
        options.onPartial?.(index, [])
        onProgress({ step: 'transcription', progress: Math.round((index + 1) / slices.length * 100), status: 'active', detail: `ข้ามช่วงเงียบ ${index + 1} จาก ${slices.length}` })
        continue
      }
      onProgress({
        step: 'transcription',
        progress: Math.round(base),
        status: 'active',
        detail: slices.length > 1 ? `กำลังถอดเสียงช่วง ${index + 1} จาก ${slices.length}…` : 'กำลังส่งเสียงไปถอดข้อความ…',
      })
      let response: Response | null = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await fetch('/api/transcribe', {
          method: 'POST',
          headers: {
            'content-type': 'audio/wav',
            'x-transcription-provider': requestedProvider,
            'x-speaker-labels': options.diarization ? 'true' : 'false',
            ...(options.glossary ? { 'x-meeting-glossary': encodeURIComponent(options.glossary.slice(0, 1_000)) } : {}),
          },
          body: encodeWav(slice.samples),
        })
        if (response.status !== 429 || attempt === 2) break
        const waitMs = retryDelayMs(response.headers.get('retry-after'))
        onProgress({
          step: 'transcription',
          progress: Math.round(base),
          status: 'active',
          detail: `ถึงขีดจำกัดฟรีชั่วคราว · รอ ${Math.max(1, Math.ceil(waitMs / 1_000))} วินาทีแล้วลองใหม่…`,
        })
        await delay(waitMs)
      }
      if (!response) throw new Error('ไม่ได้รับคำตอบจากบริการถอดเสียง')
      if (!response.ok) throw new Error(await readErrorMessage(response) ?? `ถอดเสียงผ่านคลาวด์ไม่สำเร็จ (${response.status})`)
      const data = await response.json() as { text?: unknown; provider?: unknown; segments?: unknown }
      if (typeof data.text !== 'string') throw new Error('คำตอบการถอดเสียงจากเซิร์ฟเวอร์ไม่ถูกต้อง')
      if (typeof data.provider === 'string') actualProvider = data.provider as CloudTranscriptionProvider
      const remoteSegments = Array.isArray(data.segments) ? data.segments : []
      const parsedSegments: TranscriptChunk[] = remoteSegments.flatMap((value) => {
        if (!value || typeof value !== 'object') return []
        const item = value as Record<string, unknown>
        if (typeof item.text !== 'string') return []
        const start = typeof item.start === 'number' ? item.start : 0
        const end = typeof item.end === 'number' ? item.end : slice.endSeconds - slice.startSeconds
        return [{
          text: item.text.trim(),
          timestamp: [slice.startSeconds + start, Math.min(slice.endSeconds, slice.startSeconds + end)] as [number, number],
          ...(typeof item.speaker === 'string' ? { speaker: item.speaker } : {}),
          ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
        }]
      })
      const completed = parsedSegments.length ? parsedSegments : data.text.trim() ? [{ text: data.text.trim(), timestamp: [slice.startSeconds, slice.endSeconds] as [number, number] }] : []
      collected.push(...completed)
      options.onPartial?.(index, completed)
      onProgress({
        step: 'transcription',
        progress: Math.min(99, Math.round((index + 1) / slices.length * 100)),
        status: 'active',
        detail: slices.length > 1 ? `ถอดเสียงครบ ${index + 1} จาก ${slices.length} ช่วง` : 'ถอดเสียงเรียบร้อย',
      })
    }
  } catch (error) {
    throw requestFailure(error)
  }
  onProgress({ step: 'transcription', progress: 100, status: 'done', detail: 'ถอดเสียงเรียบร้อย' })
  const chunks = mergeTranscriptChunks(collected)
  const text = transcriptText(chunks).trim()
  if (!text) throw new Error('ไม่พบเสียงพูดที่ถอดได้ในไฟล์นี้')
  return { text, chunks, provider: actualProvider }
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
  options: { provider?: CloudReportProvider; glossary?: string } = {},
): Promise<MeetingReport> {
  onProgress({ step: 'gemma-download', progress: 100, status: 'done', detail: 'ใช้โมเดลภาษาออนไลน์ที่ตั้งค่าไว้' })
  onProgress({ step: 'gemma-compile', progress: 100, status: 'done', detail: 'ไม่ต้องเตรียมโมเดลบนเครื่อง' })
  let response: Response
  try {
    response = await fetch('/api/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript, provider: options.provider ?? 'auto', glossary: options.glossary ?? '' }),
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
