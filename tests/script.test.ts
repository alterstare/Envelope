import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvCore } from '../src/core'
import { ASR_RATE, wavFromPcm16 } from '../src/core/asr/audio'
import { MockAsr } from '../src/core/asr/engines'
import type { AsrSegment } from '../src/core/asr/clean'
import { scriptLines } from '../src/core/script/text'
import { alignByLength, alignJapanese, normJa, toAlignedCues } from '../src/core/script/align'
import { parseSubtitle, toVtt } from '../src/core/subtitle'
import type { Translator } from '../src/core/translate'
import { cleanup, tempDir, tree } from './helpers'

afterEach(cleanup)

describe('대본 정리', () => {
  it('keeps what is said, drops directions, finds track headings', () => {
    const lines = scriptLines(
      [
        '台本　〜甘い時間〜',
        '',
        '■トラック１　はじまり',
        '（SE：ドアが開く）',
        '妹「お兄ちゃん、おかえりなさい！」',
        '【耳元で】ねえ、今日はずっと一緒だよ。',
        '＜息遣い＞',
        'トラック2：おやすみ',
        '妹：おやすみなさい♡'
      ].join('\n')
    )
    expect(lines.map((l) => (l.heading !== undefined ? `#${l.heading}` : l.text))).toEqual([
      '台本　〜甘い時間〜',
      '#1',
      'お兄ちゃん、おかえりなさい！',
      'ねえ、今日はずっと一緒だよ。',
      '#2',
      'おやすみなさい♡'
    ])
    expect(normJa('カタカナ、ーです！')).toBe('かたかなです')
  })
})

describe('위치 맞추기', () => {
  it('times Japanese lines from the words that match, spreads the rest', () => {
    const lines = ['おかえりなさい', 'きょうはずっといっしょ', 'これはきこえない']
    const segs: AsrSegment[] = [
      { start: 1, end: 3, text: 'おかえりなさい', words: [{ start: 1, end: 3, text: 'おかえりなさい' }] },
      { start: 5, end: 8, text: '今日はずっと一緒', words: [{ start: 5, end: 8, text: 'きょうはずっといっしょ' }] }
    ]
    const al = alignJapanese(lines, segs, 12)
    expect(al[0].start).toBeCloseTo(1, 1)
    expect(al[0].end).toBeCloseTo(3, 1)
    expect(al[1].start).toBeCloseTo(5, 1)
    expect(al[2].start).toBeGreaterThanOrEqual(al[1].end - 0.01)
    const cues = toAlignedCues(lines, al)
    expect(cues[2].low).toBe(true)
    expect(cues[0].low).toBeUndefined()
    // the mark survives a save / load
    expect(parseSubtitle(toVtt(cues), '.vtt').map((c) => !!c.low)).toEqual([false, false, true])
  })

  it('matches Korean lines to Japanese segments by length', () => {
    const segs: AsrSegment[] = [
      { start: 0, end: 2, text: 'おかえり' },
      { start: 3, end: 7, text: '今日はずっと一緒にいようね' },
      { start: 8, end: 9, text: 'うん' }
    ]
    const al = alignByLength(['어서 와', '오늘은 계속 같이 있자', '응'], segs, 10)
    expect(al[1].start).toBeCloseTo(3)
    expect(al[1].end).toBeCloseTo(7)
    expect(al[2].start).toBeCloseTo(8)
  })
})

// 16 kHz tone bursts as "speech"
function pcm(seconds: number, spans: [number, number][]): Int16Array {
  const p = new Int16Array(seconds * ASR_RATE)
  for (const [a, b] of spans) for (let i = a * ASR_RATE; i < b * ASR_RATE; i++) p[i] = Math.round(Math.sin(i / 10) * 8000)
  return p
}

describe('대본 기반 자막', () => {
  it('finds per-track and whole scripts, aligns them and writes the subtitles (+ Korean)', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000070 甘い時間')
    tree(w, {
      '01_はじまり.wav': wavFromPcm16(pcm(10, [[1, 6]])),
      '02_おやすみ.wav': wavFromPcm16(pcm(10, [[2, 5]])),
      'おまけ/台本.txt': Buffer.from('トラック1\nお兄ちゃん、おかえりなさい\nトラック2\nおやすみなさい\n'),
      'Script/01_はじまり.txt': Buffer.from('오빠, 어서 와'),
      'Script/02_おやすみ.txt': Buffer.from('잘 자')
    })
    // the engine "hears" each track's script line
    const heard: Record<number, string> = { 0: 'おにいちゃんおかえりなさい', 1: 'おやすみなさい' }
    let call = 0
    const asr = new MockAsr((len) => [{ start: 0.2, end: Math.min(len, 3), text: heard[call++ % 2], words: [{ start: 0.2, end: Math.min(len, 3), text: heard[(call - 1) % 2] }] }])
    const tr: Translator = { id: 'fake', llm: true, translate: async (ls) => ls.map((l) => `KO:${l}`) }
    const core = new EnvCore(':memory:', { asr, translator: tr })
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const id = core.works()[0].id

    const sources = await core.findScripts(id)
    expect(sources.map((s) => [s.kind, s.lang])).toEqual([
      ['whole', 'ja'],
      ['perTrack', 'ko']
    ])
    const ja = sources[0]
    const prev = await core.previewScript(id, ja.id)
    expect(prev.map((p) => [p.title, p.lines, p.first])).toEqual([
      ['01_はじまり', 1, 'お兄ちゃん、おかえりなさい'],
      ['02_おやすみ', 1, 'おやすみなさい']
    ])
    const r = await core.scriptSub(id, { sourceId: ja.id, translate: true, redo: false }).done
    expect(r.failed).toEqual([])
    expect(r.made).toBe(4)
    const vtt = readFileSync(join(w, '01_はじまり.ja.vtt'), 'utf8')
    expect(vtt).toContain('お兄ちゃん、おかえりなさい')
    expect(readFileSync(join(w, '02_おやすみ.ko.vtt'), 'utf8')).toContain('KO:おやすみなさい')
    core.close()
  })
})

describe('트랙 제목이 없는 대본', () => {
  it('splits a whole script by what each track says', async () => {
    const { alignAcross } = await import('../src/core/script/align')
    const lines = ['おかえりなさい', 'きょうもいっしょ', 'おやすみなさい', 'またあした']
    const t1 = [{ start: 1, end: 4, text: 'x', words: [{ start: 1, end: 2, text: 'おかえりなさい' }, { start: 2.5, end: 4, text: 'きょうもいっしょ' }] }]
    const t2 = [{ start: 0.5, end: 3, text: 'y', words: [{ start: 0.5, end: 1.5, text: 'おやすみなさい' }, { start: 2, end: 3, text: 'またあした' }] }]
    const out = alignAcross(lines, [
      { segs: t1, total: 5 },
      { segs: t2, total: 4 }
    ])
    expect(out.get(0)!.lines).toEqual(['おかえりなさい', 'きょうもいっしょ'])
    expect(out.get(1)!.lines).toEqual(['おやすみなさい', 'またあした'])
    expect(out.get(1)!.al[0].start).toBeCloseTo(0.5, 1)
  })

  it('ignores phrases every track says and lines nobody heard', async () => {
    const { partitionLines } = await import('../src/core/script/align')
    const lines = ['だいすきだいすき', 'まほうのつえをかして', 'あああああっ', 'だいすきだいすき', 'あしたのてんきはあめ', 'だいすきだいすき']
    const tracks = ['だいすきだいすきまほうのつえをかしてだいすき', 'だいすきだいすきあしたのてんきはあめだいすき']
    expect(partitionLines(lines, tracks)).toEqual([0, 0, 0, 0, 1, 1])
  })
})
