export type MeetingReport = {
  title: string
  date: string
  overview: string
  topics: { title: string; detail: string }[]
  decisions: string[]
  actions: { task: string; owner: string; due: string }[]
  risks: string[]
}

export const MAX_SOURCE_CHARS = 4_500
export const MAX_FINAL_SOURCE_CHARS = 5_000
export const MAX_REDUCTION_PASSES = 6

export const SECRETARY_SYSTEM_PROMPT = 'คุณเป็นเลขานุการการประชุมมืออาชีพ วิเคราะห์เฉพาะข้อมูลที่ได้รับ ห้ามแต่งข้อมูลเพิ่ม'

export const REPORT_SCHEMA = `{"title":"ชื่อการประชุม","date":"วันที่หรือ ไม่ระบุ","overview":"สรุปผู้บริหาร 2-4 ประโยค","topics":[{"title":"หัวข้อ","detail":"สาระสำคัญ"}],"decisions":["มติ"],"actions":[{"task":"งาน","owner":"ผู้รับผิดชอบหรือ ไม่ระบุ","due":"กำหนดส่งหรือ ไม่ระบุ"}],"risks":["ประเด็นติดตามหรือความเสี่ยง"]}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function validateMeetingReport(value: unknown): value is MeetingReport {
  if (!isRecord(value)) return false
  if (!['title', 'date', 'overview'].every((key) => typeof value[key] === 'string')) return false
  if (!isStringArray(value.decisions) || !isStringArray(value.risks)) return false
  if (!Array.isArray(value.topics) || !value.topics.every((item) => isRecord(item) && typeof item.title === 'string' && typeof item.detail === 'string')) return false
  if (!Array.isArray(value.actions) || !value.actions.every((item) => isRecord(item) && typeof item.task === 'string' && typeof item.owner === 'string' && typeof item.due === 'string')) return false
  return true
}

export function extractJsonCandidate(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) return fenced.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('โมเดลไม่ส่งคืนข้อมูล JSON')
  return text.slice(start, end + 1)
}

export function parseMeetingReport(text: string): MeetingReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonCandidate(text))
  } catch (error) {
    throw new Error(`รูปแบบ JSON ไม่ถูกต้อง: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!validateMeetingReport(parsed)) throw new Error('รายงานจากโมเดลไม่ตรงกับโครงสร้างที่กำหนด')
  return parsed
}

export function chunkText(text: string, maxChars = MAX_SOURCE_CHARS) {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(offset + maxChars, text.length)
    if (end < text.length) {
      const preferredBreak = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf(' ', end))
      if (preferredBreak > offset + maxChars * 0.6) end = preferredBreak
    }
    chunks.push(text.slice(offset, end).trim())
    offset = end
    while (/\s/.test(text[offset] ?? '')) offset += 1
  }
  return chunks.filter(Boolean)
}

type Summarizer = (part: string, index: number, total: number, pass: number) => Promise<string>

export async function reduceTranscriptSequentially(source: string, summarize: Summarizer) {
  let current = source.trim()
  for (let pass = 1; current.length > MAX_FINAL_SOURCE_CHARS; pass += 1) {
    if (pass > MAX_REDUCTION_PASSES) throw new Error('บทถอดเสียงยาวเกินกว่าจะย่อให้อยู่ในบริบทของโมเดลได้อย่างปลอดภัย')
    const parts = chunkText(current)
    const summaries: string[] = []
    for (let index = 0; index < parts.length; index += 1) {
      summaries.push((await summarize(parts[index], index, parts.length, pass)).trim())
    }
    const next = summaries.map((summary, index) => `ส่วนที่ ${index + 1}:\n${summary}`).join('\n\n')
    if (next.length >= current.length) throw new Error('โมเดลไม่สามารถย่อบทถอดเสียงให้สั้นลงได้ กรุณาแบ่งไฟล์เสียง')
    current = next
  }
  return current
}

export function buildSummarizePrompt(part: string, index: number, total: number, pass: number) {
  return `ย่อข้อมูลการประชุมรอบที่ ${pass} ส่วนที่ ${index + 1} จาก ${total} ให้กระชับไม่เกิน 350 คำ เก็บชื่อบุคคล ตัวเลข มติ งาน ผู้รับผิดชอบ กำหนดเวลา และความเสี่ยงทั้งหมด ห้ามเพิ่มข้อมูล:\n${part}`
}

export function buildFinalReportPrompt(source: string) {
  return `สร้างรายงานการประชุมภาษาไทยอย่างละเอียดจากข้อมูลด้านล่าง ส่งคืน JSON ที่ถูกต้องตาม schema นี้เท่านั้น ห้ามใช้ markdown:\n${REPORT_SCHEMA}\nหากไม่มีข้อมูลในหมวดใดให้ใช้ array ว่าง รักษาชื่อบุคคล ตัวเลข และกำหนดเวลาให้ตรงต้นฉบับ\n\nข้อมูลการประชุม:\n${source}`
}

export function buildRepairPrompt(raw: string) {
  return `แก้ข้อมูลด้านล่างให้เป็น JSON ที่ถูกต้องและตรงตาม schema เท่านั้น ห้ามใช้ markdown ห้ามเพิ่มข้อเท็จจริง หากค่าขาดหายให้ใช้ "ไม่ระบุ" หรือ array ว่างตามชนิดข้อมูล\nSchema: ${REPORT_SCHEMA}\nข้อมูลที่ต้องแก้:\n${raw}`
}
