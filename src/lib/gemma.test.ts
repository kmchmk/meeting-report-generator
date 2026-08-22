import { describe, expect, it } from 'vitest'
import { createProgressStream, formatEngineElapsed } from './gemma'

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
})
