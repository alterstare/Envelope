import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import iconv from 'iconv-lite'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvCore } from '../src/core'
import { decodeText, isEnvMade, langOfName, langOfText, parseSubtitle, toVtt } from '../src/core/subtitle'
import { scanWork } from '../src/core/library/scan'
import { cleanup, mp3, tempDir, tree } from './helpers'

afterEach(cleanup)

describe('parse', () => {
  it('reads vtt (hours optional, tags, notes)', () => {
    const vtt = 'WEBVTT\n\nNOTE hi\n\n1\n00:01.500 --> 00:03.000\n<i>こんにちは</i>\n\n01:00:00.000 --> 01:00:02.250 align:start\n둘째\n줄'
    expect(parseSubtitle(vtt, '.vtt')).toEqual([
      { start: 1.5, end: 3, text: 'こんにちは' },
      { start: 3600, end: 3602.25, text: '둘째\n줄' }
    ])
  })

  it('reads srt with CRLF', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\nA\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nB\r\n'
    expect(parseSubtitle(srt, '.srt').map((c) => [c.start, c.end, c.text])).toEqual([
      [1, 2.5, 'A'],
      [3, 4, 'B']
    ])
  })

  it('reads lrc (ends at the next line) and ass', () => {
    expect(parseSubtitle('[ti:x]\n[00:01.00]a\n[00:03.50][00:10.00]b', '.lrc')).toEqual([
      { start: 1, end: 3.5, text: 'a' },
      { start: 3.5, end: 10, text: 'b' },
      { start: 10, end: 15, text: 'b' }
    ])
    const ass = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}こん,にちは\\Nです'
    expect(parseSubtitle(ass, '.ass')).toEqual([{ start: 1, end: 2, text: 'こん,にちは\nです' }])
  })

  it('round-trips through vtt and marks Env files', () => {
    const cues = [
      { start: 0.5, end: 2, text: 'a' },
      { start: 3725.25, end: 3726, text: 'b\nc' }
    ]
    const v = toVtt(cues)
    expect(isEnvMade(v)).toBe(true)
    expect(parseSubtitle(v, '.vtt')).toEqual(cues)
  })
})

describe('encoding and language', () => {
  it('decodes UTF-8, UTF-16, Shift-JIS and CP949', () => {
    const ja = '00:00:01,000 --> 00:00:02,000\nお兄ちゃん、おはよう'
    const ko = '00:00:01,000 --> 00:00:02,000\n오빠, 좋은 아침이에요'
    expect(decodeText(Buffer.from(ja, 'utf8'))).toBe(ja)
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ko, 'utf16le')]))).toBe(ko)
    expect(decodeText(iconv.encode(ja, 'shift_jis'))).toBe(ja)
    expect(decodeText(iconv.encode(ko, 'cp949'))).toBe(ko)
  })

  it('tells the language from the name or the text', () => {
    expect(langOfName('x.ja.srt')).toBe('ja')
    expect(langOfName('x.KO.vtt')).toBe('ko')
    expect(langOfName('x.mp3.vtt')).toBeNull()
    expect(langOfText('お兄ちゃん')).toBe('ja')
    expect(langOfText('오빠')).toBe('ko')
  })
})

describe('subtitles in the library', () => {
  it('links subtitles by name, including x.mp3.vtt / x.wav.vtt / x.ja.srt', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000010 作品')
    tree(w, {
      'mp3/01.mp3': mp3(1),
      'mp3/01.mp3.vtt': null,
      'mp3/01.wav.vtt': null,
      'mp3/01.ja.srt': null,
      'mp3/02.mp3': mp3(1),
      'other/01.vtt': null
    })
    const s = await scanWork(w)
    const t1 = s.tracks.find((t) => t.title === '01')!
    const names = t1.subs.map((x) => x.path.split(/[\\/]/).pop())
    expect(names[0]).toBe('01.mp3.vtt') // same audio extension first
    expect([...names].sort()).toEqual(['01.ja.srt', '01.mp3.vtt', '01.wav.vtt'])
    expect(t1.subs.find((x) => x.path.endsWith('.ja.srt'))?.lang).toBe('ja')
    expect(s.tracks.find((t) => t.title === '02')!.subs).toEqual([])
  })

  it('keeps saved subtitles in the program (the folder is untouched), undoes, and exports them in 파일 정리', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000011 作品')
    tree(w, { '01.mp3': mp3(1) })
    const core = new EnvCore(':memory:')
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const id = core.works()[0].id
    const track = core.work(id)!.groups[0]
    const cues = [{ start: 0, end: 1, text: '안녕' }]

    const r = await core.saveSubtitle(track.chosen, 'ko', cues)
    expect(r.conflict).toBe(false)
    expect(r.path.startsWith('envsub:ko:')).toBe(true)
    expect(existsSync(join(w, '01.ko.vtt'))).toBe(false) // nothing written next to the audio
    expect((await core.readSubtitle(r.path)).cues).toEqual(cues)
    expect(core.work(id)!.groups[0].versions[0].subs[0]).toEqual({ path: r.path, lang: 'ko' })

    // update, then undo twice: back to the first text, then none
    await core.saveSubtitle(track.chosen, 'ko', [{ start: 0, end: 1, text: '수정' }])
    await core.log.undo()
    expect((await core.readSubtitle(r.path)).cues[0].text).toBe('안녕')
    await core.log.undo()
    expect(core.work(id)!.groups[0].versions[0].subs).toEqual([])

    // a program subtitle wins over another program's file of the same language
    writeFileSync(join(w, '01.ko.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\n원본\n')
    await core.runScan().done
    await core.saveSubtitle(track.chosen, 'ko', cues)
    expect(core.work(id)!.groups[0].versions[0].subs[0].path).toBe(r.path)
    expect(readFileSync(join(w, '01.ko.vtt'), 'utf8')).toContain('원본')

    // 파일 정리 › 자막 › 폴더 변경: the other program's file is a conflict;
    // exporting it anyway writes ours, undo puts theirs back
    const plan = await core.planSubExport([id]).done
    expect(plan.map((p) => p.state)).toEqual(['conflict'])
    const done = await core.runSubExport(plan).done
    expect(done.done).toBe(1)
    expect(readFileSync(join(w, '01.ko.vtt'), 'utf8')).toContain('안녕')
    await core.log.undo()
    expect(readFileSync(join(w, '01.ko.vtt'), 'utf8')).toContain('원본')

    core.setSubOffset(id, track.key, -0.4)
    expect(core.work(id)!.groups[0].subOffset).toBe(-0.4)
    core.close()
  })
})

describe('collections', () => {
  it('favorites, stars and groups survive a rescan', async () => {
    const root = tempDir()
    tree(root, { 'RJ01000012 一/01.mp3': mp3(1), '【한국어 자막판】 둘/01.mp3': mp3(1) })
    const core = new EnvCore(':memory:')
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const a = core.works().find((w) => w.code === 'RJ01000012')!
    const b = core.works().find((w) => w.code === null)!
    core.setFavorite([a.id], true)
    core.setRank([b.id], 4)
    const g = core.createGroup('잠잘 때', [a.id, b.id])
    core.setGroupMembership([b.id], g, false)
    await core.runScan().done
    const ws = core.works()
    expect(ws.find((w) => w.id === a.id)).toMatchObject({ favorite: true, groupIds: [g], lang: 'ja' })
    expect(ws.find((w) => w.id === b.id)).toMatchObject({ rank: 4, groupIds: [], lang: 'ko-sub' })
    expect(core.groups()).toEqual([{ id: g, name: '잠잘 때', count: 1 }])
    core.saveSettings({ libSort: 'rank', libDir: 'desc' })
    expect(core.works()[0].id).toBe(b.id)
    core.deleteGroup(g)
    expect(core.works().find((w) => w.id === a.id)?.groupIds).toEqual([])
    core.close()
  })
})
