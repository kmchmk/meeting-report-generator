import { Backend, Engine, type GpuArtisanConfig } from '@litert-lm/core'
import type { ProgressEvent } from '../progress'
import { teeStreamWithBackpressure } from './streams'

const MODEL_URL = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm'
const MAX_SOURCE_CHARS = 4_500
const MAX_FINAL_SOURCE_CHARS = 5_000
const MAX_REDUCTION_PASSES = 6
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

export type MeetingReport = {
  title: string
  date: string
  overview: string
  topics: { title: string; detail: string }[]
  decisions: string[]
  actions: { task: string; owner: string; due: string }[]
  risks: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function validateMeetingReport(value: unknown): value is MeetingReport {
  if (!isRecord(value)) return false
  if (!['title', 'date', 'overview'].every((key) => typeof value[key] === 'string')) return false
  if (!isStringArray(value.decisions) || !isStringArray(value.risks)) return false
  if (!Array.isArray(value.topics) || !value.topics.every((item) => isRecord(item) && typeof item.title === 'string' && typeof item.detail === 'string')) return false
  if (!Array.isArray(value.actions) || !value.actions.every((item) => isRecord(item) && typeof item.task === 'string' && typeof item.owner === 'string' && typeof item.due === 'string')) return false
  return true
}

export function extractJsonCandidate(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) return fenced.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('โมเดลไม่ส่งคืนข้อมูล JSON')
  return text.slice(start, end + 1)
}

export function parseMeetingReport(text: string): MeetingReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonCandidate(text))
  } catch (error) {
    throw new Error(`รูปแบบ JSON ไม่ถูกต้อง: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!validateMeetingReport(parsed)) throw new Error('รายงานจากโมเดลไม่ตรงกับโครงสร้างที่กำหนด')
  return parsed
}

export function chunkText(text: string, maxChars = MAX_SOURCE_CHARS) {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(offset + maxChars, text.length)
    if (end < text.length) {
      const preferredBreak = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf(' ', end))
      if (preferredBreak > offset + maxChars * 0.6) end = preferredBreak
    }
    chunks.push(text.slice(offset, end).trim())
    offset = end
    while (/\s/.test(text[offset] ?? '')) offset += 1
  }
  return chunks.filter(Boolean)
}

type Summarizer = (part: string, index: number, total: number, pass: number) => Promise<string>

export async function reduceTranscriptSequentially(source: string, summarize: Summarizer) {
  let current = source.trim()
  for (let pass = 1; current.length > MAX_FINAL_SOURCE_CHARS; pass += 1) {
    if (pass > MAX_REDUCTION_PASSES) throw new Error('บทถอดเสียงยาวเกินกว่าจะย่อให้อยู่ในบริบทของโมเดลได้อย่างปลอดภัย')
    const parts = chunkText(current)
    const summaries: string[] = []
    for (let index = 0; index < parts.length; index += 1) {
      summaries.push((await summarize(parts[index], index, parts.length, pass)).trim())
    }
    const next = summaries.map((summary, index) => `ส่วนที่ ${index + 1}:\n${summary}`).join('\n\n')
    if (next.length >= current.length) throw new Error('โมเดลไม่สามารถย่อบทถอดเสียงให้สั้นลงได้ กรุณาแบ่งไฟล์เสียง')
    current = next
  }
  return current
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
    preface: { messages: [{ role: 'system', content: 'คุณเป็นเลขานุการการประชุมมืออาชีพ วิเคราะห์เฉพาะข้อมูลที่ได้รับ ห้ามแต่งข้อมูลเพิ่ม' }] },
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

const REPORT_SCHEMA = `{"title":"ชื่อการประชุม","date":"วันที่หรือ ไม่ระบุ","overview":"สรุปผู้บริหาร 2-4 ประโยค","topics":[{"title":"หัวข้อ","detail":"สาระสำคัญ"}],"decisions":["มติ"],"actions":[{"task":"งาน","owner":"ผู้รับผิดชอบหรือ ไม่ระบุ","due":"กำหนดส่งหรือ ไม่ระบุ"}],"risks":["ประเด็นติดตามหรือความเสี่ยง"]}`

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
      `ย่อข้อมูลการประชุมรอบที่ ${pass} ส่วนที่ ${index + 1} จาก ${total} ให้กระชับไม่เกิน 350 คำ เก็บชื่อบุคคล ตัวเลข มติ งาน ผู้รับผิดชอบ กำหนดเวลา และความเสี่ยงทั้งหมด ห้ามเพิ่มข้อมูล:\n${part}`,
      512,
      (length) => updateReport(Math.min(45, reportProgress + Math.max(0.1, length / 5_000)), detail),
      onProgress,
    )
    updateReport(Math.min(50, reportProgress + 5), `ย่อส่วน ${index + 1} จาก ${total} เรียบร้อย`)
    return summary
  })

  const prompt = `สร้างรายงานการประชุมภาษาไทยอย่างละเอียดจากข้อมูลด้านล่าง ส่งคืน JSON ที่ถูกต้องตาม schema นี้เท่านั้น ห้ามใช้ markdown:\n${REPORT_SCHEMA}\nหากไม่มีข้อมูลในหมวดใดให้ใช้ array ว่าง รักษาชื่อบุคคล ตัวเลข และกำหนดเวลาให้ตรงต้นฉบับ\n\nข้อมูลการประชุม:\n${source}`
  updateReport(Math.max(50, reportProgress), 'กำลังเรียบเรียงรายงานฉบับสมบูรณ์…')
  const raw = await sendPrompt(prompt, 2_048, (length) => {
    updateReport(50 + Math.min(45, length / 30), 'กำลังเรียบเรียงรายงานฉบับสมบูรณ์…')
  }, onProgress)
  try {
    const report = parseMeetingReport(raw)
    onProgress({ step: 'report', progress: 100, status: 'done', detail: 'สร้างรายงานเรียบร้อย' })
    return report
  } catch (initialError) {
    updateReport(95, 'กำลังตรวจและซ่อมรูปแบบรายงาน…')
    const repaired = await sendPrompt(
      `แก้ข้อมูลด้านล่างให้เป็น JSON ที่ถูกต้องและตรงตาม schema เท่านั้น ห้ามใช้ markdown ห้ามเพิ่มข้อเท็จจริง หากค่าขาดหายให้ใช้ "ไม่ระบุ" หรือ array ว่างตามชนิดข้อมูล\nSchema: ${REPORT_SCHEMA}\nข้อมูลที่ต้องแก้:\n${raw}`,
      2_048,
      () => updateReport(97, 'กำลังตรวจและซ่อมรูปแบบรายงาน…'),
      onProgress,
    )
    try {
      const report = parseMeetingReport(repaired)
      onProgress({ step: 'report', progress: 100, status: 'done', detail: 'สร้างรายงานเรียบร้อย' })
      return report
    } catch (repairError) {
      throw new Error(`สร้างบทถอดเสียงสำเร็จ แต่รายงานยังมีรูปแบบไม่ถูกต้อง (${initialError instanceof Error ? initialError.message : String(initialError)}; ${repairError instanceof Error ? repairError.message : String(repairError)})`)
    }
  }
}
