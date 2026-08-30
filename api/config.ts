import type { IncomingMessage, ServerResponse } from 'node:http'
import { configuredTranscriptionProviders } from './_lib/transcription-providers.js'

export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify({
    cloudEnabled: process.env.ENABLE_CLOUD_MODE === 'true',
    transcriptionProviders: configuredTranscriptionProviders(),
    reportProviders: [process.env.GROQ_API_KEY ? 'groq' : '', process.env.GEMINI_API_KEY ? 'gemini' : ''].filter(Boolean),
  }))
}
