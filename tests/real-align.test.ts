// Script-timing accuracy on a real track — off unless ENV_REAL=1.
// Reference: the script aligned to large-v3-turbo word times (Vulkan); checked:
// the subtitles Env made (tiny-based) — share of lines starting within ±0.5 s.
//   ENV_REAL=1 ENV_REAL_MP3="…/track.mp3" ENV_REAL_VTT="…/track.ja.vtt" node scripts/test.mjs tests/real-align.test.ts
import { promises as fsp } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ASR_RATE, resample, toPcm16 } from '../src/core/asr/audio'
import { WhisperCppAsr, modelPath } from '../src/core/asr/engines'
import { chunkAudio, detectSpeech, planChunks, toTrackTime } from '../src/core/asr/vad'
import type { AsrSegment } from '../src/core/asr/clean'
import { alignJapanese } from '../src/core/script/align'
import { parseSubtitle } from '../src/core/subtitle'

const on = !!process.env.ENV_REAL && !!process.env.ENV_REAL_MP3
const engines = join(__dirname, '..', '.build', 'engines')
const models = join(__dirname, '..', '.build', 'models')

async function decodeMp3(path: string): Promise<Int16Array> {
  const { MPEGDecoder } = await import('mpg123-decoder')
  const dec = new MPEGDecoder()
  await dec.ready
  const r = dec.decode(new Uint8Array(await fsp.readFile(path)))
  dec.free()
  const ch = r.channelData
  const mono = new Float32Array(ch[0].length)
  for (let i = 0; i < mono.length; i++) mono[i] = ch.reduce((n, c) => n + c[i], 0) / ch.length
  return toPcm16(resample(mono, r.sampleRate, ASR_RATE))
}

describe.skipIf(!on)('script timing accuracy', () => {
  it('compares Env subtitles with a large-model reference', async () => {
    const made = parseSubtitle(await fsp.readFile(process.env.ENV_REAL_VTT!, 'utf8'), '.vtt')
    const lines = made.map((c) => c.text)
    const pcm = await decodeMp3(process.env.ENV_REAL_MP3!)
    const eng = new WhisperCppAsr(engines, modelPath(models, 'large-v3-turbo-q5_0'), 'auto')
    const segs: AsrSegment[] = []
    for (const c of planChunks(detectSpeech(pcm), 600)) {
      for (const s of await eng.transcribe(chunkAudio(pcm, c), { language: 'ja', words: true }))
        segs.push({ ...s, start: toTrackTime(c, s.start), end: toTrackTime(c, s.end), words: s.words?.map((w) => ({ ...w, start: toTrackTime(c, w.start), end: toTrackTime(c, w.end) })) })
    }
    const ref = alignJapanese(lines, segs, pcm.length / ASR_RATE)
    const diffs = made.map((c, i) => Math.abs(c.start - ref[i].start))
    const within = diffs.filter((d) => d <= 0.5).length / diffs.length
    const sorted = [...diffs].sort((a, b) => a - b)
    console.log(
      `lines ${lines.length}, within ±0.5 s: ${(within * 100).toFixed(1)}%, median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} s, ` +
        `unsure (Env) ${made.filter((c) => c.low).length}, reference confident ${ref.filter((r) => r.conf >= 0.5).length}`
    )
    expect(lines.length).toBeGreaterThan(0)
  }, 3600_000)
})
