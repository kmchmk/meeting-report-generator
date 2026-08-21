import { describe, expect, it } from 'vitest'
import { teeStreamWithBackpressure } from './streams'

describe('backpressure-safe stream tee', () => {
  it('preserves chunks for both consumers and waits for the slower branch', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.enqueue(new Uint8Array([2]))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      },
    })
    const [fastStream, slowStream] = teeStreamWithBackpressure(source)
    const fast = fastStream.getReader()
    const slow = slowStream.getReader()

    expect((await fast.read()).value).toEqual(new Uint8Array([1]))
    expect((await slow.read()).value).toEqual(new Uint8Array([1]))

    expect((await fast.read()).value).toEqual(new Uint8Array([2]))
    let fastThirdSettled = false
    const fastThird = fast.read().then((result) => {
      fastThirdSettled = true
      return result
    })
    await Promise.resolve()
    expect(fastThirdSettled).toBe(false)

    const slowSecond = slow.read()
    expect((await slowSecond).value).toEqual(new Uint8Array([2]))
    expect((await fastThird).value).toEqual(new Uint8Array([3]))
    expect((await slow.read()).value).toEqual(new Uint8Array([3]))
    expect((await fast.read()).done).toBe(true)
    expect((await slow.read()).done).toBe(true)
  })

  it('allows the remaining consumer to continue if one branch cancels', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([7]))
        controller.close()
      },
    })
    const [keptStream, cancelledStream] = teeStreamWithBackpressure(source)
    const kept = keptStream.getReader()
    await cancelledStream.cancel()
    expect((await kept.read()).value).toEqual(new Uint8Array([7]))
    expect((await kept.read()).done).toBe(true)
  })
})
