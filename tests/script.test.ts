import { existsSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvCore } from '../src/core'
import { ASR_RATE, wavFromPcm16 } from '../src/core/asr/audio'
import { MockAsr } from '../src/core/asr/engines'
import type { AsrSegment } from '../src/core/asr/clean'
import { scriptLines } from '../src/core/script/text'
import { CONTENT, alignByContent, alignByLength, alignJapanese, normJa, speechPieces, toAlignedCues } from '../src/core/script/align'
import { parseSubtitle, toVtt } from '../src/core/subtitle'
import type { Translator } from '../src/core/translate'
import { cleanup, tempDir, tree } from './helpers'

// The subtitle the program keeps for the track whose path contains `part`.
async function appSub(core: EnvCore, id: number, part: string, lang: string): Promise<string> {
  for (const g of core.work(id)!.groups)
    for (const v of g.versions)
      if (v.path.includes(part)) {
        const s = v.subs.find((x) => x.lang === lang && x.path.startsWith('envsub:'))
        if (s) return (await core.readSubtitle(s.path)).cues.map((c) => c.text).join('\n')
      }
  return ''
}

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

  it('places Korean lines by what the translated speech shares with them', () => {
    // the script has a line nobody says, the speech a piece the script lacks
    const lines = ['오빠, 어서 와', '이 줄은 안 들림', '오늘은 하루 종일 같이 있자', '아앗♡', '잘 자, 오빠']
    const pieces = [
      { start: 1, end: 3, ko: '오빠, 어서 와요' },
      { start: 4, end: 5, ko: '전혀 다른 말입니다' },
      { start: 6, end: 9, ko: '오늘은 하루 종일 함께 있자' },
      { start: 12, end: 14, ko: '잘 자요 오빠' }
    ]
    const al = alignByContent(lines, pieces, 20)
    expect(al[0].start).toBeCloseTo(1 - CONTENT.leadS)
    expect(al[2].start).toBeCloseTo(6 - CONTENT.leadS)
    expect(al[4].start).toBeCloseTo(12 - CONTENT.leadS)
    expect(al[2].conf).toBeGreaterThan(0.5)
    // order kept for the rest
    for (let i = 1; i < al.length; i++) expect(al[i].start).toBeGreaterThanOrEqual(al[i - 1].start)
  })

  it('cuts the heard speech into pieces at sentence marks and pauses, moans out', () => {
    const w = (start: number, end: number, text: string): { start: number; end: number; text: string } => ({ start, end, text })
    const segs: AsrSegment[] = [
      { start: 0, end: 9, text: '', words: [w(0, 1, 'おかえり'), w(1, 2, 'なさい。'), w(2, 3, '今日は'), w(3.1, 4, 'ずっと'), w(6, 7, 'あぁぁん'), w(8, 9, '一緒だよ')] }
    ]
    expect(speechPieces(segs).map((p) => [p.start, p.text])).toEqual([
      [0, 'おかえりなさい。'],
      [2, '今日はずっと'],
      [8, '一緒だよ']
    ])
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
    const vtt = await appSub(core, id, '01_', 'ja')
    expect(vtt).toContain('お兄ちゃん、おかえりなさい')
    expect(await appSub(core, id, '02_', 'ko')).toContain('KO:おやすみなさい')
    expect(existsSync(join(w, '01_はじまり.ja.vtt'))).toBe(false) // the folder is untouched
    core.close()
  })
})

describe('직접 고른 대본 파일', () => {
  it('uses a picked file the finder skips (any name, outside the work) like a found script', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000071 テスト')
    tree(w, {
      '01_はじめ.wav': wavFromPcm16(pcm(10, [[1, 6]])),
      '02_おわり.wav': wavFromPcm16(pcm(10, [[2, 5]]))
    })
    const other = tempDir()
    tree(other, { '本編.txt': Buffer.from('トラック1\nこんにちは\nトラック2\nまたね\n') })
    const heard: Record<number, string> = { 0: 'こんにちは', 1: 'またね' }
    let call = 0
    const asr = new MockAsr((len) => [{ start: 0.2, end: Math.min(len, 3), text: heard[call++ % 2], words: [{ start: 0.2, end: Math.min(len, 3), text: heard[(call - 1) % 2] }] }])
    const core = new EnvCore(':memory:', { asr })
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const id = core.works()[0].id
    expect(await core.findScripts(id)).toEqual([]) // not found by name
    expect(await core.scriptFromFile(join(other, 'x.mp3'))).toBeNull()
    const src = (await core.scriptFromFile(join(other, '本編.txt')))!
    expect([src.kind, src.lang, src.label]).toEqual(['whole', 'ja', '本編.txt'])
    const prev = await core.previewScript(id, src.id)
    expect(prev.map((p) => [p.title, p.first])).toEqual([
      ['01_はじめ', 'こんにちは'],
      ['02_おわり', 'またね']
    ])
    const r = await core.scriptSub(id, { sourceId: src.id, translate: false, redo: false }).done
    expect(r.failed).toEqual([])
    expect(await appSub(core, id, '02_', 'ja')).toContain('またね')
    await expect(core.previewScript(id, `file:${join(other, 'gone.txt')}`)).rejects.toThrow('대본을 찾지 못했습니다')
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

describe('한국어 대본', () => {
  it('translates what is heard once for all tracks, places the lines, and asks nothing again', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000071 甘い時間')
    tree(w, {
      '01_はじまり.wav': wavFromPcm16(pcm(10, [[1, 6]])),
      '02_おやすみ.wav': wavFromPcm16(pcm(10, [[2, 5]])),
      'Script/01_はじまり.txt': Buffer.from('오빠, 어서 와\n오늘은 하루 종일 같이 있자'),
      'Script/02_おやすみ.txt': Buffer.from('잘 자, 오빠')
    })
    const said: Record<string, [number, number, string][]> = {
      a: [
        [1, 2, 'お兄ちゃん、おかえり。'],
        [3, 5, '今日は一日中一緒にいよう。']
      ],
      b: [[2, 4, 'おやすみ、お兄ちゃん。']]
    }
    let call = 0
    const asr = new MockAsr(() => {
      const ws = said[call++ % 2 === 0 ? 'a' : 'b'].map(([start, end, text]) => ({ start, end, text }))
      return [{ start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((x) => x.text).join(''), words: ws }]
    })
    const ko: Record<string, string> = { 'お兄ちゃん、おかえり。': '오빠, 어서 와.', '今日は一日中一緒にいよう。': '오늘은 하루 종일 함께 있자.', 'おやすみ、お兄ちゃん。': '잘 자요, 오빠.' }
    const asked: string[][] = []
    const tr: Translator = { id: 'fake', llm: false, translate: async (ls) => (asked.push(ls), ls.map((l) => ko[l] ?? '')) }
    const core = new EnvCore(':memory:', { asr, translator: tr })
    core.saveSettings({ libraryDirs: [root], allowTextUpload: true })
    await core.runScan().done
    const id = core.works()[0].id
    const src = (await core.findScripts(id)).find((s) => s.lang === 'ko')!

    const r = await core.scriptSub(id, { sourceId: src.id, translate: false, redo: false }).done
    expect(r.failed).toEqual([])
    expect(r.made).toBe(2)
    expect(asked).toEqual([Object.keys(ko)]) // both tracks in one request
    const first = (await core.readSubtitle(core.work(id)!.groups[0].versions[0].subs.find((s) => s.lang === 'ko')!.path)).cues
    expect(first.map((c) => c.text)).toEqual(['오빠, 어서 와', '오늘은 하루 종일 같이 있자'])
    expect(first[1].start - first[0].start).toBeCloseTo(2) // each line on its own piece (heard at 1 s and 3 s)

    // again: the translations are kept, nothing is asked
    await core.scriptSub(id, { sourceId: src.id, translate: false, redo: true }).done
    expect(asked.length).toBe(1)
    core.close()
  })
})
