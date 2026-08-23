import { env, pipeline, WhisperTextStreamer } from '@huggingface/transformers'
import type { WhisperTokenizer } from '@huggingface/transformers'
import { aggregateModelDownloadProgress, type DownloadFileProgress } from '../lib/model-download-progress'
import type { AsrModelId } from '../types'

env.allowLocalModels = false
env.useBrowserCache = true

type Message = { type: 'transcribe'; audio: Float32Array; model: AsrModelId }
type Transcriber = ((audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>) & { tokenizer: WhisperTokenizer }
let transcriber: Transcriber | null = null

const MODEL_CONFIGS: Record<AsrModelId, {
  id: string
  label: string
  estimatedBytes: number
  dtype: { encoder_model: 'fp16' | 'fp32'; decoder_model_merged: 'q4' }
}> = {
  small: {
    id: 'onnx-community/whisper-small',
    label: 'Whisper Small',
    estimatedBytes: 590_000_000,
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  },
  'large-v3-turbo': {
    id: 'onnx-community/whisper-large-v3-turbo',
    label: 'Whisper Large V3 Turbo',
    estimatedBytes: 1_950_000_000,
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
  },
}

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
      const files = new Map<string, DownloadFileProgress>()
      sendProgress('whisper-model', 0, `กำลังตรวจสอบแคชของ ${model.label}…`)
      transcriber = await pipeline('automatic-speech-recognition', model.id, {
        device: 'webgpu',
        dtype: model.dtype,
        progress_callback: (item: ModelProgressInfo) => {
          if (item.status !== 'progress' || item.file === undefined || item.loaded === undefined || item.total === undefined) return
          files.set(item.file, { loaded: item.loaded, total: item.total })
          const aggregate = aggregateModelDownloadProgress(files.values(), model.estimatedBytes)
          sendProgress('whisper-model', aggregate.progress, `กำลังดาวน์โหลด ${item.file}`, {
            loadedBytes: aggregate.loadedBytes,
            totalBytes: aggregate.totalBytes,
          })
        },
      }) as unknown as Transcriber
      self.postMessage({
        type: 'progress', step: 'whisper-model', progress: 100,
        detail: `${model.label} พร้อมใช้งาน`, status: 'done',
        loadedBytes: model.estimatedBytes, totalBytes: model.estimatedBytes,
      })
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
