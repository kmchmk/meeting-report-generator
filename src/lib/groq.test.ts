import { describe, expect, it } from 'vitest'
import { chunkSamples, createNdjsonParser, encodeWav, floatToInt16, retryDelayMs, CHUNK_SECONDS, SAMPLE_RATE } from './groq'

describe('pcm conversion', () => {
  it('clamps and quantizes float samples to 16-bit', () => {
    const pcm = floatToInt16(new Float32Array([-2, -1, 0, 0.5, 2]))
    expect([...pcm]).toEqual([-32768, -32768, 0, 16383, 32767])
  })
})

describe('wav encoding', () => {
  it('writes a valid mono 16 kHz PCM header', () => {
    const wav = encodeWav(new Float32Array(SAMPLE_RATE))
    const view = new DataView(wav.buffer)
    const text = (offset: number, length: number) => String.fromCharCode(...wav.subarray(offset, offset + length))
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(SAMPLE_RATE * 2)
    expect(wav.byteLength).toBe(44 + SAMPLE_RATE * 2)
    expect(wav.byteLength).toBeLessThan(4_500_000)
  })
})

describe('sample chunking', () => {
  it('keeps short audio in one chunk and splits long audio at fixed boundaries', () => {
    expect(chunkSamples(new Float32Array(SAMPLE_RATE))).toHaveLength(1)
    const long = new Float32Array(Math.floor(SAMPLE_RATE * 250))
    const chunks = chunkSamples(long)
    expect(chunks).toHaveLength(3)
    for (const chunk of chunks.slice(0, -1)) expect(chunk.length).toBe(CHUNK_SECONDS * SAMPLE_RATE)
  })
})

describe('free-tier retry timing', () => {
  it('uses Retry-After seconds and caps excessive waits', () => {
    expect(retryDelayMs('2')).toBe(2_000)
    expect(retryDelayMs('999')).toBe(20_000)
    expect(retryDelayMs(null)).toBe(5_000)
  })
})

describe('ndjson stream parsing', () => {
  it('parses lines split across chunks including multibyte characters', () => {
    const lines: unknown[] = []
    const parser = createNdjsonParser((value) => lines.push(value))
    const encoder = new TextEncoder()
    const first = encoder.encode('{"a":"สวัส')
    parser.push(first.subarray(0, 9))
    parser.push(first.subarray(9))
    parser.push(encoder.encode('ดี"}\n{"b":true}\n'))
    parser.push(encoder.encode('\n{"c":1}'))
    parser.flush()
    expect(lines).toEqual([{ a: 'สวัสดี' }, { b: true }, { c: 1 }])
  })

  it('ignores blank lines', () => {
    const lines: unknown[] = []
    const parser = createNdjsonParser((value) => lines.push(value))
    parser.push(new TextEncoder().encode('\n\n{"x":null}\n\n'))
    parser.flush()
    expect(lines).toEqual([{ x: null }])
  })
})
