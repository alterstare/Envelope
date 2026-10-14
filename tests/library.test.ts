import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvCore } from '../src/core'
import { findWorks, scanWork } from '../src/core/library/scan'
import type { ScannedTrack } from '../src/core/library/scan'
import { parseMp3, parseWav } from '../src/core/library/probe'
import { isInside, parseRange } from '../src/core/media'
import { cleanup, mp3, tempDir, toMojibake, tree, wav } from './helpers'

afterEach(cleanup)

const groups = (tracks: ScannedTrack[]): Map<string, ScannedTrack[]> => {
  const m = new Map<string, ScannedTrack[]>()
  for (const t of tracks) m.set(t.groupKey, [...(m.get(t.groupKey) ?? []), t])
  return m
}

describe('probe', () => {
  it('reads wav length, RIFF and RF64', () => {
    for (const kind of ['RIFF', 'RF64'] as const) {
      const b = wav(2, kind)
      expect(parseWav(b, b.length)).toEqual({ duration: 2, bitrate: 64 })
    }
  })

  it('reads CBR and Xing mp3 length', () => {
    const b = mp3(3)
    expect(parseMp3(b, 0, b.length)).toEqual({ duration: 3, bitrate: 128 })
    const x = mp3(1)
    x.write('Xing', 36, 'ascii')
    x.writeUInt32BE(1, 40)
    x.writeUInt32BE(100, 44)
    expect(parseMp3(x, 0, x.length).duration).toBeCloseTo((100 * 1152) / 44100)
  })
})

describe('media', () => {
  it('parses ranges', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=10-500', 100)).toEqual({ start: 10, end: 99 })
    expect(parseRange('bytes=200-', 100)).toBeNull()
    expect(parseRange(null, 100)).toBeNull()
  })

  it('checks paths inside a folder', () => {
    expect(isInside(join('a', 'b', 'c.mp3'), join('a', 'b'))).toBe(true)
    expect(isInside(join('a', 'bc', 'c.mp3'), join('a', 'b'))).toBe(false)
  })
})

describe('scan', () => {
  it('finds works, also under a circle folder', async () => {
    const root = tempDir()
    tree(root, {
      'RJ01000001 作品A/a.mp3': null,
      'サークル/RJ01000002 作品B/b.mp3': null,
      '画像だけ/x.jpg': null,
      'Loose work/c.wav': null
    })
    const works = (await findWorks(root)).map((p) => p.slice(root.length + 1))
    expect(works.sort()).toEqual(['Loose work', 'RJ01000001 作品A', join('サークル', 'RJ01000002 作品B')].sort())
  })

  it('groups SE × format versions; wav folders holding mp3 are judged by extension', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000001 【タグ】作品')
    tree(w, {
      '本編/SE有/MP3/トラック1_SE有り.mp3': mp3(2),
      '本編/SE有/WAV/トラック1_SE有り.mp3': mp3(2),
      '本編/SE無/MP3/トラック1_SE無し.mp3': mp3(1.8),
      '本編/SE無/WAV/トラック1_SE無し.mp3': mp3(1.8),
      '本編/SE有/MP3/トラック2_SEあり.mp3': mp3(3),
      '本編/SE無/MP3/トラック2_SEなし.mp3': mp3(3),
      'おまけ/フリートーク.wav': wav(1),
      'おまけ/SAMPLE/sample01.mp3': mp3(1),
      'イラスト/【タイトルあり】ジャケット.jpg': null,
      'イラスト/【タイトルなし】ジャケット.jpg': null,
      'Thumbs.db': null,
      '.DS_Store': null
    })
    const s = await scanWork(w)
    expect(s.code).toBe('RJ01000001')
    expect(s.title).toBe('【タグ】作品')
    const g = groups(s.tracks)
    const main = [...g.values()].filter((x) => x[0].role === 'main')
    expect(main).toHaveLength(2)
    const t1 = main.find((x) => x[0].title.startsWith('トラック1'))!
    expect(t1.map((t) => `${t.se}/${t.formatDir}${t.ext}`).sort()).toEqual(['off/mp3.mp3', 'off/wav.mp3', 'on/mp3.mp3', 'on/wav.mp3'])
    expect(s.tracks.find((t) => t.title === 'フリートーク')?.role).toBe('extra')
    expect(s.tracks.find((t) => t.title === 'sample01')?.role).toBe('sample')
    expect(s.cover?.endsWith('【タイトルあり】ジャケット.jpg')).toBe(true)
    expect(s.images[0].endsWith('【タイトルなし】ジャケット.jpg')).toBe(true)
    expect(t1[0].duration).toBeGreaterThan(1)
  })

  it('pairs loose files with an SE-less folder, and merges by track number', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000002 作品')
    tree(w, {
      'トラック１.wav': wav(10),
      '「SEなし」作品のサブタイトル/トラック１SEなし.wav': wav(10),
      'トラック２.wav': wav(5)
    })
    const s = await scanWork(w)
    expect(s.tracks.every((t) => t.edition === '')).toBe(true)
    const a = [...groups(s.tracks).values()].find((x) => x.some((t) => t.title === 'トラック１'))!
    expect(a.map((t) => t.se).sort()).toEqual(['off', 'on'])

    // different names, same number, voice-only a little shorter
    const w2 = join(root, 'RJ01000012 作品')
    tree(w2, {
      'mp3/voice_se/Tr1_v1_20240130.mp3': mp3(10),
      'mp3/Voice_Only/Tr1_v1_Voice_Only.mp3': mp3(9.7),
      'mp3/voice_se/Tr2_v1_20240130.mp3': mp3(20),
      'mp3/Voice_Only/Tr2_v1_Voice_Only.mp3': mp3(19.5)
    })
    const g2 = [...groups((await scanWork(w2)).tracks).values()]
    expect(g2).toHaveLength(2)
    for (const g of g2) expect(g.map((t) => t.se).sort()).toEqual(['off', 'on'])
  })

  it('keeps real editions apart', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000003 作品')
    tree(w, {
      'ノーマルversion/話_ノーマル.wav': wav(1),
      '清楚version/話_清楚.wav': wav(1)
    })
    const s = await scanWork(w)
    expect(new Set(s.tracks.map((t) => t.editionKey)).size).toBe(2)
  })

  it('shows 뷁어 names repaired and fills lost characters from the title', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000004 旅行予定表の話')
    // 予 and 表 can't survive CP949: the extractor wrote "_"
    tree(w, {
      [`${toMojibake('おまけ')}/${toMojibake('トラック1_導入編')}.mp3`]: null,
      [`${toMojibake('トラック2_旅行')}_${toMojibake('定')}_${toMojibake('の話')}.mp3`]: null
    })
    const s = await scanWork(w)
    const titles = s.tracks.map((t) => t.title).sort()
    expect(titles).toEqual(['トラック1_導入編', 'トラック2_旅行予定表の話'])
    expect(s.tracks.find((t) => t.title === 'トラック1_導入編')?.role).toBe('extra')
    expect(s.mojibake).toBe(true)
  })
})

describe('library in the DB', () => {
  it('saves a scan, picks versions by preference and keeps progress across rescans', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000005 作品')
    tree(w, {
      'mp3/01_話.mp3': mp3(2),
      'wav/01_話.wav': wav(2),
      'SE無し/01_話.wav': wav(2),
      'mp3/02_話.mp3': mp3(2)
    })
    const core = new EnvCore(':memory:')
    core.saveSettings({ libraryDirs: [root] })
    expect((await core.runScan().done).works).toBe(1)
    const [sum] = core.works()
    expect(sum.tracks).toBe(2)
    let d = core.work(sum.id)!
    const g1 = d.groups[0]
    expect(d.hasSeChoice).toBe(true)
    expect(g1.versions.find((v) => v.id === g1.chosen)?.path.endsWith(join('wav', '01_話.wav'))).toBe(true)
    core.saveSettings({ formatPref: 'mp3' })
    expect(core.work(sum.id)!.groups[0].versions.find((v) => v.id === core.work(sum.id)!.groups[0].chosen)?.ext).toBe('.mp3')
    core.setWorkPrefs(sum.id, { sePref: 'off' })
    d = core.work(sum.id)!
    expect(d.groups[0].versions.find((v) => v.id === d.groups[0].chosen)?.se).toBe('off')

    core.saveProgress({ workId: sum.id, groupKey: g1.key, position: 1.5 })
    await core.runScan().done
    d = core.work(sum.id)!
    expect(d.groups[0].position).toBe(1.5)
    expect(d.lastGroup).toBe(g1.key)
    expect(core.works()[0].played).toBe(1)

    core.saveSettings({ libraryDirs: [] })
    expect((await core.runScan().done).removed).toBe(1)
    expect(core.works()).toHaveLength(0)
    core.close()
  })
})

describe('bookmarks', () => {
  it('names points in tracks, lists them in track order and survives rescans', async () => {
    const root = tempDir()
    tree(join(root, 'RJ01000040 作品'), { '01.mp3': mp3(2), '02.mp3': mp3(2) })
    const core = new EnvCore(':memory:')
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const id = core.works()[0].id
    const [g1, g2] = core.work(id)!.groups
    const b = core.addBookmark(id, g2.key, 1.5, '  좋은 부분 ')
    core.addBookmark(id, g1.key, 0.7, '')
    expect(core.work(id)!.bookmarks.map((x) => [x.groupKey, x.position, x.name])).toEqual([
      [g1.key, 0.7, '북마크'],
      [g2.key, 1.5, '좋은 부분']
    ])
    core.renameBookmark(b, '다시')
    await core.runScan().done
    expect(core.work(id)!.bookmarks[1].name).toBe('다시')
    core.deleteBookmark(b)
    expect(core.work(id)!.bookmarks).toHaveLength(1)
    core.close()
  })
})
