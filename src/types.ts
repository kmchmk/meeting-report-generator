export type TranscriptChunk = { timestamp: [number, number]; text: string }
export type TranscriptResult = { text: string; chunks?: TranscriptChunk[] }
export type AsrModelId = 'small' | 'large-v3-turbo'
