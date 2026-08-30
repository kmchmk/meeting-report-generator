export type CloudTranscriptionProvider = 'auto' | 'groq' | 'deepgram' | 'assemblyai' | 'cloudflare' | 'azure' | 'google'
export type CloudReportProvider = 'auto' | 'groq' | 'gemini'

export type TranscriptChunk = {
  timestamp: [number, number]
  text: string
  speaker?: string
  confidence?: number
}

export type TranscriptResult = {
  text: string
  chunks?: TranscriptChunk[]
  provider?: string
}
export type AsrModelId = 'small' | 'large-v3-turbo'

export type MeetingHistoryItem = {
  id: string
  createdAt: string
  fileName: string
  duration: number
  engine: 'local' | 'cloud'
  transcript: TranscriptResult
  report: import('../api/_lib/report-core').MeetingReport
}
