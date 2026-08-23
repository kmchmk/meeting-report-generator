import { describe, expect, it } from 'vitest'
import { createProgressStream, fetchModelWithResume, formatEngineElapsed } from './gemma'

describe('model download tracking', () => {
  it('reports cumulative bytes and completion while preserving the stream', async () => {
    const updates: number[] = []
    let completed = false
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3, 4, 5]))
        controller.close()
      },
    })
    const reader = createProgressStream(source, 5, (loaded) => updates.push(loaded), () => { completed = true }).getReader()
    const received: number[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received.push(...value)
    }
    expect(received).toEqual([1, 2, 3, 4, 5])
    expect(updates).toEqual([2, 5])
    expect(completed).toBe(true)
  })

  it('formats short and long engine initialization time', () => {
    expect(formatEngineElapsed(9_900)).toBe('9 วินาที')
    expect(formatEngineElapsed(125_000)).toBe('2:05')
  })

  it('resumes a model stream from the last delivered byte after a network failure', async () => {
    const requestedRanges: Array<string | null> = []
    let request = 0
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      requestedRanges.push(headers.get('range'))
      request += 1
      if (request === 1) {
        let delivered = false
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!delivered) {
              delivered = true
              controller.enqueue(new Uint8Array([1, 2]))
              return
            }
            controller.error(new Error('network interrupted'))
          },
        }), { headers: { 'content-length': '4' } })
      }
      return new Response(new Uint8Array([3, 4]), { status: 206 })
    }) as typeof fetch
    const retries: number[] = []
    const download = await fetchModelWithResume('https://example.test/model', (attempt) => retries.push(attempt), fetcher, async () => {})
    const reader = download.body.getReader()
    const bytes: number[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes.push(...value)
    }
    expect(bytes).toEqual([1, 2, 3, 4])
    expect(requestedRanges).toEqual([null, 'bytes=2-'])
    expect(retries).toEqual([1])
    expect(download.totalBytes).toBe(4)
  })
})
