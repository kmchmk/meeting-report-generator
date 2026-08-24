import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Check, CheckCircle2, ChevronRight, Clock3, Cloud, FileAudio, FileText, LockKeyhole, RotateCcw, ShieldCheck, Sparkles, Upload, Users, WandSparkles, X } from 'lucide-react'
import { decodeAudio, formatDuration, getAudioLimits, readAudioDuration, validateAudioDuration, validateAudioSelection } from './lib/audio'
import { generateReport } from './lib/gemma'
import { generateReportRemote, transcribeRemote } from './lib/groq'
import type { MeetingReport } from '../api/_lib/report-core'
import { calculateOverallProgress, createProgressSteps, formatBytes, type EngineMode, type ProgressEvent, type ProgressStep } from './progress'
import type { AsrModelId, TranscriptResult } from './types'

type Stage = 'idle' | 'ready' | 'processing' | 'done' | 'error'

const CLOUD_MODE_ENABLED = import.meta.env.VITE_ENABLE_CLOUD_MODE === 'true'
const DEFAULT_ENGINE: EngineMode = CLOUD_MODE_ENABLED ? 'cloud' : 'local'
const ENGINE_OPTIONS: Array<{ id: EngineMode; name: string; detail: string; technical: string; badge: string }> = [
  ...(CLOUD_MODE_ENABLED ? [{
    id: 'cloud' as const,
    name: 'ใช้งานออนไลน์ — ง่ายและรวดเร็ว',
    detail: 'ระบบจะช่วยถอดเสียงและทำรายงานให้ เหมาะสำหรับการใช้งานทั่วไป ไม่ต้องดาวน์โหลดไฟล์ขนาดใหญ่',
    technical: 'Groq Cloud · Whisper Large V3 · GPT-OSS 120B',
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
  const workerRef = useRef<Worker | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const audioLimits = getAudioLimits(deviceMemory)

  useEffect(() => () => workerRef.current?.terminate(), [])

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
      setError('กรุณายืนยันก่อนว่าสามารถส่งเสียงและบทถอดเสียงไปประมวลผลที่ Groq ได้')
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
          result = await transcribeRemote(samples, updateProgress)
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
        ? await generateReportRemote(result.text, updateProgress)
        : await generateReport(result.text, updateProgress)
      setReport(generated); setStage('done')
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

  function download() {
    if (!report) return
    const lines = [`# ${report.title}`, '', `วันที่: ${report.date}`, '', '## สรุปภาพรวม', report.overview, '', '## ประเด็นสำคัญ', ...report.topics.map(x => `### ${x.title}\n${x.detail}`), '', '## มติที่ประชุม', ...report.decisions.map(x => `- ${x}`), '', '## งานที่ต้องดำเนินการ', ...report.actions.map(x => `- ${x.task} — ${x.owner} (${x.due})`), '', '## ประเด็นติดตาม', ...report.risks.map(x => `- ${x}`)]
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = 'meeting-report.md'; a.click(); URL.revokeObjectURL(url)
  }

  const activeReport = report ?? (stage === 'idle' ? demoReport : null)
  const cloudMode = engine === 'cloud'

  return <div className="app-shell">
    <header>
      <a className="brand" href="#"><span className="brand-mark"><Sparkles size={17}/></span><span>สรุป</span><small>{cloudMode ? 'HYBRID' : 'LOCAL'}</small></a>
      <div className="privacy-pill"><span></span>{cloudMode ? <><Cloud size={14}/> ออนไลน์: ง่ายและรวดเร็ว</> : <><LockKeyhole size={14}/> ส่วนตัว: ข้อมูลอยู่ในเครื่อง</>}</div>
      <button className="about">ทำงานอย่างไร <ChevronRight size={15}/></button>
    </header>

    <main>
      <section className="hero">
        <div className="eyebrow"><ShieldCheck size={15}/> ผู้ช่วยสรุปการประชุมภาษาไทย</div>
        <h1>เปลี่ยนเสียงประชุม<br/>เป็น<span>ความชัดเจน</span></h1>
        <p>เลือกไฟล์เสียง แล้วระบบจะถอดคำพูดและจัดทำรายงานให้อ่านง่าย<br/>{cloudMode ? 'โหมดออนไลน์ใช้งานง่าย รวดเร็ว และเหมาะสำหรับการใช้งานทั่วไป' : 'โหมดส่วนตัวเก็บทุกอย่างไว้ในอุปกรณ์ของคุณ'}</p>
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
            <span><strong>ฉันยอมรับให้ส่งไฟล์เสียงไปประมวลผลออนไลน์</strong><span className="consent-explanation">ไฟล์เสียงและข้อความจะออกจากอุปกรณ์สำหรับงานนี้</span><small>ผู้ให้บริการ: Groq · ระยะเวลาเสียงประมาณ {Math.max(1, Math.ceil(duration / 60))} นาที</small></span>
          </label>}

          {(stage === 'processing' || stage === 'done' || (stage === 'error' && steps.some((step) => step.status === 'error'))) && <ProcessingProgress steps={steps}/>} 
          {error && <div className="error-box">{error}</div>}
          <button className="primary-button" disabled={!file || stage === 'processing' || stage === 'done' || (engine === 'cloud' && !cloudConsent)} onClick={processMeeting}><WandSparkles size={18}/>{stage === 'processing' ? 'กำลังประมวลผล…' : transcript && !report ? 'ลองสร้างรายงานอีกครั้ง' : stage === 'done' ? 'สร้างรายงานเรียบร้อย' : 'สร้างรายงานการประชุม'}<ChevronRight size={18}/></button>
          <div className="local-note">{cloudMode
            ? <><Cloud size={18}/><div><strong>โหมดออนไลน์คืออะไร?</strong><span>ระบบส่งไฟล์ไปช่วยประมวลผล แล้วส่งบทถอดเสียงและรายงานกลับมาให้คุณ</span><small>Groq Cloud · Whisper Large V3 · GPT-OSS 120B</small></div></>
            : <><LockKeyhole size={18}/><div><strong>โหมดส่วนตัวคืออะไร?</strong><span>ระบบทำงานในเบราว์เซอร์นี้ ไฟล์เสียงและเนื้อหาไม่ถูกส่งออกไปที่อื่น</span><small>Offline · Whisper · Gemma · WebGPU</small></div></>}</div>
        </div>

        <div className="panel report-panel">
          <div className="panel-heading"><div><span className="step">02</span><div><h2>รายงานการประชุม</h2><p>{stage === 'done' ? 'พร้อมใช้งานแล้ว' : 'ตัวอย่างรูปแบบรายงาน'}</p></div></div>{report && <button className="download-button" onClick={download}><ArrowDownToLine size={16}/> ดาวน์โหลด</button>}</div>
          <div className="tabs"><button className={tab==='report'?'active':''} onClick={()=>setTab('report')}><FileText size={15}/> รายงาน</button><button className={tab==='transcript'?'active':''} onClick={()=>setTab('transcript')}><Users size={15}/> บทถอดเสียง</button></div>
          {tab === 'report' ? activeReport ? <ReportView report={activeReport} muted={!report}/> : <EmptyReport stage={stage}/> : <TranscriptView transcript={transcript}/>} 
        </div>
      </section>

      <div className="engine-note">{cloudMode
        ? <><span>POWERED BY</span><b>Groq</b><i></i><b>Whisper Large V3</b><i></i><b>GPT-OSS 120B</b></>
        : <><span>POWERED LOCALLY BY</span><b>Gemma 4 E2B</b><i></i><b>LiteRT-LM</b><i></i><b>WebGPU</b></>}</div>
    </main>
    <footer><span>สรุป · Local-first meeting intelligence</span><span>{cloudMode ? 'โหมดคลาวด์ผ่าน Groq · สลับเป็น Offline ได้ทุกเมื่อ' : 'ไม่มีเซิร์ฟเวอร์ · ไม่มีการติดตาม · ไม่มีข้อมูลรั่วไหล'}</span></footer>
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

function TranscriptView({transcript}:{transcript:TranscriptResult|null}) {
  if (!transcript) return <div className="empty-report"><div><Users size={25}/></div><h3>ยังไม่มีบทถอดเสียง</h3><p>เลือกไฟล์และสร้างรายงาน<br/>เพื่อดูบทถอดเสียงพร้อมเวลา</p></div>
  return <div className="transcript-content">{transcript.chunks?.length ? transcript.chunks.map((chunk,i)=><div key={i}><time>{formatDuration(chunk.timestamp[0])}</time><p>{chunk.text}</p></div>) : <p>{transcript.text}</p>}</div>
}
