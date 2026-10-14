// Real engines on a real track — off unless ENV_REAL=1 (needs network, the
// whisper builds in .build/engines and a sample wav). Reads the track only.
//   ENV_REAL=1 ENV_REAL_WAV="E:/…/track.wav" [GROQ_API_KEY=…] node scripts/test.mjs tests/real.test.ts
import { existsSync, mkdirSync, promises as fsp } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { pcm16FromWav, ASR_RATE } from '../src/core/asr/audio'
import { GroqAsr, WhisperCppAsr, modelPath, whisperBinary } from '../src/core/asr/engines'
import type { WhisperModel } from '../src/core/asr/engines'
import { installCpuEngine, installModel } from '../src/core/asr/install'
import { cleanSegments, toCues } from '../src/core/asr/clean'
import { chunkAudio, detectSpeech, planChunks, toTrackTime } from '../src/core/asr/vad'

const on = !!process.env.ENV_REAL
const engines = join(__dirname, '..', '.build', 'engines')
const models = join(__dirname, '..', '.build', 'models')

async function ensure(): Promise<void> {
  mkdirSync(models, { recursive: true })
  if (!whisperBinary(engines, 'cpu')) await installCpuEngine(engines, fetch, () => {})
  for (const m of (process.env.ENV_REAL_MODELS ?? 'large-v3-turbo-q5_0').split(',') as WhisperModel[])
    if (!existsSync(modelPath(models, m))) await installModel(models, m, fetch, () => {})
}

describe.skipIf(!on)('real engines', () => {
  it(
    'transcribes a sample track with whisper.cpp Vulkan / CPU (and Groq with a key)',
    async () => {
      await ensure()
      const pcm = pcm16FromWav(await fsp.readFile(process.env.ENV_REAL_WAV!))
      const audioS = pcm.length / ASR_RATE
      const chunks = planChunks(detectSpeech(pcm), 600)
      const model = modelPath(models, (process.env.ENV_REAL_MODELS ?? 'large-v3-turbo-q5_0').split(',')[0] as WhisperModel)
      const report: string[] = [`audio ${audioS.toFixed(1)} s, speech chunks ${chunks.length}`]
      const run = async (name: string, eng: { transcribe: WhisperCppAsr['transcribe'] }): Promise<void> => {
        const t0 = Date.now()
        const segs = []
        for (const c of chunks) {
          for (const s of await eng.transcribe(chunkAudio(pcm, c), { language: 'ja' }))
            segs.push({ ...s, start: toTrackTime(c, s.start), end: toTrackTime(c, s.end) })
        }
        const sec = (Date.now() - t0) / 1000
        const cues = toCues(cleanSegments(segs))
        report.push(`${name}: ${sec.toFixed(1)} s (${(audioS / sec).toFixed(1)}× realtime), ${cues.length} cues`)
        report.push(...cues.slice(0, 6).map((c) => `   ${c.start.toFixed(1)}–${c.end.toFixed(1)} ${c.text}`))
        expect(cues.length).toBeGreaterThan(0)
      }
      if (whisperBinary(engines, 'vulkan')) await run('vulkan', new WhisperCppAsr(engines, model, 'auto'))
      await run('cpu', new WhisperCppAsr(engines, model, 'cpu'))
      if (process.env.GROQ_API_KEY) await run('groq', new GroqAsr(process.env.GROQ_API_KEY))
      console.log(report.join('\n'))
    },
    60 * 60 * 1000
  )
})
