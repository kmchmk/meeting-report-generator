import { describe, expect, it } from 'vitest'
import { getAudioLimits, mixAudioChannels, validateAudioDuration, validateAudioSelection } from './audio'

describe('audio limits', () => {
  it('adapts duration to reported device memory', () => {
    expect(getAudioLimits(2).maxDurationSeconds).toBe(1_800)
    expect(getAudioLimits(8).maxDurationSeconds).toBe(5_400)
    expect(getAudioLimits(16).maxDurationSeconds).toBe(7_200)
  })

  it('rejects unsupported, oversized, and overlong files', () => {
    const limits = getAudioLimits(4)
    expect(validateAudioSelection({ name: 'notes.pdf', type: 'application/pdf', size: 1 }, limits)).toContain('กรุณาเลือกไฟล์เสียง')
    expect(validateAudioSelection({ name: 'meeting.mp3', type: 'audio/mpeg', size: limits.maxBytes + 1 }, limits)).toContain('ขนาดเกิน')
    expect(validateAudioDuration(limits.maxDurationSeconds + 1, limits)).toContain('ยาวเกิน')
  })
})

describe('channel mixing', () => {
  it('averages all channels into one Float32Array', () => {
    const channels = [new Float32Array([1, -1]), new Float32Array([-1, 1])]
    const buffer = { length: 2, numberOfChannels: 2, getChannelData: (index: number) => channels[index] } as unknown as AudioBuffer
    expect(Array.from(mixAudioChannels(buffer))).toEqual([0, 0])
  })
})
