import { describe, expect, it } from 'vitest'
import { calculateOverallProgress, createProgressSteps, formatBytes } from './progress'

describe('processing progress', () => {
  it('calculates weighted overall progress', () => {
    const steps = createProgressSteps('whisper-model')
    const transcription = steps.find((step) => step.id === 'transcription')!
    transcription.status = 'active'
    transcription.progress = 50
    expect(calculateOverallProgress(steps)).toBe(45)
  })

  it('does not pretend an indeterminate step has measurable progress', () => {
    const steps = createProgressSteps('gemma-download')
    const compile = steps.find((step) => step.id === 'gemma-compile')!
    compile.status = 'active'
    compile.progress = null
    expect(calculateOverallProgress(steps)).toBe(82)
  })

  it('formats model download sizes', () => {
    expect(formatBytes(2_621_440)).toBe('2.5 MB')
    expect(formatBytes(2_147_483_648)).toBe('2.00 GB')
  })
})
