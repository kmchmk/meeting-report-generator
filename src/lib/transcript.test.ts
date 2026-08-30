import { describe, expect, it } from 'vitest'
import { createOverlappingSlices, isSilentAudio, mergeTranscriptChunks, removeRepeatedBoundary } from './transcript'

describe('cloud audio slicing', () => {
  it('adds overlap without losing the end of the recording', () => {
    const slices = createOverlappingSlices(new Float32Array(120), 1, 55, 2)
    expect(slices.map((slice) => [slice.startSeconds, slice.endSeconds])).toEqual([[0, 55], [53, 108], [106, 120]])
  })

  it('only skips truly quiet audio', () => {
    expect(isSilentAudio(new Float32Array(100))).toBe(true)
    expect(isSilentAudio(new Float32Array([0, 0.02, 0]))).toBe(false)
  })
})

describe('overlap text cleanup', () => {
  it('removes repeated Thai text at adjacent chunk boundaries', () => {
    expect(removeRepeatedBoundary('วันนี้เราจะคุยเรื่องงบประมาณ', 'เรื่องงบประมาณ และกำหนดเวลา')).toBe('และกำหนดเวลา')
  })

  it('keeps timestamps while merging', () => {
    const chunks = mergeTranscriptChunks([
      { timestamp: [0, 55], text: 'ทดสอบระบบใหม่' },
      { timestamp: [53, 90], text: 'ระบบใหม่เรียบร้อยแล้ว' },
    ])
    expect(chunks[1]).toMatchObject({ timestamp: [53, 90], text: 'เรียบร้อยแล้ว' })
  })
})
