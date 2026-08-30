import type { MeetingReport } from '../../api/_lib/report-core'

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

export function reportMarkdown(report: MeetingReport) {
  return [`# ${report.title}`, '', `วันที่: ${report.date}`, '', '## สรุปภาพรวม', report.overview, '', '## ประเด็นสำคัญ', ...report.topics.map((item) => `### ${item.title}\n${item.detail}`), '', '## มติที่ประชุม', ...report.decisions.map((item) => `- ${item}`), '', '## งานที่ต้องดำเนินการ', ...report.actions.map((item) => `- ${item.task} — ${item.owner} (${item.due})`), '', '## ประเด็นติดตาม', ...report.risks.map((item) => `- ${item}`)].join('\n')
}

export function downloadMarkdown(report: MeetingReport) {
  downloadBlob(new Blob([reportMarkdown(report)], { type: 'text/markdown;charset=utf-8' }), 'meeting-report.md')
}

export async function createWordBlob(report: MeetingReport) {
  const { AlignmentType, Document, HeadingLevel, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } = await import('docx')
  const heading = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 120 } })
  const bullets = (items: string[]) => items.length ? items.map((text) => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 80 } })) : [new Paragraph('ไม่มีข้อมูล')]
  const actionRows = [
    new TableRow({ children: ['งาน', 'ผู้รับผิดชอบ', 'กำหนดส่ง'].map((text) => new TableCell({ shading: { type: ShadingType.CLEAR, fill: 'E7F0E9' }, children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })] })) }),
    ...report.actions.map((action) => new TableRow({ children: [action.task, action.owner, action.due].map((text) => new TableCell({ children: [new Paragraph(text)] })) })),
  ]
  const document = new Document({
    styles: { default: { document: { run: { font: 'Tahoma', size: 24 }, paragraph: { spacing: { line: 320 } } } } },
    sections: [{ properties: {}, children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: report.title, bold: true, size: 34, color: '1F795E' })], spacing: { after: 100 } }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `วันที่ ${report.date}`, color: '666666' })], spacing: { after: 300 } }),
      heading('สรุปภาพรวม'), new Paragraph({ text: report.overview, spacing: { after: 180 } }),
      heading('ประเด็นสำคัญ'), ...report.topics.flatMap((topic) => [new Paragraph({ children: [new TextRun({ text: topic.title, bold: true })] }), new Paragraph({ text: topic.detail, spacing: { after: 120 } })]),
      heading('มติที่ประชุม'), ...bullets(report.decisions),
      heading('งานที่ต้องดำเนินการ'), new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: actionRows }),
      heading('ประเด็นติดตาม'), ...bullets(report.risks),
    ] }],
  })
  return Packer.toBlob(document)
}

export async function downloadWord(report: MeetingReport) {
  downloadBlob(await createWordBlob(report), 'meeting-report.docx')
}
