import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import reportHandler from './report'
import transcribeHandler from './transcribe'

class TestResponse {
  statusCode = 200
  writableEnded = false
  destroyed = false
  headers = new Map<string, string>()
  chunks: string[] = []

  setHeader(name: string, value: string | number | readonly string[]) {
    this.headers.set(name.toLowerCase(), String(value))
  }

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    return this
  }

  write(chunk: string | Uint8Array) {
    this.chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    return true
  }

  end(chunk?: string | Uint8Array) {
    if (chunk !== undefined) this.write(chunk)
    this.writableEnded = true
    return this
  }

  get body() { return this.chunks.join('') }
}

function request(body: string | Uint8Array) {
  const req = Readable.from([typeof body === 'string' ? Buffer.from(body) : body]) as IncomingMessage
  req.method = 'POST'
  req.headers = {}
  return req
}

function response() {
  const value = new TestResponse()
  return { value, server: value as unknown as ServerResponse }
}

describe('cloud API handlers with synthetic data', () => {
  const originalApiKey = process.env.GROQ_API_KEY
  const originalCloudMode = process.env.ENABLE_CLOUD_MODE
  const originalDeepgramKey = process.env.DEEPGRAM_API_KEY
  const originalGeminiKey = process.env.GEMINI_API_KEY

  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-only-key'
    process.env.ENABLE_CLOUD_MODE = 'true'
    delete process.env.DEEPGRAM_API_KEY
    delete process.env.GEMINI_API_KEY
  })
  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalApiKey
    if (originalCloudMode === undefined) delete process.env.ENABLE_CLOUD_MODE
    else process.env.ENABLE_CLOUD_MODE = originalCloudMode
    if (originalDeepgramKey === undefined) delete process.env.DEEPGRAM_API_KEY
    else process.env.DEEPGRAM_API_KEY = originalDeepgramKey
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalGeminiKey
    vi.unstubAllGlobals()
  })

  it('keeps cloud processing disabled unless explicitly configured', async () => {
    delete process.env.ENABLE_CLOUD_MODE
    const res = response()
    await transcribeHandler(request(new Uint8Array([1])), res.server)
    expect(res.value.statusCode).toBe(404)
  })

  it('rejects oversized audio without destroying the response socket', async () => {
    const res = response()
    await transcribeHandler(request(new Uint8Array(4_400_001)), res.server)
    expect(res.value.statusCode).toBe(413)
    expect(res.value.writableEnded).toBe(true)
    expect(JSON.parse(res.value.body).error).toContain('ใหญ่เกิน')
  })

  it('transcribes a small synthetic audio payload through the server boundary', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'ข้อความทดสอบ' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const res = response()
    await transcribeHandler(request(new Uint8Array([1, 2, 3, 4])), res.server)
    expect(res.value.statusCode).toBe(200)
    expect(JSON.parse(res.value.body)).toEqual({ text: 'ข้อความทดสอบ', segments: [], provider: 'groq' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('forwards Groq retry timing when the free-tier audio limit is reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '7' },
    })))
    const res = response()
    await transcribeHandler(request(new Uint8Array([1, 2, 3, 4])), res.server)
    expect(res.value.statusCode).toBe(429)
    expect(res.value.headers.get('retry-after')).toBe('7')
  })

  it('returns a useful message when Groq blocks the current network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Access denied' } }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })))
    const res = response()
    await transcribeHandler(request(new Uint8Array([1, 2, 3, 4])), res.server)
    expect(res.value.statusCode).toBe(502)
    expect(JSON.parse(res.value.body).error).toContain('การตั้งค่าเครือข่าย')
  })

  it('automatically falls back to Deepgram and returns speaker timestamps', async () => {
    process.env.DEEPGRAM_API_KEY = 'deepgram-test-key'
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('groq.com')) return new Response(JSON.stringify({ error: { message: 'temporary failure' } }), { status: 503 })
      return new Response(JSON.stringify({ results: {
        utterances: [{ start: 0.2, end: 2.1, transcript: 'สวัสดีค่ะ', speaker: 0, confidence: 0.94 }],
        channels: [{ alternatives: [{ transcript: 'สวัสดีค่ะ' }] }],
      } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const req = request(new Uint8Array([1, 2, 3, 4]))
    req.headers['x-speaker-labels'] = 'true'
    const res = response()
    await transcribeHandler(req, res.server)
    expect(res.value.statusCode).toBe(200)
    expect(JSON.parse(res.value.body)).toMatchObject({ provider: 'deepgram', segments: [{ speaker: 'ผู้พูด 1', start: 0.2, end: 2.1 }] })
  })

  it('rejects an oversized report request before calling the model service', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = response()
    await reportHandler(request(new Uint8Array(1_500_001)), res.server)
    expect(res.value.statusCode).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('streams a validated report for a synthetic transcript', async () => {
    const report = {
      title: 'ประชุมทดสอบ', date: 'ไม่ระบุ', overview: 'สรุปสำหรับการทดสอบ',
      topics: [{ title: 'หัวข้อ', detail: 'รายละเอียด' }], decisions: [], actions: [], risks: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(report) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const res = response()
    await reportHandler(request(JSON.stringify({ transcript: 'นี่คือบทถอดเสียงสังเคราะห์สำหรับทดสอบเท่านั้น' })), res.server)
    expect(res.value.statusCode).toBe(200)
    expect(res.value.headers.get('content-type')).toContain('application/x-ndjson')
    const events = res.value.body.trim().split('\n').map((line) => JSON.parse(line))
    expect(events.at(-1)).toEqual({ type: 'report', report })
  })

  it('uses Gemini when Groq report generation is unavailable', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test-key'
    const report = { title: 'Gemini fallback', date: 'ไม่ระบุ', overview: 'สำเร็จ', topics: [], decisions: [], actions: [], risks: [] }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('groq.com')
      ? new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503 })
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(report) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const res = response()
    await reportHandler(request(JSON.stringify({ transcript: 'บทถอดเสียงทดสอบ Gemini', provider: 'auto' })), res.server)
    const events = res.value.body.trim().split('\n').map((line) => JSON.parse(line))
    expect(events.at(-1)).toEqual({ type: 'report', report })
  })
})
