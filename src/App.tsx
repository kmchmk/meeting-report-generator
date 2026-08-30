import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Check, CheckCircle2, ChevronRight, Clock3, Cloud, FileAudio, FileDown, FileText, History as HistoryIcon, LockKeyhole, Play, Printer, RotateCcw, ShieldCheck, Sparkles, Trash2, Upload, Users, WandSparkles, X } from 'lucide-react'
import { decodeAudio, formatDuration, getAudioLimits, readAudioDuration, validateAudioDuration, validateAudioSelection } from './lib/audio'
import { generateReport } from './lib/gemma'
import { generateReportRemote, transcribeRemote } from './lib/groq'
import { deleteDraft, deleteHistory, fileDraftId, listHistory, loadDraft, saveDraft, saveHistory } from './lib/history'
import { downloadMarkdown, downloadWord } from './lib/export'
import { transcriptText } from './lib/transcript'
import type { MeetingReport } from '../api/_lib/report-core'
import { calculateOverallProgress, createProgressSteps, formatBytes, type EngineMode, type ProgressEvent, type ProgressStep } from './progress'
import type { AsrModelId, CloudReportProvider, CloudTranscriptionProvider, MeetingHistoryItem, TranscriptResult } from './types'

type Stage = 'idle' | 'ready' | 'processing' | 'done' | 'error'

const CLOUD_MODE_ENABLED = import.meta.env.VITE_ENABLE_CLOUD_MODE === 'true'
const DEFAULT_ENGINE: EngineMode = CLOUD_MODE_ENABLED ? 'cloud' : 'local'
const ENGINE_OPTIONS: Array<{ id: EngineMode; name: string; detail: string; technical: string; badge: string }> = [
  ...(CLOUD_MODE_ENABLED ? [{
    id: 'cloud' as const,
    name: 'ใช้งานออนไลน์ — ง่ายและรวดเร็ว',
    detail: 'ระบบจะช่วยถอดเสียงและทำรายงานให้ เหมาะสำหรับการใช้งานทั่วไป ไม่ต้องดาวน์โหลดไฟล์ขนาดใหญ่',
    technical: 'Cloud speech-to-text · Groq/Gemini report fallback',
    badge: 'แนะนำ',
  }] : []),
  {
    id: 'local',
    name: 'ใช้งานแบบส่วนตัว — อยู่ในเครื่องนี้',
    detail: 'ไฟล์ประชุมจะไม่ถูกส่งออกจากอุปกรณ์ เหมาะกับเรื่องลับ แต่การใช้งานครั้งแรกอาจต้องรอดาวน์โหลด',
    technical: 'Offline in browser · Whisper · Gemma',
    badge: 'ส่วนตัวที่สุด',
  },
]

const ASR_MODELS: Array<{ id: AsrModelId; name: string; detail: string; technical: string; badge?: string }> = [
  { id: 'small', name: 'แบบรวดเร็ว', detail: 'ใช้เวลารอน้อยกว่า เหมาะกับเสียงประชุมที่ชัดเจน', technical: 'Whisper Small · ดาวน์โหลดประมาณ 650 MB', badge: 'แนะนำ' },
  { id: 'large-v3-turbo', name: 'แบบแม่นยำขึ้น', detail: 'เหมาะกับเสียงเบา เสียงรบกวน หรือผู้พูดหลายคน แต่อาจใช้เวลานานกว่า', technical: 'Whisper Large V3 Turbo · ดาวน์โหลดประมาณ 2.0 GB' },
]

const PROVIDER_LABELS: Record<string, string> = {
  auto: 'เลือกบริการที่พร้อมให้อัตโนมัติ', groq: 'Groq', deepgram: 'Deepgram', assemblyai: 'AssemblyAI',
  cloudflare: 'Cloudflare Workers AI', azure: 'Microsoft Azure Speech', google: 'Google Speech-to-Text', gemini: 'Google Gemini',
}

const demoReport: MeetingReport = {
  title: 'ประชุมวางแผนเปิดตัวผลิตภัณฑ์ Q4', date: '21 สิงหาคม 2569',
  overview: 'ทีมเห็นชอบกำหนดการเปิดตัวในสัปดาห์ที่สองของเดือนตุลาคม โดยให้ความสำคัญกับการทดสอบระบบชำระเงินและการเตรียมสื่อภาษาไทยก่อนเริ่มแคมเปญ',
  topics: [
    { title: 'กำหนดการเปิดตัว', detail: 'เลื่อน soft launch ขึ้นหนึ่งสัปดาห์เพื่อเก็บข้อเสนอแนะจากกลุ่มทดลองก่อนเปิดตัวจริง' },
    { title: 'ความพร้อมด้านการตลาด', detail: 'คอนเทนต์หลักเสร็จแล้ว 70% และอยู่ระหว่างตรวจทานข้อความภาษาไทย' },
  ],
  decisions: ['เปิดตัวจริงในวันที่ 12 ตุลาคม', 'ใช้กลุ่มลูกค้าเดิม 200 คนสำหรับ soft launch'],
  actions: [
    { task: 'สรุป test cases ระบบชำระเงิน', owner: 'คุณนัท', due: '28 ส.ค.' },
    { task: 'ส่งข้อความแคมเปญรอบสุดท้าย', owner: 'ทีมการตลาด', due: '2 ก.ย.' },
  ],
  risks: ['การรับรอง payment gateway อาจล่าช้ากว่ากำหนด'],
}

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [duration, setDuration] = useState(0)
  const [stage, setStage] = useState<Stage>('idle')
  const [steps, setSteps] = useState<ProgressStep[]>(() => createProgressSteps(DEFAULT_ENGINE))
  const [transcript, setTranscript] = useState<TranscriptResult | null>(null)
  const [report, setReport] = useState<MeetingReport | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'report' | 'transcript'>('report')
  const [dragging, setDragging] = useState(false)
  const [asrModel, setAsrModel] = useState<AsrModelId>('small')
  const [engine, setEngine] = useState<EngineMode>(DEFAULT_ENGINE)
  const [cloudConsent, setCloudConsent] = useState(false)
  const [glossary, setGlossary] = useState('')
  const [speakerLabels, setSpeakerLabels] = useState(false)
  const [transcriptionProvider, setTranscriptionProvider] = useState<CloudTranscriptionProvider>('auto')
  const [reportProvider, setReportProvider] = useState<CloudReportProvider>('auto')
  const [availableTranscriptionProviders, setAvailableTranscriptionProviders] = useState<string[]>(['groq'])
  const [availableReportProviders, setAvailableReportProviders] = useState<string[]>(['groq'])
  const [history, setHistory] = useState<MeetingHistoryItem[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [audioUrl, setAudioUrl] = useState('')
  const workerRef = useRef<Worker | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const audioLimits = getAudioLimits(deviceMemory)

  useEffect(() => {
    void listHistory().then(setHistory).catch(() => undefined)
    if (CLOUD_MODE_ENABLED) {
      void fetch('/api/config').then(async (response) => response.ok ? response.json() : null).then((config: { transcriptionProviders?: string[]; reportProviders?: string[] } | null) => {
        if (config?.transcriptionProviders?.length) setAvailableTranscriptionProviders(config.transcriptionProviders)
        if (config?.reportProviders?.length) setAvailableReportProviders(config.reportProviders)
      }).catch(() => undefined)
    }
    return () => workerRef.current?.terminate()
  }, [])

  useEffect(() => {
    if (!file) { setAudioUrl(''); return }
    const url = URL.createObjectURL(file)
    setAudioUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function updateProgress(event: ProgressEvent) {
    setSteps((current) => current.map((step) => step.id === event.step ? {
      ...step,
      progress: event.progress === undefined ? step.progress : event.progress,
      detail: event.detail ?? step.detail,
      status: event.status ?? 'active',
      loadedBytes: event.loadedBytes ?? step.loadedBytes,
      totalBytes: event.totalBytes ?? step.totalBytes,
    } : step))
  }

  async function chooseFile(selected?: File) {
    if (!selected) return
    const selectionError = validateAudioSelection(selected, audioLimits)
    if (selectionError) { setError(selectionError); setStage('error'); return }
    try {
      const selectedDuration = await readAudioDuration(selected)
      const durationError = validateAudioDuration(selectedDuration, audioLimits)
      if (durationError) { setError(durationError); setStage('error'); return }
      setError(''); setFile(selected); setDuration(selectedDuration); setStage('ready'); setReport(null); setTranscript(null); setCloudConsent(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ไม่สามารถอ่านข้อมูลไฟล์เสียงนี้ได้')
      setStage('error')
    }
  }

  async function processMeeting() {
    if (!file) return
    if (engine === 'cloud' && !cloudConsent) {
      setError('กรุณายืนยันก่อนว่าสามารถส่งเสียงและบทถอดเสียงไปประมวลผลออนไลน์ได้')
      setStage('error'); return
    }
    if (engine === 'local' && !('gpu' in navigator)) {
      setError(CLOUD_MODE_ENABLED
        ? 'เบราว์เซอร์นี้ยังไม่รองรับ WebGPU กรุณาใช้ Chrome หรือ Edge เวอร์ชันล่าสุด หรือสลับไปโหมดคลาวด์'
        : 'เบราว์เซอร์นี้ยังไม่รองรับ WebGPU กรุณาใช้ Chrome หรือ Edge เวอร์ชันล่าสุดและเปิด Hardware acceleration')
      setStage('error'); return
    }
    try {
      setStage('processing'); setSteps(createProgressSteps(engine, transcript ? 'transcription' : undefined)); setError('')
      let result = transcript
      if (!result) {
        updateProgress({ step: 'audio', progress: null, status: 'active', detail: 'กำลังถอดรหัสและแปลงเสียงเป็น 16 kHz…' })
        const { samples } = await decodeAudio(file)
        updateProgress({ step: 'audio', progress: 100, status: 'done', detail: 'เตรียมไฟล์เสียงเรียบร้อย' })
        if (engine === 'cloud') {
          const draftId = fileDraftId(file, `${transcriptionProvider}:${speakerLabels}`)
          const draft = await loadDraft(draftId).catch(() => undefined)
          result = await transcribeRemote(samples, updateProgress, {
            provider: transcriptionProvider,
            glossary,
            diarization: speakerLabels,
            resumeChunks: draft?.completed,
            onPartial: (index, chunks) => { void saveDraft(draftId, index, chunks).catch(() => undefined) },
          })
          await deleteDraft(draftId).catch(() => undefined)
        } else {
          const worker = new Worker(new URL('./workers/asr.worker.ts', import.meta.url), { type: 'module' })
          workerRef.current = worker
          try {
            result = await new Promise<TranscriptResult>((resolve, reject) => {
              worker.onmessage = ({ data }) => {
                if (data.type === 'progress') updateProgress(data as ProgressEvent & { type: 'progress' })
                if (data.type === 'complete') resolve(data.result)
                if (data.type === 'error') reject(new Error(data.message))
              }
              worker.onerror = (event) => reject(new Error(event.message))
              worker.postMessage({ type: 'transcribe', audio: samples, model: asrModel }, [samples.buffer])
            })
          } finally {
            worker.terminate()
            if (workerRef.current === worker) workerRef.current = null
          }
        }
        setTranscript(result)
      }
      const generated = engine === 'cloud'
        ? await generateReportRemote(result.text, updateProgress, { provider: reportProvider, glossary })
        : await generateReport(result.text, updateProgress)
      setReport(generated); setStage('done'); setTab('report')
      const item: MeetingHistoryItem = {
        id: crypto.randomUUID(), createdAt: new Date().toISOString(), fileName: file.name, duration, engine,
        transcript: result, report: generated,
      }
      await saveHistory(item).then(() => setHistory((current) => [item, ...current].slice(0, 30))).catch(() => undefined)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'เกิดข้อผิดพลาดในการประมวลผล'
      setError(message)
      setSteps((current) => current.map((step) => step.status === 'active' ? { ...step, status: 'error', detail: message } : step))
      setStage('error')
    }
  }

  function reset() {
    workerRef.current?.terminate(); workerRef.current = null
    setFile(null); setDuration(0); setStage('idle'); setSteps(createProgressSteps(engine)); setTranscript(null); setReport(null); setError(''); setCloudConsent(false)
  }

  function seekAudio(seconds: number) {
    if (!audioRef.current) return
    audioRef.current.currentTime = seconds
    void audioRef.current.play()
  }

  function updateTranscript(next: TranscriptResult) {
    setTranscript(next)
    setReport(null)
    setStage('ready')
    setError('แก้ไขบทถอดเสียงแล้ว กด “สร้างรายงานการประชุม” เพื่อสร้างรายงานใหม่')
  }

  function openHistoryItem(item: MeetingHistoryItem) {
    setTranscript(item.transcript); setReport(item.report); setDuration(item.duration); setStage('done'); setEngine(item.engine); setHistoryOpen(false); setTab('report'); setFile(null); setError('')
  }

  const activeReport = report ?? (stage === 'idle' || stage === 'ready' ? demoReport : null)
  const cloudMode = engine === 'cloud'

  return <div className="app-shell">
    <header>
      <a className="brand" href="#"><span className="brand-mark"><Sparkles size={17}/></span><span>สรุป</span><small>{cloudMode ? 'HYBRID' : 'LOCAL'}</small></a>
      <div className="privacy-pill"><span></span>{cloudMode ? <><Cloud size={14}/> ออนไลน์: ง่ายและรวดเร็ว</> : <><LockKeyhole size={14}/> ส่วนตัว: ข้อมูลอยู่ในเครื่อง</>}</div>
      <button className="about history-button" onClick={() => setHistoryOpen(true)}><HistoryIcon size={15}/> ประวัติในเครื่อง</button>
    </header>

    {historyOpen && <div className="history-overlay" role="dialog" aria-modal="true" aria-label="ประวัติรายงาน">
      <div className="history-dialog">
        <div className="history-heading"><div><h2>รายงานที่เก็บไว้ในเครื่อง</h2><p>ข้อมูลนี้อยู่ในเบราว์เซอร์นี้เท่านั้น</p></div><button onClick={() => setHistoryOpen(false)} aria-label="ปิด"><X/></button></div>
        {history.length ? <div className="history-list">{history.map((item) => <div key={item.id}>
          <button className="history-open" onClick={() => openHistoryItem(item)}><strong>{item.report.title || item.fileName}</strong><span>{new Date(item.createdAt).toLocaleString('th-TH')} · {formatDuration(item.duration)}</span></button>
          <button className="history-delete" aria-label={`ลบ ${item.report.title}`} onClick={() => { void deleteHistory(item.id).then(() => setHistory((current) => current.filter((value) => value.id !== item.id))) }}><Trash2 size={17}/></button>
        </div>)}</div> : <div className="history-empty">ยังไม่มีรายงานที่บันทึกไว้</div>}
      </div>
    </div>}

    <main>
      <section className="hero">
        <div className="eyebrow"><ShieldCheck size={15}/> ผู้ช่วยสรุปการประชุมภาษาไทย</div>
        <h1>เปลี่ยนเสียงประชุม<br/>เป็น<span>ความชัดเจน</span></h1>
        <p>เลือกไฟล์เสียง แล้วระบบจะถอดคำพูดและจัดทำรายงานให้อ่านง่าย{' '}<br/>{cloudMode ? 'โหมดออนไลน์ใช้งานง่าย รวดเร็ว และเหมาะสำหรับการใช้งานทั่วไป' : 'โหมดส่วนตัวเก็บทุกอย่างไว้ในอุปกรณ์ของคุณ'}</p>
        <div className="trust-row">{cloudMode
          ? <><span><Check/>ใช้งานฟรี</span><span><Check/>เริ่มได้ทันที</span><span><Check/>เปลี่ยนเป็นโหมดส่วนตัวได้</span></>
          : <><span><Check/>ไม่อัปโหลดไฟล์</span><span><Check/>ไม่ต้องสมัครสมาชิก</span><span><Check/>ใช้งานได้ฟรี</span></>}</div>
      </section>

      <section className="workspace">
        <div className="panel upload-panel">
          <div className="panel-heading"><div><span className="step">01</span><div><h2>ไฟล์การประชุม</h2><p>เลือกไฟล์เสียงภาษาไทย</p></div></div>{file && <button className="icon-button" disabled={stage === 'processing'} onClick={reset} aria-label="เริ่มใหม่"><RotateCcw size={17}/></button>}</div>

          {!file ? <div className={`dropzone ${dragging ? 'dragging' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); void chooseFile(e.dataTransfer.files[0]) }} onClick={() => inputRef.current?.click()}>
            <input ref={inputRef} type="file" accept="audio/*,.m4a" hidden onChange={e => void chooseFile(e.target.files?.[0])}/>
            <div className="upload-icon"><Upload size={27}/><span className="pulse-ring"></span></div>
            <h3>เลือกไฟล์เสียงการประชุม</h3><p>แตะที่นี่เพื่อ<span> เลือกไฟล์จากเครื่อง</span> หรือวางไฟล์ในช่องนี้</p>
            <small>MP3, M4A, WAV, OGG · สูงสุด {Math.round(audioLimits.maxBytes / 1024 / 1024)} MB / {Math.round(audioLimits.maxDurationSeconds / 60)} นาที</small>
          </div> : <div className="file-card">
            <div className="audio-icon"><FileAudio size={23}/></div><div className="file-meta"><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(1)} MB · {duration ? formatDuration(duration) : 'ไฟล์เสียง'}</span></div>
            <button disabled={stage === 'processing'} onClick={reset} aria-label="นำไฟล์ออก"><X size={17}/></button>
            <div className="waveform">{Array.from({length: 34}).map((_,i)=><i key={i} style={{height: `${18 + ((i * 13) % 28)}%`}}/>)}</div>
            {audioUrl && <audio ref={audioRef} className="audio-player" controls preload="metadata" src={audioUrl}/>} 
          </div>}

          {file && <div className="meeting-hints">
            <label htmlFor="glossary"><strong>ชื่อคนและคำเฉพาะ <span>(ถ้ามี)</span></strong><small>ช่วยให้ระบบสะกดชื่อบริษัท โครงการ หรือคำศัพท์เฉพาะได้ถูกต้องขึ้น</small></label>
            <textarea id="glossary" value={glossary} disabled={stage === 'processing' || stage === 'done'} onChange={(event) => setGlossary(event.target.value)} maxLength={1000} placeholder="เช่น คุณศิริพร, โครงการสรุป, Intec"/>
          </div>}

          {file && <div className="model-selector" role="radiogroup" aria-label="เลือกวิธีประมวลผล">
            <div className="model-selector-heading"><strong>เลือกวิธีใช้งาน</strong><span>หากไม่แน่ใจ ให้เลือกตัวที่แนะนำ</span></div>
            <div className="model-options">{ENGINE_OPTIONS.map((option) => <label className={engine === option.id ? 'selected' : ''} key={option.id}>
              <input
                type="radio"
                name="engine-mode"
                value={option.id}
                checked={engine === option.id}
                disabled={stage === 'processing' || stage === 'done'}
                onChange={() => { setEngine(option.id); setTranscript(null); setReport(null); setError(''); setCloudConsent(false); setSteps(createProgressSteps(option.id)) }}
              />
              <span className="model-radio"></span>
              <span className="model-copy"><strong>{option.name}</strong><span className="option-explanation">{option.detail}</span><small>{option.technical}</small></span>
              <em>{option.badge}</em>
            </label>)}</div>
          </div>}

          {file && engine === 'local' && <div className="model-selector" role="radiogroup" aria-label="เลือกโมเดลถอดเสียง">
            <div className="model-selector-heading"><strong>เลือกระดับการถอดเสียง</strong><span>ทั้งสองแบบเก็บข้อมูลไว้ในเครื่อง</span></div>
            <div className="model-options">{ASR_MODELS.map((model) => <label className={asrModel === model.id ? 'selected' : ''} key={model.id}>
              <input
                type="radio"
                name="asr-model"
                value={model.id}
                checked={asrModel === model.id}
                disabled={stage === 'processing' || stage === 'done'}
                onChange={() => { setAsrModel(model.id); setTranscript(null); setReport(null) }}
              />
              <span className="model-radio"></span>
              <span className="model-copy"><strong>{model.name}</strong><span className="option-explanation">{model.detail}</span><small>{model.technical}</small></span>
              {model.badge && <em>{model.badge}</em>}
            </label>)}</div>
          </div>}

          {file && engine === 'cloud' && <label className="cloud-consent">
            <input
              type="checkbox"
              checked={cloudConsent}
              disabled={stage === 'processing' || stage === 'done'}
              onChange={(event) => { setCloudConsent(event.target.checked); setError('') }}
            />
            <span><strong>ฉันยอมรับให้ส่งไฟล์เสียงไปประมวลผลออนไลน์</strong><span className="consent-explanation">ไฟล์เสียงและข้อความจะออกจากอุปกรณ์สำหรับงานนี้ และอาจส่งต่อไปยังบริการสำรองที่ผู้ดูแลตั้งค่าไว้</span><small>บริการที่พร้อม: {availableTranscriptionProviders.map((name) => PROVIDER_LABELS[name] ?? name).join(', ')} · สรุป: {availableReportProviders.map((name) => PROVIDER_LABELS[name] ?? name).join(', ')}{availableReportProviders.includes('gemini') ? ' · Gemini แบบฟรีอาจนำข้อมูลไปปรับปรุงบริการ' : ''}</small></span>
          </label>}

          {file && engine === 'cloud' && <details className="advanced-settings">
            <summary>ตัวเลือกเพิ่มเติม</summary>
            <label className="speaker-option"><input type="checkbox" checked={speakerLabels} disabled={stage === 'processing' || stage === 'done'} onChange={(event) => { setSpeakerLabels(event.target.checked); setTranscript(null); setReport(null) }}/><span><strong>ลองแยกผู้พูด</strong><small>ระบบจะพยายามใส่ “ผู้พูด 1, 2…” เมื่อบริการรองรับ</small></span></label>
            <div className="provider-grid">
              <label>บริการถอดเสียง<select value={transcriptionProvider} disabled={stage === 'processing' || stage === 'done'} onChange={(event) => { setTranscriptionProvider(event.target.value as CloudTranscriptionProvider); setTranscript(null); setReport(null) }}><option value="auto">อัตโนมัติ (แนะนำ)</option>{availableTranscriptionProviders.map((name) => <option value={name} key={name}>{PROVIDER_LABELS[name] ?? name}</option>)}</select></label>
              <label>บริการทำรายงาน<select value={reportProvider} disabled={stage === 'processing' || stage === 'done'} onChange={(event) => setReportProvider(event.target.value as CloudReportProvider)}><option value="auto">อัตโนมัติ (แนะนำ)</option>{availableReportProviders.map((name) => <option value={name} key={name}>{PROVIDER_LABELS[name] ?? name}</option>)}</select></label>
            </div>
          </details>}

          {file && (stage === 'processing' || stage === 'done' || (stage === 'error' && steps.some((step) => step.status === 'error'))) && <ProcessingProgress steps={steps}/>} 
          {error && <div className="error-box">{error}</div>}
          <button className="primary-button" disabled={!file || stage === 'processing' || stage === 'done' || (engine === 'cloud' && !cloudConsent)} onClick={processMeeting}><WandSparkles size={18}/>{stage === 'processing' ? 'กำลังประมวลผล…' : transcript && !report ? 'ลองสร้างรายงานอีกครั้ง' : stage === 'done' ? 'สร้างรายงานเรียบร้อย' : 'สร้างรายงานการประชุม'}<ChevronRight size={18}/></button>
          <div className="local-note">{cloudMode
            ? <><Cloud size={18}/><div><strong>โหมดออนไลน์คืออะไร?</strong><span>ระบบส่งไฟล์ไปช่วยประมวลผล แล้วส่งบทถอดเสียงและรายงานกลับมาให้คุณ หากบริการหนึ่งไม่พร้อม ระบบลองบริการสำรองให้ได้</span><small>Configured cloud providers · automatic fallback · Gemini optional</small></div></>
            : <><LockKeyhole size={18}/><div><strong>โหมดส่วนตัวคืออะไร?</strong><span>ระบบทำงานในเบราว์เซอร์นี้ ไฟล์เสียงและเนื้อหาไม่ถูกส่งออกไปที่อื่น</span><small>Offline · Whisper · Gemma · WebGPU</small></div></>}</div>
        </div>

        <div className="panel report-panel">
          <div className="panel-heading report-heading"><div><span className="step">02</span><div><h2>รายงานการประชุม</h2><p>{stage === 'done' ? 'พร้อมใช้งานแล้ว' : 'ตัวอย่างรูปแบบรายงาน'}</p></div></div>{report && <div className="export-actions"><button onClick={() => void downloadWord(report)} title="Microsoft Word"><FileDown size={16}/> Word</button><button onClick={() => window.print()} title="พิมพ์หรือบันทึก PDF"><Printer size={16}/> PDF</button><button onClick={() => downloadMarkdown(report)} title="ไฟล์ข้อความ Markdown"><ArrowDownToLine size={16}/><span>ข้อความ</span></button></div>}</div>
          <div className="tabs"><button className={tab==='report'?'active':''} onClick={()=>setTab('report')}><FileText size={15}/> รายงาน</button><button className={tab==='transcript'?'active':''} onClick={()=>setTab('transcript')}><Users size={15}/> บทถอดเสียง</button></div>
          {tab === 'report' ? activeReport ? <ReportView report={activeReport} muted={!report}/> : <EmptyReport stage={stage}/> : <TranscriptView transcript={transcript} onChange={file ? updateTranscript : undefined} onSeek={audioUrl ? seekAudio : undefined}/>} 
        </div>
      </section>

      <div className="engine-note">{cloudMode
        ? <><span>ONLINE SERVICES</span><b>automatic fallback</b><i></i><b>speech-to-text</b><i></i><b>Groq / Gemini reports</b></>
        : <><span>POWERED LOCALLY BY</span><b>Gemma 4 E2B</b><i></i><b>LiteRT-LM</b><i></i><b>WebGPU</b></>}</div>
    </main>
    <footer><span>สรุป · Local-first meeting intelligence</span><span>{cloudMode ? 'โหมดออนไลน์มีบริการสำรอง · สลับเป็นโหมดส่วนตัวได้ทุกเมื่อ' : 'ไม่มีเซิร์ฟเวอร์ · ไม่มีการติดตาม · ไม่มีข้อมูลรั่วไหล'}</span></footer>
  </div>
}

function ProcessingProgress({ steps }: { steps: ProgressStep[] }) {
  const overall = calculateOverallProgress(steps)
  return <div className="progress-block" aria-live="polite">
    <div className="progress-overall">
      <div className="progress-label"><span>ความคืบหน้าทั้งหมด</span><b>{Math.round(overall)}%</b></div>
      <div className="progress-track main"><i style={{ width: `${overall}%` }}/></div>
    </div>
    <div className="progress-steps">
      {steps.map((step) => {
        const byteDetail = step.loadedBytes !== undefined
          ? `${formatBytes(step.loadedBytes)}${step.totalBytes ? ` / ${formatBytes(step.totalBytes)}` : ''}`
          : ''
        return <div className={`progress-step ${step.status}`} key={step.id}>
          <span className="progress-state" aria-hidden="true">{step.status === 'done' ? '✓' : step.status === 'error' ? '!' : ''}</span>
          <div className="progress-step-content">
            <div className="progress-step-heading">
              <strong>{step.label}</strong>
              {step.progress !== null && step.status !== 'pending' && <b>{Math.round(step.progress)}%</b>}
            </div>
            <div className={`progress-track step-track ${step.progress === null && step.status === 'active' ? 'indeterminate' : ''}`}>
              <i style={step.progress === null ? undefined : { width: `${step.progress}%` }}/>
            </div>
            <div className="progress-detail"><span>{step.detail}</span>{byteDetail && <em>{byteDetail}</em>}</div>
          </div>
        </div>
      })}
    </div>
    <small>เก็บแท็บนี้ไว้ระหว่างประมวลผล · การดาวน์โหลดครั้งถัดไปจะใช้แคชในเครื่อง</small>
  </div>
}

function EmptyReport({stage}:{stage:Stage}) {
  return <div className="empty-report"><div><Sparkles size={26}/></div><h3>{stage === 'processing' ? 'กำลังสร้างรายงาน…' : 'รายงานจะแสดงที่นี่'}</h3><p>เมื่อประมวลผลเสร็จ คุณจะได้สรุป<br/>มติ และรายการงานอย่างเป็นระบบ</p></div>
}

function ReportView({report, muted}:{report:MeetingReport; muted:boolean}) {
  return <article className={`report-content ${muted ? 'sample' : ''}`}>
    {muted && <div className="sample-badge">ตัวอย่างรายงาน</div>}
    <div className="report-title"><span>รายงานการประชุม</span><h2>{report.title}</h2><div><Clock3 size={14}/>{report.date}</div></div>
    <section><label>สรุปภาพรวม</label><p className="overview">{report.overview}</p></section>
    <section><label>ประเด็นสำคัญ</label>{report.topics.map((x,i)=><div className="topic" key={i}><b>{String(i+1).padStart(2,'0')}</b><div><h4>{x.title}</h4><p>{x.detail}</p></div></div>)}</section>
    <section><label>มติที่ประชุม</label><div className="decision-box">{report.decisions.map((x,i)=><p key={i}><CheckCircle2 size={17}/>{x}</p>)}</div></section>
    <section><label>งานที่ต้องดำเนินการ</label><div className="action-table">{report.actions.map((x,i)=><div key={i}><span className="checkbox"></span><strong>{x.task}</strong><em>{x.owner}</em><time>{x.due}</time></div>)}</div></section>
    {report.risks.length > 0 && <section><label>ประเด็นติดตาม</label>{report.risks.map((x,i)=><p className="risk" key={i}>{x}</p>)}</section>}
  </article>
}

function TranscriptView({ transcript, onChange, onSeek }: { transcript: TranscriptResult | null; onChange?: (value: TranscriptResult) => void; onSeek?: (seconds: number) => void }) {
  const [working, setWorking] = useState<TranscriptResult | null>(transcript)
  useEffect(() => setWorking(transcript), [transcript])
  if (!transcript) return <div className="empty-report"><div><Users size={25}/></div><h3>ยังไม่มีบทถอดเสียง</h3><p>เลือกไฟล์และสร้างรายงาน<br/>เพื่อดูบทถอดเสียงพร้อมเวลา</p></div>
  if (!working) return null
  const save = () => onChange?.({ ...working, text: working.chunks?.length ? transcriptText(working.chunks) : working.text.trim() })
  return <div className="transcript-editor">
    <div className="transcript-help"><div><strong>{onChange ? 'ตรวจและแก้ไขก่อนทำรายงาน' : 'บทถอดเสียงที่บันทึกไว้'}</strong><span>{onChange ? 'แตะเวลาเพื่อฟังเสียงจากจุดนั้น แล้วแก้คำที่สะกดผิดได้' : 'เลือกไฟล์เสียงเดิมอีกครั้งหากต้องการฟังหรือแก้ไข'}</span></div>{working.provider && <small>{PROVIDER_LABELS[working.provider] ?? working.provider}</small>}</div>
    <div className="transcript-content">{working.chunks?.length ? working.chunks.map((chunk, index) => <div key={index}>
      <button className="timestamp-button" onClick={() => onSeek?.(chunk.timestamp[0])} disabled={!onSeek}><Play size={12}/>{formatDuration(chunk.timestamp[0])}</button>
      <div>{chunk.speaker && <b className="speaker-label">{chunk.speaker}</b>}<textarea aria-label={`ข้อความช่วง ${formatDuration(chunk.timestamp[0])}`} value={chunk.text} readOnly={!onChange} onChange={(event) => setWorking({ ...working, chunks: working.chunks?.map((value, valueIndex) => valueIndex === index ? { ...value, text: event.target.value } : value) })}/></div>
    </div>) : <textarea className="plain-transcript" value={working.text} readOnly={!onChange} onChange={(event) => setWorking({ ...working, text: event.target.value })}/>}</div>
    {onChange && <button className="save-transcript" onClick={save}>บันทึกข้อความที่แก้ไข และสร้างรายงานใหม่</button>}
  </div>
}
