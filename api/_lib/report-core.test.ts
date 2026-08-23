import { describe, expect, it } from 'vitest'
import { buildFinalReportPrompt, buildRepairPrompt, buildSummarizePrompt, chunkText, parseMeetingReport, reduceTranscriptSequentially, REPORT_SCHEMA, validateMeetingReport } from './report-core'

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
    expect(calls).toEqual([0, 1, 2, 3])
    expect(reduced.length).toBeLessThanOrEqual(3_800)
  })

  it('fails safely when a model does not compress the source', async () => {
    await expect(reduceTranscriptSequentially('ก'.repeat(6_000), async (part) => part)).rejects.toThrow('ไม่สามารถย่อ')
  })
})

describe('prompt builders', () => {
  it('keeps the schema and part coordinates in every prompt', () => {
    expect(buildSummarizePrompt('ข้อมูล', 0, 2, 3)).toContain('ส่วนที่ 1 จาก 2')
    expect(buildSummarizePrompt('ข้อมูล', 0, 2, 3)).toContain('รอบที่ 3')
    expect(buildFinalReportPrompt('สรุปการประชุม')).toContain(REPORT_SCHEMA)
    expect(buildRepairPrompt('{broken')).toContain('{broken')
  })
})
