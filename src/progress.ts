export type ProgressStepId = 'audio' | 'whisper-model' | 'transcription' | 'gemma-download' | 'gemma-compile' | 'report'
export type ProgressStatus = 'pending' | 'active' | 'done' | 'error'
export type EngineMode = 'local' | 'cloud'

const CLOUD_ONLY_STEPS: ReadonlySet<ProgressStepId> = new Set(['whisper-model', 'gemma-download', 'gemma-compile'])

export type ProgressStep = {
  id: ProgressStepId
  label: string
  detail: string
  progress: number | null
  status: ProgressStatus
  loadedBytes?: number
  totalBytes?: number
}

export type ProgressEvent = {
  step: ProgressStepId
  progress?: number | null
  detail?: string
  status?: ProgressStatus
  loadedBytes?: number
  totalBytes?: number
}

const STEP_DEFINITIONS: Array<Pick<ProgressStep, 'id' | 'label'>> = [
  { id: 'audio', label: 'เตรียมไฟล์เสียง' },
  { id: 'whisper-model', label: 'ดาวน์โหลด Whisper' },
  { id: 'transcription', label: 'ถอดเสียงภาษาไทย' },
  { id: 'gemma-download', label: 'ดาวน์โหลด Gemma' },
  { id: 'gemma-compile', label: 'เตรียม Gemma บน WebGPU' },
  { id: 'report', label: 'สร้างรายงานการประชุม' },
]

const STEP_WEIGHTS: Record<ProgressStepId, number> = {
  audio: 5,
  'whisper-model': 25,
  transcription: 30,
  'gemma-download': 22,
  'gemma-compile': 8,
  report: 10,
}

export function createProgressSteps(mode: EngineMode = 'local', completedThrough?: ProgressStepId): ProgressStep[] {
  const completedIndex = completedThrough ? STEP_DEFINITIONS.findIndex(({ id }) => id === completedThrough) : -1
  return STEP_DEFINITIONS
    .filter(({ id }) => mode === 'local' || !CLOUD_ONLY_STEPS.has(id))
    .map(({ id, label }, index) => ({
      id,
      label: mode === 'cloud' && id === 'transcription' ? 'ถอดเสียงผ่านคลาวด์ (Groq)' : label,
      detail: index <= completedIndex ? 'พร้อมใช้งานแล้ว' : 'รอดำเนินการ',
      progress: index <= completedIndex ? 100 : 0,
      status: index <= completedIndex ? 'done' : 'pending',
    }))
}

export function calculateOverallProgress(steps: ProgressStep[]) {
  let totalWeight = 0
  const weighted = steps.reduce((total, step) => {
    const value = step.status === 'done' ? 100 : step.progress ?? 0
    totalWeight += STEP_WEIGHTS[step.id]
    return total + STEP_WEIGHTS[step.id] * Math.max(0, Math.min(100, value)) / 100
  }, 0)
  return totalWeight > 0 ? weighted * 100 / totalWeight : 0
}

export function formatBytes(bytes?: number) {
  if (bytes === undefined || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
