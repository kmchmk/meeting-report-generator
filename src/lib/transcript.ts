import type { TranscriptChunk } from '../types'

export const CLOUD_CHUNK_SECONDS = 55
export const CLOUD_CHUNK_OVERLAP_SECONDS = 2

export type AudioSlice = { samples: Float32Array; startSeconds: number; endSeconds: number }

export function createOverlappingSlices(
  samples: Float32Array,
  sampleRate = 16_000,
  seconds = CLOUD_CHUNK_SECONDS,
  overlapSeconds = CLOUD_CHUNK_OVERLAP_SECONDS,
): AudioSlice[] {
  const size = Math.max(1, Math.floor(seconds * sampleRate))
  const overlap = Math.min(size - 1, Math.max(0, Math.floor(overlapSeconds * sampleRate)))
  const stride = size - overlap
  const slices: AudioSlice[] = []
  for (let offset = 0; offset < samples.length; offset += stride) {
    const end = Math.min(offset + size, samples.length)
    slices.push({ samples: samples.subarray(offset, end), startSeconds: offset / sampleRate, endSeconds: end / sampleRate })
    if (end === samples.length) break
  }
  return slices
}

export function isSilentAudio(samples: Float32Array) {
  if (!samples.length) return true
  let squareSum = 0
  let peak = 0
  for (const sample of samples) {
    const absolute = Math.abs(sample)
    peak = Math.max(peak, absolute)
    squareSum += sample * sample
  }
  return Math.sqrt(squareSum / samples.length) < 0.001 && peak < 0.01
}

function compact(value: string) {
  return value.toLocaleLowerCase('th-TH').replace(/[\s.,!?;:()[\]{}"'“”‘’\-–—/\\]+/g, '')
}

export function removeRepeatedBoundary(previous: string, current: string, maxCharacters = 160) {
  const left = previous.trim()
  const right = current.trim()
  if (!left || !right) return right
  const leftWindow = left.slice(-maxCharacters)
  const rightWindow = right.slice(0, maxCharacters)
  let bestRawLength = 0
  for (let length = 6; length <= Math.min(leftWindow.length, rightWindow.length); length += 1) {
    if (compact(leftWindow.slice(-length)) === compact(rightWindow.slice(0, length))) bestRawLength = length
  }
  return right.slice(bestRawLength).replace(/^\s+/, '')
}

export function mergeTranscriptChunks(chunks: TranscriptChunk[]) {
  const merged: TranscriptChunk[] = []
  for (const chunk of chunks) {
    const previous = merged.at(-1)
    const text = previous ? removeRepeatedBoundary(previous.text, chunk.text) : chunk.text.trim()
    if (!text) continue
    merged.push({ ...chunk, text })
  }
  return merged
}

export function transcriptText(chunks: TranscriptChunk[]) {
  return chunks.map((chunk) => `${chunk.speaker ? `${chunk.speaker}: ` : ''}${chunk.text}`.trim()).filter(Boolean).join('\n')
}
