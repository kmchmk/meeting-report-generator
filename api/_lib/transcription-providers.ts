export type ProviderName = 'groq' | 'deepgram' | 'assemblyai' | 'cloudflare' | 'azure' | 'google'
export type ProviderSegment = { start: number; end: number; text: string; speaker?: string; confidence?: number }
export type ProviderResult = { text: string; segments: ProviderSegment[]; provider: ProviderName }
export type TranscriptionOptions = { glossary?: string; speakerLabels?: boolean }

function seconds(value: unknown) {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return 0
  const parsed = Number(value.replace(/s$/, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

async function errorDetail(response: Response) {
  try {
    const data = await response.json() as Record<string, unknown>
    const nested = data.error && typeof data.error === 'object' ? (data.error as Record<string, unknown>).message : undefined
    return typeof nested === 'string' ? nested : typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : ''
  } catch { return '' }
}

async function requireOk(response: Response, provider: string) {
  if (response.ok) return
  const detail = await errorDetail(response)
  const error = new Error(`${provider} ตอบกลับผิดพลาด (${response.status})${detail ? `: ${detail}` : ''}`)
  Object.assign(error, { status: response.status, retryAfter: response.headers.get('retry-after') })
  throw error
}

async function groq(audio: Buffer, options: TranscriptionOptions): Promise<ProviderResult> {
  const key = process.env.GROQ_API_KEY
  if (!key) throw new Error('ยังไม่ได้ตั้งค่า GROQ_API_KEY')
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'chunk.wav')
  form.append('model', process.env.GROQ_ASR_MODEL || 'whisper-large-v3')
  form.append('language', 'th')
  form.append('temperature', '0')
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'segment')
  if (options.glossary) form.append('prompt', options.glossary.slice(0, 900))
  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form })
  if (response.status === 401) throw Object.assign(new Error('Groq ไม่ยอมรับ API key กรุณาตรวจสอบ GROQ_API_KEY ใน Vercel'), { status: 401 })
  if (response.status === 403) throw Object.assign(new Error('Groq ปฏิเสธการเชื่อมต่อ กรุณาตรวจสอบสิทธิ์บัญชีและการตั้งค่าเครือข่าย'), { status: 403 })
  await requireOk(response, 'Groq')
  const data = await response.json() as { text?: unknown; segments?: Array<Record<string, unknown>> }
  const text = typeof data.text === 'string' ? data.text.trim() : ''
  const segments = (data.segments ?? []).flatMap((item) => typeof item.text === 'string' ? [{ start: seconds(item.start), end: seconds(item.end), text: item.text.trim() }] : [])
  return { provider: 'groq', text, segments }
}

async function deepgram(audio: Buffer, options: TranscriptionOptions): Promise<ProviderResult> {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) throw new Error('ยังไม่ได้ตั้งค่า DEEPGRAM_API_KEY')
  const query = new URLSearchParams({ model: process.env.DEEPGRAM_MODEL || 'nova-3', language: 'th', smart_format: 'true', utterances: 'true' })
  if (options.speakerLabels) query.set('diarize_model', 'latest')
  for (const term of (options.glossary ?? '').split(/[,\n]/).map((value) => value.trim()).filter(Boolean).slice(0, 100)) query.append('keyterm', term)
  const response = await fetch(`https://api.deepgram.com/v1/listen?${query}`, { method: 'POST', headers: { authorization: `Token ${key}`, 'content-type': 'audio/wav' }, body: new Uint8Array(audio) })
  await requireOk(response, 'Deepgram')
  const data = await response.json() as { results?: { utterances?: Array<Record<string, unknown>>; channels?: Array<{ alternatives?: Array<Record<string, unknown>> }> } }
  const alternative = data.results?.channels?.[0]?.alternatives?.[0]
  const text = typeof alternative?.transcript === 'string' ? alternative.transcript.trim() : ''
  const segments = (data.results?.utterances ?? []).flatMap((item) => typeof item.transcript === 'string' ? [{
    start: seconds(item.start), end: seconds(item.end), text: item.transcript.trim(),
    ...(typeof item.speaker === 'number' ? { speaker: `ผู้พูด ${item.speaker + 1}` } : {}),
    ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
  }] : [])
  return { provider: 'deepgram', text, segments }
}

async function cloudflare(audio: Buffer, options: TranscriptionOptions): Promise<ProviderResult> {
  const key = process.env.CLOUDFLARE_API_TOKEN
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!key || !account) throw new Error('ยังไม่ได้ตั้งค่า CLOUDFLARE_API_TOKEN และ CLOUDFLARE_ACCOUNT_ID')
  const model = process.env.CLOUDFLARE_ASR_MODEL || '@cf/openai/whisper-large-v3-turbo'
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ audio: audio.toString('base64'), language: 'th', task: 'transcribe', vad_filter: true, initial_prompt: options.glossary?.slice(0, 900) }),
  })
  await requireOk(response, 'Cloudflare')
  const data = await response.json() as { result?: { text?: unknown; segments?: Array<Record<string, unknown>> } }
  const text = typeof data.result?.text === 'string' ? data.result.text.trim() : ''
  const segments = (data.result?.segments ?? []).flatMap((item) => typeof item.text === 'string' ? [{ start: seconds(item.start), end: seconds(item.end), text: item.text.trim() }] : [])
  return { provider: 'cloudflare', text, segments }
}

async function azure(audio: Buffer): Promise<ProviderResult> {
  const key = process.env.AZURE_SPEECH_KEY
  const region = process.env.AZURE_SPEECH_REGION
  if (!key || !region) throw new Error('ยังไม่ได้ตั้งค่า AZURE_SPEECH_KEY และ AZURE_SPEECH_REGION')
  const response = await fetch(`https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=th-TH&format=detailed`, {
    method: 'POST', headers: { 'ocp-apim-subscription-key': key, 'content-type': 'audio/wav; codecs=audio/pcm; samplerate=16000', accept: 'application/json' }, body: new Uint8Array(audio),
  })
  await requireOk(response, 'Azure Speech')
  const data = await response.json() as { DisplayText?: unknown; NBest?: Array<Record<string, unknown>>; Duration?: number }
  const best = data.NBest?.[0]
  const text = typeof best?.Display === 'string' ? best.Display.trim() : typeof data.DisplayText === 'string' ? data.DisplayText.trim() : ''
  return { provider: 'azure', text, segments: text ? [{ start: 0, end: typeof data.Duration === 'number' ? data.Duration / 10_000_000 : 0, text }] : [] }
}

async function google(audio: Buffer): Promise<ProviderResult> {
  const key = process.env.GOOGLE_SPEECH_API_KEY
  if (!key) throw new Error('ยังไม่ได้ตั้งค่า GOOGLE_SPEECH_API_KEY')
  const response = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      config: { encoding: 'LINEAR16', sampleRateHertz: 16_000, languageCode: 'th-TH', enableAutomaticPunctuation: true, enableWordTimeOffsets: true },
      audio: { content: audio.toString('base64') },
    }),
  })
  await requireOk(response, 'Google Speech-to-Text')
  const data = await response.json() as { results?: Array<{ alternatives?: Array<{ transcript?: unknown; confidence?: unknown; words?: Array<Record<string, unknown>> }>; resultEndTime?: unknown }> }
  const segments = (data.results ?? []).flatMap((result) => {
    const alternative = result.alternatives?.[0]
    if (typeof alternative?.transcript !== 'string') return []
    const words = alternative.words ?? []
    return [{ start: seconds(words[0]?.startTime), end: words.length ? seconds(words.at(-1)?.endTime) : seconds(result.resultEndTime), text: alternative.transcript.trim(), ...(typeof alternative.confidence === 'number' ? { confidence: alternative.confidence } : {}) }]
  })
  return { provider: 'google', text: segments.map((item) => item.text).join(' ').trim(), segments }
}

async function assemblyai(audio: Buffer, options: TranscriptionOptions): Promise<ProviderResult> {
  const key = process.env.ASSEMBLYAI_API_KEY
  if (!key) throw new Error('ยังไม่ได้ตั้งค่า ASSEMBLYAI_API_KEY')
  const headers = { authorization: key }
  const upload = await fetch('https://api.assemblyai.com/v2/upload', { method: 'POST', headers, body: new Uint8Array(audio) })
  await requireOk(upload, 'AssemblyAI')
  const uploadData = await upload.json() as { upload_url?: unknown }
  if (typeof uploadData.upload_url !== 'string') throw new Error('AssemblyAI ไม่ส่งคืนที่อยู่ไฟล์ชั่วคราว')
  const submitted = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({
      audio_url: uploadData.upload_url, language_code: 'th', speech_models: ['universal-3-pro', 'universal-2'],
      speaker_labels: options.speakerLabels ?? false,
      ...(options.glossary ? { keyterms_prompt: options.glossary.split(/[,\n]/).map((value) => value.trim()).filter(Boolean).slice(0, 100) } : {}),
    }),
  })
  await requireOk(submitted, 'AssemblyAI')
  const submittedData = await submitted.json() as { id?: unknown }
  if (typeof submittedData.id !== 'string') throw new Error('AssemblyAI ไม่ส่งคืนรหัสงาน')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1_000))
    const response = await fetch(`https://api.assemblyai.com/v2/transcript/${submittedData.id}`, { headers })
    await requireOk(response, 'AssemblyAI')
    const data = await response.json() as { status?: unknown; error?: unknown; text?: unknown; utterances?: Array<Record<string, unknown>>; words?: Array<Record<string, unknown>> }
    if (data.status === 'error') throw new Error(`AssemblyAI ถอดเสียงไม่สำเร็จ${typeof data.error === 'string' ? `: ${data.error}` : ''}`)
    if (data.status !== 'completed') continue
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    const source = data.utterances?.length ? data.utterances : data.words ?? []
    const segments = source.flatMap((item) => typeof item.text === 'string' ? [{
      start: typeof item.start === 'number' ? item.start / 1_000 : 0, end: typeof item.end === 'number' ? item.end / 1_000 : 0, text: item.text.trim(),
      ...(typeof item.speaker === 'string' ? { speaker: `ผู้พูด ${item.speaker}` } : {}),
      ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
    }] : [])
    return { provider: 'assemblyai', text, segments }
  }
  throw new Error('AssemblyAI ใช้เวลานานเกินกำหนด กรุณาลองอีกครั้ง')
}

const providers: Record<ProviderName, (audio: Buffer, options: TranscriptionOptions) => Promise<ProviderResult>> = { groq, deepgram, assemblyai, cloudflare, azure, google }

export function configuredTranscriptionProviders(): ProviderName[] {
  const enabled: ProviderName[] = []
  if (process.env.GROQ_API_KEY) enabled.push('groq')
  if (process.env.DEEPGRAM_API_KEY) enabled.push('deepgram')
  if (process.env.ASSEMBLYAI_API_KEY) enabled.push('assemblyai')
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) enabled.push('cloudflare')
  if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION) enabled.push('azure')
  if (process.env.GOOGLE_SPEECH_API_KEY) enabled.push('google')
  return enabled
}

export async function transcribeWithFallback(audio: Buffer, requested: ProviderName | 'auto', options: TranscriptionOptions) {
  const available = configuredTranscriptionProviders()
  const preferred: ProviderName[] = options.speakerLabels ? ['deepgram', 'assemblyai', 'groq', 'cloudflare', 'azure', 'google'] : ['groq', 'deepgram', 'cloudflare', 'azure', 'google', 'assemblyai']
  const order = requested === 'auto' ? preferred.filter((name) => available.includes(name)) : [requested]
  if (!order.length) throw new Error('ยังไม่ได้ตั้งค่าผู้ให้บริการถอดเสียงออนไลน์')
  const failures: string[] = []
  let lastError: unknown
  for (const name of order) {
    try { return await providers[name](audio, options) }
    catch (error) {
      lastError = error
      failures.push(error instanceof Error ? error.message : String(error))
      if (requested !== 'auto') throw error
    }
  }
  if (order.length === 1) throw lastError
  throw new Error(`ผู้ให้บริการถอดเสียงทั้งหมดไม่พร้อมใช้งาน: ${failures.join(' | ')}`)
}
