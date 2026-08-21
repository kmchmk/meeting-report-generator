export type AudioLimits = {
  maxBytes: number
  maxDurationSeconds: number
}

export function getAudioLimits(deviceMemoryGb?: number): AudioLimits {
  const memory = deviceMemoryGb ?? 4
  const maxDurationSeconds = memory >= 16 ? 7_200 : memory >= 8 ? 5_400 : memory >= 4 ? 3_600 : 1_800
  return { maxBytes: 250 * 1024 * 1024, maxDurationSeconds }
}

export function validateAudioSelection(file: Pick<File, 'name' | 'type' | 'size'>, limits: AudioLimits) {
  if (!file.type.startsWith('audio/') && !/\.(mp3|m4a|wav|ogg|webm)$/i.test(file.name)) {
    return 'กรุณาเลือกไฟล์เสียง MP3, M4A, WAV, OGG หรือ WebM'
  }
  if (file.size > limits.maxBytes) {
    return `ไฟล์มีขนาดเกิน ${Math.round(limits.maxBytes / 1024 / 1024)} MB กรุณาบีบอัดหรือแบ่งไฟล์ก่อนประมวลผล`
  }
  return null
}

export function validateAudioDuration(duration: number, limits: AudioLimits) {
  if (!Number.isFinite(duration) || duration <= 0) return 'ไม่สามารถอ่านระยะเวลาของไฟล์เสียงนี้ได้'
  if (duration > limits.maxDurationSeconds) {
    return `ไฟล์ยาวเกิน ${Math.round(limits.maxDurationSeconds / 60)} นาทีสำหรับหน่วยความจำของอุปกรณ์นี้ กรุณาแบ่งไฟล์ก่อนประมวลผล`
  }
  return null
}

export async function readAudioDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<number>((resolve, reject) => {
      const audio = document.createElement('audio')
      audio.preload = 'metadata'
      audio.onloadedmetadata = () => resolve(audio.duration)
      audio.onerror = () => reject(new Error('ไม่สามารถอ่านข้อมูลไฟล์เสียงนี้ได้'))
      audio.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function mixAudioChannels(buffer: AudioBuffer): Float32Array {
  const output = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const input = buffer.getChannelData(channel)
    const scale = 1 / buffer.numberOfChannels
    for (let index = 0; index < input.length; index += 1) output[index] += input[index] * scale
  }
  return output
}

export async function decodeAudio(file: File): Promise<{ samples: Float32Array; duration: number }> {
  const context = new AudioContext({ sampleRate: 16_000 })
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer())
    if (decoded.sampleRate !== 16_000) throw new Error('เบราว์เซอร์ไม่สามารถแปลงเสียงเป็น 16 kHz ได้')
    return { samples: mixAudioChannels(decoded), duration: decoded.duration }
  } finally {
    await context.close()
  }
}

export function formatDuration(seconds: number) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
