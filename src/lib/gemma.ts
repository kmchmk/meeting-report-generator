import { Backend, Engine, type GpuArtisanConfig } from '@litert-lm/core'
import type { ProgressEvent } from '../progress'
import {
  SECRETARY_SYSTEM_PROMPT,
  buildFinalReportPrompt,
  buildRepairPrompt,
  buildSummarizePrompt,
  parseMeetingReport,
  reduceTranscriptSequentially,
  type MeetingReport,
} from './report-core'
import { teeStreamWithBackpressure } from './streams'

export type { MeetingReport }

const MODEL_URL = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm'
let engine: Engine | null = null
let enginePromise: Promise<Engine> | null = null
const MODEL_CACHE = 'saruplocal-models-v1'
const GPU_CONFIG: GpuArtisanConfig = {
  num_output_candidates: 1,
  wait_for_weight_uploads: true,
  num_decode_steps_per_sync: 1,
  sequence_batch_size: 0,
  supported_lora_ranks: [],
  max_top_k: 40,
  enable_decode_logits: false,
  enable_external_embeddings: false,
  use_submodel: true,
  use_autosized_ringbuffers: true,
}

export function createProgressStream(
  source: ReadableStream<Uint8Array>,
  totalBytes: number,
  onProgress: (loadedBytes: number, totalBytes: number) => void,
  onComplete?: () => void,
) {
  let loadedBytes = 0
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loadedBytes += chunk.byteLength
      onProgress(loadedBytes, totalBytes)
      controller.enqueue(chunk)
    },
    flush() {
      onComplete?.()
    },
  }))
}

export function formatEngineElapsed(elapsedMilliseconds: number) {
  const seconds = Math.max(0, Math.floor(elapsedMilliseconds / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return minutes > 0 ? `${minutes}:${String(remainingSeconds).padStart(2, '0')}` : `${seconds} วินาที`
}

async function ensureEngine(onProgress: (event: ProgressEvent) => void) {
  if (engine) {
    onProgress({ step: 'gemma-download', progress: 100, status: 'done', detail: 'ใช้โมเดล Gemma ที่เตรียมไว้แล้ว' })
    onProgress({ step: 'gemma-compile', progress: 100, status: 'done', detail: 'Gemma พร้อมใช้งานบน WebGPU' })
    return engine
  }
  if (!enginePromise) {
    enginePromise = (async () => {
      onProgress({ step: 'gemma-download', progress: 0, status: 'active', detail: 'กำลังตรวจสอบแคชของโมเดล…' })
      const cache = 'caches' in globalThis ? await caches.open(MODEL_CACHE) : null
      let response = await cache?.match(MODEL_URL)
      const fromCache = Boolean(response)
      if (!response) {
        response = await fetch(MODEL_URL)
        if (!response.ok) throw new Error(`ดาวน์โหลด Gemma ไม่สำเร็จ (${response.status})`)
      }
      if (!response.body) throw new Error('เบราว์เซอร์ไม่สามารถอ่านข้อมูลโมเดล Gemma แบบสตรีมได้')

      const totalBytes = Number(response.headers.get('content-length')) || 0
      let lastReportedPercent = -1
      let compileStartedAt: number | null = null
      const tracked = createProgressStream(response.body, totalBytes, (loadedBytes, total) => {
        const percent = total > 0 ? Math.min(100, loadedBytes / total * 100) : null
        if (percent !== null && percent < 100 && percent - lastReportedPercent < 0.1) return
        lastReportedPercent = percent ?? lastReportedPercent
        onProgress({
          step: 'gemma-download',
          progress: percent,
          status: 'active',
          detail: fromCache ? 'กำลังอ่าน Gemma จากแคชในเครื่อง…' : 'กำลังดาวน์โหลด Gemma ลงในเครื่อง…',
          loadedBytes,
          totalBytes: total || undefined,
        })
      }, () => {
        onProgress({
          step: 'gemma-download', progress: 100, status: 'done',
          detail: fromCache ? 'โหลด Gemma จากแคชเรียบร้อย' : 'ดาวน์โหลด Gemma เรียบร้อย',
          loadedBytes: totalBytes || undefined, totalBytes: totalBytes || undefined,
        })
        compileStartedAt = Date.now()
        onProgress({ step: 'gemma-compile', progress: null, status: 'active', detail: 'กำลังเตรียมโมเดลและ WebGPU shaders…' })
      })

      let modelStream = tracked
      if (cache && !fromCache) {
        const [engineStream, cacheStream] = teeStreamWithBackpressure(tracked)
        modelStream = engineStream
        void cache.put(MODEL_URL, new Response(cacheStream, { headers: response.headers })).catch(() => {
          onProgress({
            step: 'gemma-download', progress: 100, status: 'done',
            detail: 'ใช้ Gemma ได้ แต่พื้นที่แคชไม่เพียงพอ—ครั้งหน้าอาจต้องดาวน์โหลดใหม่',
            loadedBytes: totalBytes || undefined, totalBytes: totalBytes || undefined,
          })
        })
      }

      const compileTimer = globalThis.setInterval(() => {
        if (compileStartedAt === null) return
        const elapsed = Date.now() - compileStartedAt
        const detail = elapsed >= 120_000
          ? `ใช้เวลานานกว่าปกติ (${formatEngineElapsed(elapsed)}) · ตรวจว่าเปิด Hardware acceleration แล้ว`
          : `กำลังอัปโหลดน้ำหนักและคอมไพล์ WebGPU… ${formatEngineElapsed(elapsed)}`
        onProgress({ step: 'gemma-compile', progress: null, status: 'active', detail })
      }, 1_000)
      let created: Engine
      try {
        created = await Engine.create({
          model: modelStream,
          backend: Backend.GPU_ARTISAN,
          mainExecutorSettings: { maxNumTokens: 8192, backendConfig: GPU_CONFIG },
          benchmarkEnabled: true,
        })
      } finally {
        globalThis.clearInterval(compileTimer)
      }
      onProgress({ step: 'gemma-compile', progress: 100, status: 'done', detail: 'Gemma พร้อมใช้งานบน WebGPU' })
      engine = created
      return created
    })().catch((error) => {
      enginePromise = null
      throw error
    })
  }
  return enginePromise
}

async function sendPrompt(prompt: string, maxOutputTokens: number, onToken: (outputLength: number) => void, onProgress: (event: ProgressEvent) => void) {
  const activeEngine = await ensureEngine(onProgress)
  const conversation = await activeEngine.createConversation({
    sessionConfig: { maxOutputTokens, samplerParams: { temperature: 0.1, seed: 42 } },
    preface: { messages: [{ role: 'system', content: SECRETARY_SYSTEM_PROMPT }] },
  })
  try {
    let output = ''
    const reader = conversation.sendMessageStreaming(prompt).getReader()
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      for (const item of chunk.content ?? []) {
        const text = typeof item === 'string' ? item : item.type === 'text' ? item.text : ''
        if (text) { output += text; onToken(output.length) }
      }
    }
    return output
  } finally {
    await conversation.delete()
  }
}

export async function generateReport(transcript: string, onProgress: (event: ProgressEvent) => void) {
  await ensureEngine(onProgress)
  let reportProgress = 0
  const updateReport = (progress: number, detail: string) => {
    reportProgress = Math.max(reportProgress, Math.min(99, progress))
    onProgress({ step: 'report', progress: reportProgress, status: 'active', detail })
  }
  updateReport(0, 'กำลังเตรียมบทถอดเสียงสำหรับสรุป…')
  const source = await reduceTranscriptSequentially(transcript, async (part, index, total, pass) => {
    const detail = `กำลังย่อบทถอดเสียง รอบ ${pass} ส่วน ${index + 1} จาก ${total}`
    const summary = await sendPrompt(
      buildSummarizePrompt(part, index, total, pass),
      512,
      (length) => updateReport(Math.min(45, reportProgress + Math.max(0.1, length / 5_000)), detail),
      onProgress,
    )
    updateReport(Math.min(50, reportProgress + 5), `ย่อส่วน ${index + 1} จาก ${total} เรียบร้อย`)
    return summary
  })

  updateReport(Math.max(50, reportProgress), 'กำลังเรียบเรียงรายงานฉบับสมบูรณ์…')
  const raw = await sendPrompt(buildFinalReportPrompt(source), 2_048, (length) => {
    updateReport(50 + Math.min(45, length / 30), 'กำลังเรียบเรียงรายงานฉบับสมบูรณ์…')
  }, onProgress)
  try {
    const report = parseMeetingReport(raw)
    onProgress({ step: 'report', progress: 100, status: 'done', detail: 'สร้างรายงานเรียบร้อย' })
    return report
  } catch (initialError) {
    updateReport(95, 'กำลังตรวจและซ่อมรูปแบบรายงาน…')
    const repaired = await sendPrompt(buildRepairPrompt(raw), 2_048, () => updateReport(97, 'กำลังตรวจและซ่อมรูปแบบรายงาน…'), onProgress)
    try {
      const report = parseMeetingReport(repaired)
      onProgress({ step: 'report', progress: 100, status: 'done', detail: 'สร้างรายงานเรียบร้อย' })
      return report
    } catch (repairError) {
      throw new Error(`สร้างบทถอดเสียงสำเร็จ แต่รายงานยังมีรูปแบบไม่ถูกต้อง (${initialError instanceof Error ? initialError.message : String(initialError)}; ${repairError instanceof Error ? repairError.message : String(repairError)})`)
    }
  }
}
