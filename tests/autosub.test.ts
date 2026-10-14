import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvCore } from '../src/core'
import { ASR_RATE, pcm16FromWav, wavFromPcm16 } from '../src/core/asr/audio'
import { chunkAudio, detectSpeech, planChunks, toTrackTime } from '../src/core/asr/vad'
import { cleanSegments, toCues } from '../src/core/asr/clean'
import { MockAsr } from '../src/core/asr/engines'
import { parseIdAnswer, translateLines } from '../src/core/translate'
import type { Translator } from '../src/core/translate'
import { cleanup, tempDir, tree } from './helpers'

afterEach(cleanup)

// 16 kHz 16-bit mono: quiet noise with tone bursts ("speech") at the given spans.
function speechPcm(seconds: number, spans: [number, number][]): Int16Array {
  const pcm = new Int16Array(seconds * ASR_RATE)
  let seed = 1
  for (let i = 0; i < pcm.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    pcm[i] = ((seed / 0x7fffffff) * 2 - 1) * 30 // floor noise
  }
  for (const [a, b] of spans)
    for (let i = Math.round(a * ASR_RATE); i < b * ASR_RATE; i++) pcm[i] += Math.round(Math.sin((i / ASR_RATE) * 2 * Math.PI * 220) * 8000)
  return pcm
}

describe('voice activity and chunks', () => {
  it('finds speech against the noise floor and maps chunk times back', () => {
    const pcm = speechPcm(30, [
      [2, 5],
      [12, 14],
      [25, 27]
    ])
    const spans = detectSpeech(pcm)
    expect(spans).toHaveLength(3)
    expect(spans[0].start).toBeGreaterThan(1.5)
    expect(spans[0].start).toBeLessThan(2.1)
    expect(spans[2].end).toBeGreaterThan(26.9)

    const chunks = planChunks(spans, 5)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(5 + 1e-6)
    // second piece of the first chunk: 1 s into it is 1 s after its start on the track
    const c = chunks.find((x) => x.pieces.length > 1) ?? chunks[0]
    const p = c.pieces[c.pieces.length - 1]
    expect(toTrackTime(c, p.out + 1)).toBeCloseTo(p.src + 1)
    expect(chunkAudio(pcm, c).length).toBe(Math.ceil(c.length * ASR_RATE))
  })

  it('reads wav files to 16 kHz mono and writes them back', () => {
    const pcm = speechPcm(2, [[0.5, 1]])
    const again = pcm16FromWav(wavFromPcm16(pcm))
    expect(again.length).toBe(pcm.length)
    expect(again[ASR_RATE]).toBe(pcm[ASR_RATE])
  })
})

describe('cleaning engine output', () => {
  it('drops made-up lines and repeats, splits long ones', () => {
    const segs = cleanSegments([
      { start: 0, end: 2, text: 'おかえりなさい' },
      { start: 2, end: 3, text: 'ご視聴ありがとうございました' },
      { start: 3, end: 4, text: 'うん' },
      { start: 4, end: 5, text: 'うん' },
      { start: 5, end: 6, text: 'うん。' },
      { start: 6, end: 7, text: 'ささやき', noSpeech: 0.95 }
    ])
    expect(segs.map((s) => s.text)).toEqual(['おかえりなさい', 'うん', 'うん'])
    const cues = toCues([{ start: 0, end: 10, text: 'ねえ、今日はずっと一緒にいてくれるんだよね。じゃあ、まずはお耳のマッサージから始めましょうか。' }])
    expect(cues.length).toBe(2)
    expect(cues[0].start).toBe(0)
    expect(cues[1].end).toBe(10)
  })
})

describe('translation', () => {
  it('reads {id, ko} answers, also with chatter around', () => {
    const m = parseIdAnswer('Sure!\n```json\n[{"id":1,"ko":"안녕"},{"id":2,"ko":"잘 자"}]\n```')
    expect(m.get(2)).toBe('잘 자')
    expect(parseIdAnswer('{"id": 3, "ko": "어서 와"} and {"id":4,"ko":"응"}').get(4)).toBe('응')
  })

  it('asks again and splits a batch that comes back short, never shifting lines', async () => {
    let calls = 0
    const tr: Translator = {
      id: 'fake',
      llm: true,
      async translate(lines) {
        calls++
        // drops the last line whenever more than 2 are asked at once
        return lines.map((l, i) => (lines.length > 2 && i === lines.length - 1 ? '' : `KO:${l}`))
      }
    }
    const lines = ['a', 'b', 'c', 'd', 'e']
    const out = await translateLines(lines, tr, { kind: 'subtitle', glossary: [] })
    expect(out).toEqual(lines.map((l) => `KO:${l}`))
    expect(calls).toBeGreaterThan(1)
  })
})

describe('자동 자막', () => {
  it('writes .ja.vtt and .ko.vtt next to the voice-only file, caches the engine and keeps existing subtitles', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000050 作品')
    const pcm = speechPcm(20, [
      [1, 4],
      [8, 11]
    ])
    tree(w, {
      'SE有/01_はじまり.wav': wavFromPcm16(pcm),
      'SE無/01_はじまり.wav': wavFromPcm16(pcm)
    })
    const asr = new MockAsr((len) => [{ start: 0.1, end: Math.min(2.5, len), text: 'おかえりなさい' }])
    const tr: Translator = { id: 'fake', llm: true, translate: async (lines) => lines.map(() => '어서 와') }
    const core = new EnvCore(':memory:', { asr, translator: tr })
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const id = core.works()[0].id

    const r = await core.autoSub(id, { transcribe: true, translate: true, extras: false, redo: false }).done
    expect(r.failed).toEqual([])
    expect(r.made).toBe(2)
    const ja = join(w, 'SE無', '01_はじまり.ja.vtt')
    const ko = join(w, 'SE無', '01_はじまり.ko.vtt')
    expect(readFileSync(ja, 'utf8')).toContain('おかえりなさい')
    expect(readFileSync(ko, 'utf8')).toContain('어서 와')
    expect(existsSync(join(w, 'SE有', '01_はじまり.ja.vtt'))).toBe(false)
    const calls = asr.calls

    // again: subtitles exist → skipped, the engine is not asked
    await core.runScan().done
    const again = await core.autoSub(id, { transcribe: true, translate: true, extras: false, redo: false }).done
    expect(again.made).toBe(0)
    expect(again.skipped.length).toBe(2)
    expect(asr.calls).toBe(calls)

    // redo: Env's own files are replaced, the engine answer comes from the cache
    const redo = await core.autoSub(id, { transcribe: true, translate: false, extras: false, redo: true }).done
    expect(redo.made).toBe(1)
    expect(asr.calls).toBe(calls)
    core.close()
  })

  it('needs permission before sending audio or text out', () => {
    const core = new EnvCore(':memory:')
    core.saveSettings({ asrEngine: 'groq', groqApiKey: 'k', allowAudioUpload: false })
    expect(() => core.asrEngine()).toThrow(/음성을 밖으로/)
    expect(() => core.translator()).toThrow(/글자를 밖으로/)
    core.saveSettings({ allowAudioUpload: true, allowTextUpload: true })
    expect(core.asrEngine().id).toContain('groq')
    expect(core.translator().id).toBe('google')
    core.close()
  })

  it('keeps a glossary per work on top of the common one', async () => {
    const core = new EnvCore(':memory:')
    core.setGlossary(null, [
      { source: 'お兄ちゃん', target: '오빠' },
      { source: '先輩', target: '선배' }
    ])
    expect(core.glossary(null).map((g) => g.target)).toEqual(['오빠', '선배'])
    core.close()
  })
})

describe('이름 번역', () => {
  it('keeps codes and track numbers, shows translations when chosen, renames folders and files to them', async () => {
    const { splitName } = await import('../src/core/names/translate')
    expect(splitName('RJ01234567 01_はじまり')).toEqual({ prefix: 'RJ01234567 01_', body: 'はじまり' })
    expect(splitName('トラック１_導入編').prefix).toBe('トラック１_')
    expect(splitName('0-1.プロローグ').body).toBe('プロローグ')

    const root = tempDir()
    const w = join(root, 'RJ01000060 甘い時間')
    tree(w, { '01_はじまり.mp3': null, '01_はじまり.ja.vtt': Buffer.from('WEBVTT'), '02_おやすみ.mp3': null, 'おまけ/おやすみ.txt': Buffer.from('x') })
    const tr: Translator = {
      id: 'fake',
      llm: true,
      translate: async (lines) => lines.map((l) => ({ 甘い時間: '달콤한 시간', はじまり: '시작', おやすみ: '잘 자', おまけ: '덤' })[l] ?? '')
    }
    const core = new EnvCore(':memory:', { translator: tr })
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const id = core.works()[0].id
    expect(await core.translateWorkNames(id).done).toBe(6) // title, 2 tracks, subtitle, folder, txt
    expect(core.works()[0].title).toBe('甘い時間') // 이름 표시: 원래 이름
    core.saveSettings({ nameDisplay: 'translated' })
    expect(core.works()[0].title).toBe('달콤한 시간')
    const g = core.work(id)!.groups[0]
    expect(g.title).toBe('01_시작')
    expect(g.originalTitle).toBe('01_はじまり')
    const plan = await core.planRename([id], 'translate').done
    expect(plan.map((p) => basename(p.to)).sort()).toEqual(['01_시작.ja.vtt', '01_시작.mp3', '02_잘 자.mp3', 'RJ01000060 달콤한 시간', '덤', '잘 자.txt'])
    expect(plan[plan.length - 1].work).toBe(true) // the work folder goes last
    // renaming keeps the work, its listening progress and the translations
    core.saveProgress({ workId: id, groupKey: g.key, position: 42 })
    const r = await core.runRename(plan).done
    expect(r.done).toBe(6)
    const moved = join(root, 'RJ01000060 달콤한 시간')
    expect(existsSync(join(moved, '01_시작.ja.vtt'))).toBe(true)
    expect(core.works().map((x) => x.id)).toEqual([id])
    const g2 = core.work(id)!.groups[0]
    expect(g2.title).toBe('01_시작')
    expect(g2.position).toBe(42)
    expect(g2.versions[0].subs.length).toBe(1)
    // undo puts every name back, progress still there
    await core.log.undo()
    expect(existsSync(join(w, '01_はじまり.ja.vtt'))).toBe(true)
    expect(core.work(id)!.groups[0].position).toBe(42)
    core.close()
  })

  it('translates the title that is shown: a Korean folder stays, a code-only folder uses DLsite', async () => {
    const { titleToTranslate } = await import('../src/core/library')
    const dl = '【韓国語版】やさしいお姉さんの癒やし'
    expect(titleToTranslate({ title: '【한국어 자막판】 다정한 누나의 힐링', code: 'RJ01000070', dl_title: dl })).toBe('【한국어 자막판】 다정한 누나의 힐링')
    expect(titleToTranslate({ title: 'RJ01000070', code: 'RJ01000070', dl_title: dl })).toBe(dl)
    expect(titleToTranslate({ title: '甘い時間', code: null, dl_title: dl })).toBe('甘い時間')
  })
})
