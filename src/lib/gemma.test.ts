import { describe, expect, it } from 'vitest'
import { chunkText, createProgressStream, formatEngineElapsed, parseMeetingReport, reduceTranscriptSequentially, validateMeetingReport } from './gemma'

const validReport = {
  title: 'ประชุมทีม', date: '21 สิงหาคม', overview: 'สรุป',
  topics: [{ title: 'หัวข้อ', detail: 'รายละเอียด' }],
  decisions: ['อนุมัติ'], actions: [{ task: 'ทดสอบ', owner: 'นัท', due: 'พรุ่งนี้' }], risks: [],
}

describe('meeting report validation', () => {
  it('accepts valid reports and fenced JSON', () => {
    expect(validateMeetingReport(validReport)).toBe(true)
    expect(parseMeetingReport(`คำตอบ\n\`\`\`json\n${JSON.stringify(validReport)}\n\`\`\``)).toEqual(validReport)
  })

  it('rejects malformed JSON and missing fields', () => {
    expect(() => parseMeetingReport('{broken')).toThrow('JSON')
    expect(validateMeetingReport({ title: 'ไม่ครบ' })).toBe(false)
  })
})

describe('hierarchical transcript reduction', () => {
  it('chunks without losing non-whitespace content', () => {
    const source = `${'ก'.repeat(3_000)} ${'ข'.repeat(3_000)}`
    expect(chunkText(source).join('').replaceAll(' ', '')).toBe(source.replaceAll(' ', ''))
  })

  it('runs summaries sequentially and reduces to the final budget', async () => {
    let active = 0
    let peak = 0
    const calls: number[] = []
    const reduced = await reduceTranscriptSequentially('ก'.repeat(12_000), async (part, index) => {
      active += 1; peak = Math.max(peak, active); calls.push(index)
      await Promise.resolve()
      active -= 1
      return part.slice(0, 700)
    })
    expect(peak).toBe(1)
    expect(calls).toEqual([0, 1, 2])
    expect(reduced.length).toBeLessThanOrEqual(5_000)
  })

  it('fails safely when a model does not compress the source', async () => {
    await expect(reduceTranscriptSequentially('ก'.repeat(6_000), async (part) => part)).rejects.toThrow('ไม่สามารถย่อ')
  })
})

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
