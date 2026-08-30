import { describe, expect, it } from 'vitest'
import { createWordBlob, reportMarkdown } from './export'

const report = {
  title: 'ประชุมทดสอบ', date: '30 สิงหาคม 2569', overview: 'สรุปภาพรวม',
  topics: [{ title: 'หัวข้อ', detail: 'รายละเอียด' }], decisions: ['อนุมัติ'],
  actions: [{ task: 'ทดสอบไฟล์', owner: 'ทีมงาน', due: 'พรุ่งนี้' }], risks: ['ติดตามผล'],
}

describe('report export', () => {
  it('creates readable Markdown', () => {
    expect(reportMarkdown(report)).toContain('# ประชุมทดสอบ')
    expect(reportMarkdown(report)).toContain('ทีมงาน (พรุ่งนี้)')
  })

  it('creates a real Word ZIP document in memory', async () => {
    const blob = await createWordBlob(report)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(String.fromCharCode(...bytes.slice(0, 2))).toBe('PK')
    expect(blob.size).toBeGreaterThan(5_000)
  })
})
