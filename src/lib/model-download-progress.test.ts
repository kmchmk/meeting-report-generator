import { describe, expect, it } from 'vitest'
import { aggregateModelDownloadProgress } from './model-download-progress'

describe('model download progress aggregation', () => {
  it('does not jump to completion before a later large file is discovered', () => {
    const files = new Map([['config.json', { loaded: 100, total: 100 }]])
    expect(aggregateModelDownloadProgress(files.values(), 1_000).progress).toBe(10)

    files.set('encoder.onnx', { loaded: 100, total: 900 })
    const next = aggregateModelDownloadProgress(files.values(), 1_000)
    expect(next).toEqual({ loadedBytes: 200, totalBytes: 1_000, progress: 20 })
  })

  it('uses a larger discovered total if model files grow later', () => {
    const result = aggregateModelDownloadProgress([{ loaded: 500, total: 2_000 }], 1_000)
    expect(result).toEqual({ loadedBytes: 500, totalBytes: 2_000, progress: 25 })
  })
})
