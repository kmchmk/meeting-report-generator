# สรุป (Saroop Local)

Thai meeting transcription and reporting with a privacy-first offline mode and an easier cloud mode with configuration-gated fallbacks.

## Architecture

- **Engine selector**: local processing is always available; when cloud processing is explicitly enabled at build and runtime, cloud mode is the default for non-technical users.
- **Offline mode**
  - Thai speech-to-text: multilingual Whisper Small (about 590 MB) / Large V3 Turbo (about 1.95 GB) via Transformers.js + WebGPU, isolated in a Web Worker.
  - Report generation: Gemma 4 E2B (about 1.87 GiB) via the early-preview LiteRT-LM Web API. Interrupted downloads resume with byte ranges and successful downloads are committed to browser cache before WebGPU setup.
  - Audio stays on the device. Model weights are downloaded from Hugging Face on first use and cached by the browser.
- **Cloud mode**
  - Audio is decoded locally, converted to mono 16 kHz WAV, divided into 55-second pieces with a 2-second overlap, and silent pieces are skipped. Boundary text is de-duplicated.
  - Speech provider order in automatic mode: Groq → Deepgram → Cloudflare → Azure → Google → AssemblyAI. When speaker labels are requested, Deepgram and AssemblyAI are preferred. Only providers whose server-side environment variables exist are considered.
  - Report provider order: Groq → Gemini. Long transcripts are reduced sequentially before final synthesis, with NDJSON progress events throughout.
  - API keys remain in Vercel functions and never reach the browser. Reports are schema-validated server-side and again on the client.
  - Each selected recording requires explicit upload consent. The consent text lists configured providers and notes the Gemini free-tier data-use consideration.
- **Transcript workflow**
  - Timestamped rows can seek the local audio player. Users can correct transcript text and regenerate the report.
  - A names/terminology glossary is passed as recognition context where supported and as spelling context for report generation.
  - Completed cloud chunks are saved to IndexedDB so a retry can continue after reselecting the same file. Completed reports are stored in local browser history; audio is never stored.
- **Export**
  - Microsoft Word `.docx` is generated entirely in the browser with `docx`.
  - Browser print provides Print / Save as PDF, and Markdown remains available for plain-text workflows.
- Shared reduction/validation logic lives in `api/_lib/report-core.ts` and is used identically by both engines (kept inside `api/` so serverless bundles always include it).
- Long transcripts are reduced sequentially before final report synthesis; output receives one constrained JSON-repair attempt before a recoverable error is shown.
- Audio selection reads metadata only. The file is decoded once when processing starts, mixed to mono at 16 kHz, then either transferred to the transcription worker or chunked for upload.

> Cloud mode sends audio and transcripts to the configured providers. For confidential meetings use offline mode. Free tiers have changing rate limits and privacy terms; verify them before deployment. Protect a public deployment with Vercel Deployment Protection or equivalent authentication and rate limiting so strangers cannot consume quota.

## Development

```bash
npm install
npm run dev
```

Offline mode works directly under `npm run dev`. Use a recent Chrome or Edge build with WebGPU; initial model downloads are large and can take several minutes.

To exercise cloud mode locally you need the Vercel functions:

```bash
npx vercel login
npx vercel link
npx vercel env add GROQ_API_KEY   # primary transcription/report key
npx vercel env add GEMINI_API_KEY # optional report fallback
npx vercel env add ENABLE_CLOUD_MODE       # true (server runtime gate)
npx vercel env add VITE_ENABLE_CLOUD_MODE  # true (build-time UI gate)
npx vercel dev                    # serves the Vite app + api/ routes together
```

Copy `.env.example` for the complete optional-provider list. At least one transcription key and one report key are required for cloud mode. Groq alone covers both. Never commit `.env.local` or real keys.

Speaker labels are best-effort. Cloud recordings are processed in pieces to stay within Vercel request limits, so a provider may not keep the same speaker number across every piece of a long meeting.

## Validation

```bash
npm test
npm run lint
npm run build
```

Automated tests cover audio slicing, silence detection, overlap de-duplication, provider fallback, speaker timestamps, Gemini report fallback, schema validation, retry timing, and progress calculations. The browser pipeline has also been exercised with the local one-minute and full Thai M4A recordings without placing either file in the repository. Accuracy still depends on recording clarity, overlapping speakers, and the selected service.

## Deploy to Vercel

Import the repository into Vercel; offline mode works without any environment variables. For the simplest cloud setup, set `GROQ_API_KEY`, optional `GEMINI_API_KEY`, `ENABLE_CLOUD_MODE=true`, and `VITE_ENABLE_CLOUD_MODE=true`, then redeploy. Add any optional transcription-provider keys from `.env.example`; automatic routing detects them server-side. Cloud endpoints consume account quota, so add authentication or platform-level rate limiting before exposing them publicly. `vercel.json` configures the Vite build, function durations (`api/report.ts` needs up to 300 s — enable Fluid compute on Hobby), and the cross-origin isolation headers needed by browser ML runtimes.
