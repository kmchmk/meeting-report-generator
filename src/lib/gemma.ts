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
} from '../../api/_lib/report-core'

export type { MeetingReport }

const MODEL_URL = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm'
let engine: Engine | null = null
let enginePromise: Promise<Engine> | null = null
const MODEL_CACHE = 'saruplocal-models-v1'
const MODEL_DOWNLOAD_RETRIES = 5
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

type ModelDownload = {
  body: ReadableStream<Uint8Array>
  headers: Headers
  totalBytes: number
}

export async function fetchModelWithResume(
  url: string,
  onRetry: (attempt: number, loadedBytes: number, totalBytes: number) => void,
  fetcher: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)),
): Promise<ModelDownload> {
  const initial = await fetcher(url)
  if (!initial.ok) throw new Error(`ดาวน์โหลด Gemma ไม่สำเร็จ (${initial.status})`)
  if (!initial.body) throw new Error('เบราว์เซอร์ไม่สามารถอ่านข้อมูลโมเดล Gemma แบบสตรีมได้')

  const totalBytes = Number(initial.headers.get('content-length')) || 0
  let reader = initial.body.getReader()
  let loadedBytes = 0
  let retries = 0
  let terminalError: Error | null = null

  async function reconnect() {
    while (retries < MODEL_DOWNLOAD_RETRIES) {
      retries += 1
      onRetry(retries, loadedBytes, totalBytes)
      await wait(Math.min(8_000, 1_000 * 2 ** (retries - 1)))
      try {
        const resumed = await fetcher(url, { headers: { range: `bytes=${loadedBytes}-` } })
        if (resumed.status !== 206) throw new Error(`server did not resume (${resumed.status})`)
        if (!resumed.body) throw new Error('missing response stream')
        reader = resumed.body.getReader()
        return
      } catch {
        // Keep retrying from the last byte successfully delivered to LiteRT-LM.
      }
    }
    terminalError = new Error('การดาวน์โหลด Gemma ขาดช่วงและลองเชื่อมต่อใหม่ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วกดลองสร้างรายงานอีกครั้ง')
    throw terminalError
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            return
          }
          loadedBytes += value.byteLength
          controller.enqueue(value)
          return
        } catch {
          try {
            await reconnect()
          } catch (error) {
            controller.error(error)
            return
          }
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })

  return { body, headers: initial.headers, totalBytes }
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
      let totalBytes = Number(response?.headers.get('content-length')) || 0

      const fetchDownload = () => fetchModelWithResume(MODEL_URL, (attempt, loadedBytes, expectedBytes) => {
        onProgress({
          step: 'gemma-download',
          progress: expectedBytes > 0 ? Math.min(99, loadedBytes / expectedBytes * 100) : null,
          status: 'active',
          detail: `การเชื่อมต่อสะดุด · กำลังดาวน์โหลดต่อ (ครั้งที่ ${attempt} จาก ${MODEL_DOWNLOAD_RETRIES})…`,
          loadedBytes,
          totalBytes: expectedBytes || undefined,
        })
      })

      const trackDownload = (download: ModelDownload) => {
        let lastReportedPercent = -1
        return createProgressStream(download.body, download.totalBytes, (loadedBytes, expectedBytes) => {
          const percent = expectedBytes > 0 ? Math.min(100, loadedBytes / expectedBytes * 100) : null
          if (percent !== null && percent < 100 && percent - lastReportedPercent < 0.1) return
          lastReportedPercent = percent ?? lastReportedPercent
          onProgress({
            step: 'gemma-download', progress: percent, status: 'active',
            detail: 'กำลังดาวน์โหลด Gemma ลงในเครื่อง…',
            loadedBytes, totalBytes: expectedBytes || undefined,
          })
        }, () => {
          onProgress({
            step: 'gemma-download', progress: 100, status: 'done', detail: 'ดาวน์โหลด Gemma เรียบร้อย',
            loadedBytes: download.totalBytes || undefined, totalBytes: download.totalBytes || undefined,
          })
        })
      }

      if (!response) {
        let download = await fetchDownload()
        totalBytes = download.totalBytes
        if (cache) {
          try {
            await cache.put(MODEL_URL, new Response(trackDownload(download), { headers: download.headers }))
            response = await cache.match(MODEL_URL)
            if (!response) throw new Error('cache entry missing after write')
          } catch {
            onProgress({
              step: 'gemma-download', progress: 0, status: 'active',
              detail: 'พื้นที่แคชไม่เพียงพอ · กำลังโหลดโมเดลสำหรับครั้งนี้โดยไม่บันทึก…',
            })
            download = await fetchDownload()
            totalBytes = download.totalBytes
            response = new Response(trackDownload(download), { headers: download.headers })
          }
        } else {
          response = new Response(trackDownload(download), { headers: download.headers })
        }
      } else {
        onProgress({
          step: 'gemma-download', progress: 100, status: 'done', detail: 'พบ Gemma ในแคชของเครื่อง',
          loadedBytes: totalBytes || undefined, totalBytes: totalBytes || undefined,
        })
      }
      if (!response.body) throw new Error('เบราว์เซอร์ไม่สามารถอ่านข้อมูลโมเดล Gemma แบบสตรีมได้')

      const compileStartedAt = Date.now()
      onProgress({ step: 'gemma-compile', progress: null, status: 'active', detail: 'กำลังเตรียมโมเดลและ WebGPU shaders…' })
      const compileTimer = globalThis.setInterval(() => {
        const elapsed = Date.now() - compileStartedAt
        const detail = elapsed >= 120_000
          ? `ใช้เวลานานกว่าปกติ (${formatEngineElapsed(elapsed)}) · ตรวจว่าเปิด Hardware acceleration แล้ว`
          : `กำลังอัปโหลดน้ำหนักและคอมไพล์ WebGPU… ${formatEngineElapsed(elapsed)}`
        onProgress({ step: 'gemma-compile', progress: null, status: 'active', detail })
      }, 1_000)
      let created: Engine
      try {
        created = await Engine.create({
          model: response.body,
          backend: Backend.GPU_ARTISAN,
          mainExecutorSettings: { maxNumTokens: 8192, backendConfig: GPU_CONFIG },
          benchmarkEnabled: false,
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
