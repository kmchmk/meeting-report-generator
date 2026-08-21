/**
 * Splits a byte stream while applying backpressure from both consumers.
 * Native ReadableStream.tee() lets the faster branch buffer without limit,
 * which is unsafe for multi-gigabyte model files.
 */
export function teeStreamWithBackpressure(source: ReadableStream<Uint8Array>) {
  const reader = source.getReader()
  const controllers: Array<ReadableStreamDefaultController<Uint8Array> | undefined> = []
  const waiting = [false, false]
  const cancelled = [false, false]
  let reading = false
  let finished = false

  async function pump() {
    if (reading || finished) return
    const activeBranches = [0, 1].filter((index) => !cancelled[index])
    if (activeBranches.length === 0) {
      finished = true
      await reader.cancel()
      return
    }
    if (activeBranches.some((index) => !controllers[index] || !waiting[index])) return

    reading = true
    try {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        for (const index of activeBranches) controllers[index]?.close()
        return
      }
      for (const index of activeBranches) {
        waiting[index] = false
        controllers[index]?.enqueue(value)
      }
    } catch (error) {
      finished = true
      for (const index of activeBranches) controllers[index]?.error(error)
    } finally {
      reading = false
      if (!finished) void pump()
    }
  }

  const branches = ([0, 1] as const).map((index) => new ReadableStream<Uint8Array>({
    start(controller) {
      controllers[index] = controller
    },
    pull() {
      waiting[index] = true
      return pump()
    },
    async cancel(reason) {
      cancelled[index] = true
      waiting[index] = true
      if (cancelled.every(Boolean)) {
        finished = true
        await reader.cancel(reason)
      } else {
        await pump()
      }
    },
  }))

  return branches as [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>]
}
