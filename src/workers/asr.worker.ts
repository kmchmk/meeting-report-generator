import { env, pipeline, WhisperTextStreamer } from '@huggingface/transformers'
import type { WhisperTokenizer } from '@huggingface/transformers'
import type { AsrModelId } from '../types'

env.allowLocalModels = false
env.useBrowserCache = true

type Message = { type: 'transcribe'; audio: Float32Array; model: AsrModelId }
type Transcriber = ((audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>) & { tokenizer: WhisperTokenizer }
let transcriber: Transcriber | null = null

const MODEL_CONFIGS: Record<AsrModelId, {
  id: string
  label: string
  dtype: { encoder_model: 'fp16' | 'fp32'; decoder_model_merged: 'q4' }
}> = {
  small: {
    id: 'onnx-community/whisper-small',
    label: 'Whisper Small',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  },
  'large-v3-turbo': {
    id: 'onnx-community/whisper-large-v3-turbo',
    label: 'Whisper Large V3 Turbo',
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
  },
}

type DownloadFile = { loaded: number; total: number }
type ModelProgressInfo = {
  status: string
  file?: string
  progress?: number
  loaded?: number
  total?: number
}

function sendProgress(step: 'whisper-model' | 'transcription', progress: number | null, detail: string, extra: Record<string, unknown> = {}) {
  self.postMessage({ type: 'progress', step, progress, detail, status: 'active', ...extra })
}

self.onmessage = async ({ data }: MessageEvent<Message>) => {
  if (data.type !== 'transcribe') return
  try {
    const model = MODEL_CONFIGS[data.model]
    if (!transcriber) {
      const files = new Map<string, DownloadFile>()
      let highestProgress = 0
      sendProgress('whisper-model', 0, `กำลังตรวจสอบแคชของ ${model.label}…`)
      transcriber = await pipeline('automatic-speech-recognition', model.id, {
        device: 'webgpu',
        dtype: model.dtype,
        progress_callback: (item: ModelProgressInfo) => {
          if (item.status !== 'progress' || item.file === undefined || item.loaded === undefined || item.total === undefined) return
          files.set(item.file, { loaded: item.loaded, total: item.total })
          const totals = [...files.values()].reduce((sum, file) => ({
            loaded: sum.loaded + file.loaded,
            total: sum.total + file.total,
          }), { loaded: 0, total: 0 })
          const aggregate = totals.total > 0 ? totals.loaded / totals.total * 100 : (item.progress ?? 0)
          highestProgress = Math.max(highestProgress, Math.min(99, aggregate))
          sendProgress('whisper-model', highestProgress, `กำลังดาวน์โหลด ${item.file}`, {
            loadedBytes: totals.loaded,
            totalBytes: totals.total,
          })
        },
      }) as unknown as Transcriber
      self.postMessage({ type: 'progress', step: 'whisper-model', progress: 100, detail: `${model.label} พร้อมใช้งาน`, status: 'done' })
    } else {
      self.postMessage({ type: 'progress', step: 'whisper-model', progress: 100, detail: 'ใช้โมเดล Whisper ที่เตรียมไว้แล้ว', status: 'done' })
    }

    const chunkLengthSeconds = 30
    const strideSeconds = 5
    const durationSeconds = data.audio.length / 16_000
    const chunkCount = durationSeconds <= chunkLengthSeconds
      ? 1
      : Math.ceil((durationSeconds - chunkLengthSeconds) / (chunkLengthSeconds - 2 * strideSeconds)) + 1
    let completedChunks = 0
    const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
      on_finalize: () => {
        completedChunks = Math.min(chunkCount, completedChunks + 1)
        sendProgress(
          'transcription',
          Math.min(99, completedChunks / chunkCount * 100),
          `ประมวลผลช่วงเสียง ${completedChunks} จาก ${chunkCount}`,
        )
      },
    })
    sendProgress('transcription', 0, `กำลังถอดเสียง 0 จาก ${chunkCount} ช่วง`)
    const result = await transcriber(data.audio, {
      language: 'th',
      task: 'transcribe',
      return_timestamps: true,
      chunk_length_s: chunkLengthSeconds,
      stride_length_s: strideSeconds,
      streamer,
    })
    self.postMessage({ type: 'progress', step: 'transcription', progress: 100, detail: `ถอดเสียงครบ ${chunkCount} ช่วง`, status: 'done' })
    self.postMessage({ type: 'complete', result })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
