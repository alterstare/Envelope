import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'fs'
import { basename, dirname, join } from 'path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvCore } from '../src/core'
import { encodeWavToMp3, readWavInfo } from '../src/core/tools/wav'
import { hasCover } from '../src/core/tools/id3'
import { fillDictionary } from '../src/core/names/mojibake'
import { safeName } from '../src/core/tools'
import { parseMp3 } from '../src/core/library/probe'
import { cleanup, mp3, tempDir, toMojibake, tree, wav } from './helpers'

afterEach(cleanup)

// PCM wav with any layout (silence + a little tone).
function pcm(o: { rate: number; channels: number; bits: 16 | 24; seconds: number; riff?: 'RIFF' | 'RF64' }): Buffer {
  const frames = Math.round(o.rate * o.seconds)
  const block = o.channels * (o.bits / 8)
  const data = frames * block
  const b = Buffer.alloc(44 + data)
  b.write(o.riff ?? 'RIFF', 0, 'ascii')
  b.writeUInt32LE(o.riff === 'RF64' ? 0xffffffff : 36 + data, 4)
  b.write('WAVEfmt ', 8, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(o.channels, 22)
  b.writeUInt32LE(o.rate, 24)
  b.writeUInt32LE(o.rate * block, 28)
  b.writeUInt16LE(block, 32)
  b.writeUInt16LE(o.bits, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(o.riff === 'RF64' ? 0xffffffff : data, 40)
  for (let f = 0; f < frames; f++)
    for (let c = 0; c < o.channels; c++) {
      const v = Math.round(Math.sin(f / 30) * 0.3 * (o.bits === 16 ? 32767 : 8388607))
      const at = 44 + f * block + c * (o.bits / 8)
      if (o.bits === 16) b.writeInt16LE(v, at)
      else b.writeIntLE(v, at, 3)
    }
  return b
}

const mp3Seconds = (p: string): number => parseMp3(readFileSync(p), 0, statSync(p).size).duration ?? 0

describe('wav → mp3', () => {
  it('encodes 16-bit stereo and 24-bit 96 kHz RF64 (resampled) to the same length', async () => {
    const dir = tempDir()
    tree(dir, {
      'a.wav': pcm({ rate: 44100, channels: 2, bits: 16, seconds: 3 }),
      'b.wav': pcm({ rate: 96000, channels: 2, bits: 24, seconds: 2, riff: 'RF64' })
    })
    for (const [name, secs] of [['a', 3], ['b', 2]] as const) {
      const info = await readWavInfo(join(dir, `${name}.wav`))
      expect(info.duration).toBeCloseTo(secs, 2)
      await encodeWavToMp3(join(dir, `${name}.wav`), join(dir, `${name}.mp3`), { bitrate: 320 })
      expect(Math.abs(mp3Seconds(join(dir, `${name}.mp3`)) - secs)).toBeLessThan(0.2)
    }
  }, 30000)
})

describe('wav 정리', () => {
  it('plans convert / delete / check / skip and runs them', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000020 作品')
    tree(w, {
      'mp3/01.mp3': mp3(2),
      'mp3/01.wav': wav(2), // same name, same length → delete
      'SE無し/02.wav': wav(1), // alone → convert
      'x/01_足.mp3': mp3(1),
      'x/01足.wav': wav(1), // nearly the same name → check
      'y/03.mp3': mp3(5),
      'y/03.wav': wav(1) // lengths differ → skip
    })
    const old = new Date('2024-01-02T03:04:05Z')
    utimesSync(join(w, 'SE無し/02.wav'), old, old)
    const core = new EnvCore(':memory:')
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const plan = await core.planWav(null).done
    const kind = (f: string): string | undefined => plan.find((p) => p.wav.endsWith(f))?.kind
    expect(kind(join('mp3', '01.wav'))).toBe('delete')
    expect(kind(join('SE無し', '02.wav'))).toBe('convert')
    expect(kind(join('x', '01足.wav'))).toBe('check')
    expect(kind(join('y', '03.wav'))).toBe('skip')

    const bin = tempDir()
    const trash = async (p: string): Promise<void> => renameSync(p, join(bin, basename(p)))
    const r = await core.runWav(plan, trash).done
    expect(r).toMatchObject({ ok: true, done: 3 })
    expect(existsSync(join(w, 'SE無し/02.mp3'))).toBe(true)
    expect(existsSync(join(w, 'SE無し/02.wav'))).toBe(false)
    expect(statSync(join(w, 'SE無し/02.mp3')).mtime.getTime()).toBe(old.getTime())
    expect(existsSync(join(w, 'y/03.wav'))).toBe(true) // skipped
    expect(readdirSync(bin).sort()).toEqual(['01.wav', '01足.wav', '02.wav'])
    expect(core.history()[0]).toMatchObject({ kind: 'wav', undoable: false })
    core.close()
  }, 30000)
})

describe('wav 정리 keeps the program subtitles', () => {
  it('moves them from the wav to its mp3', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000022 作品')
    tree(w, { '01.wav': wav(1) })
    const core = new EnvCore(':memory:')
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const id = core.works()[0].id
    await core.saveSubtitle(core.work(id)!.groups[0].chosen, 'ja', [{ start: 0, end: 1, text: 'こんにちは' }])
    const bin = tempDir()
    const r = await core.runWav(await core.planWav(null).done, async (p) => renameSync(p, join(bin, basename(p)))).done
    expect(r.done).toBe(1)
    await core.runScan().done
    const v = core.work(id)!.groups[0].versions[0]
    expect(v.path.endsWith('01.mp3')).toBe(true)
    expect(v.subs.map((s) => s.lang)).toEqual(['ja'])
    expect((await core.readSubtitle(v.subs[0].path)).cues[0].text).toBe('こんにちは')
    // undoing the save still works on the mp3 it moved to
    await core.log.undo()
    expect(core.work(id)!.groups[0].versions[0].subs).toEqual([])
    core.close()
  }, 30000)
})

describe('mp3 썸네일', () => {
  it('puts the cover into mp3s, keeps the date, and undo restores the bytes', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000021 作品')
    tree(w, { '01.mp3': mp3(1), '02.mp3': mp3(1) })
    mkdirSync(join(w, 'img'))
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#7132f5' } }).jpeg().toFile(join(w, 'img', 'jacket.jpg'))
    const before = readFileSync(join(w, '01.mp3'))
    const mtime = statSync(join(w, '01.mp3')).mtime.getTime()
    const core = new EnvCore(tempDir())
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const plan = await core.planCover(null).done
    expect(plan.map((p) => basename(p.track)).sort()).toEqual(['01.mp3', '02.mp3'])
    expect(plan[0].image?.endsWith('jacket.jpg')).toBe(true)
    const res = await core.runCover(plan).done
    expect(res.failed).toEqual([])
    expect(res.done).toBe(2)
    expect(await hasCover(join(w, '01.mp3'))).toBe(true)
    expect(statSync(join(w, '01.mp3')).mtime.getTime()).toBe(mtime)
    expect(await core.planCover(null).done).toEqual([]) // already have one
    expect(core.history()[0]).toMatchObject({ kind: 'cover', undoable: true })
    await core.log.undo()
    expect(readFileSync(join(w, '01.mp3')).equals(before)).toBe(true)
    core.close()
  })
})

describe('이름 복구', () => {
  it('renames 뷁어 files and folders (children first) and undo puts them back', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000022 作品')
    const dir = toMojibake('おまけ')
    const file = `${toMojibake('トラック1_導入編')}.mp3`
    tree(w, { [`${dir}/${file}`]: mp3(1), [`${dir}/${toMojibake('トラック1_導入編')}.vtt`]: null, 'ok.mp3': mp3(1) })
    const core = new EnvCore(':memory:')
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const plan = await core.planRename(null).done
    expect(plan.map((p) => basename(p.to)).sort()).toEqual(['おまけ', 'トラック1_導入編.mp3', 'トラック1_導入編.vtt'])
    expect(plan[plan.length - 1].dir).toBe(true) // the folder goes last
    await core.runRename(plan).done
    expect(readdirSync(join(w, 'おまけ')).sort()).toEqual(['トラック1_導入編.mp3', 'トラック1_導入編.vtt'])
    await core.log.undo()
    expect(readdirSync(join(w, dir)).sort()).toEqual([file, `${toMojibake('トラック1_導入編')}.vtt`].sort())
    core.close()
  })

  it('fills dictionary words and makes names Windows-safe', () => {
    expect(fillDictionary('【音声フ_イル・SEあり】作品').text).toBe('【音声ファイル・SEあり】作品')
    expect(fillDictionary('1_プロロ_グ').text).toBe('1_プロローグ')
    expect(fillDictionary('_編').text).toBe('本編')
    expect(fillDictionary('トラック1_編').text).toBe('トラック1_編') // too short a mask inside a longer name
    expect(safeName('a:b?c.')).toBe('a：b？c')
  })
})

describe('a work\'s own cover choice', () => {
  it('shows DLsite\'s cover and puts it into the mp3s when the work chose it', async () => {
    const root = tempDir()
    const w = join(root, 'RJ01000031 作品')
    tree(w, { '01.mp3': mp3(1) })
    await sharp({ create: { width: 300, height: 300, channels: 3, background: '#336699' } }).jpeg().toFile(join(w, 'cover.jpg'))
    const dl = join(tempDir(), 'dl.jpg')
    await sharp({ create: { width: 300, height: 300, channels: 3, background: '#993366' } }).jpeg().toFile(dl)
    const core = new EnvCore(tempDir())
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const id = core.works()[0].id
    ;(core as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db.prepare('UPDATE works SET dl_cover = ? WHERE id = ?').run(dl, id)
    expect(core.works()[0].cover?.endsWith('cover.jpg')).toBe(true) // the setting: folder
    core.setCoverPref([id], 'dlsite')
    expect(core.works()[0]).toMatchObject({ cover: dl, covers: { pref: 'dlsite' } })
    expect((await core.planCover(null).done)[0].image).toBe(dl)
    core.setCoverPref([id], null)
    expect(core.works()[0].cover?.endsWith('cover.jpg')).toBe(true)
    core.close()
  })
})

// A VBR-style mp3: one frame with a Xing header (frames + bytes), then data —
// `keep` cuts the file short like an interrupted copy.
function xingMp3(seconds: number, keep = 1): Buffer {
  const size = Math.round(seconds * 16000)
  const b = Buffer.alloc(size)
  b.set([0xff, 0xfb, 0x90, 0x64], 0) // MPEG-1 L3 128k 44.1k joint stereo
  b.write('Xing', 36, 'ascii')
  b.writeUInt32BE(3, 40) // frames + bytes
  b.writeUInt32BE(Math.round((seconds * 44100) / 1152), 44)
  b.writeUInt32BE(size, 48)
  return b.subarray(0, Math.round(size * keep))
}

describe('wav 정리 never loses a wav', () => {
  const setup = async (files: Record<string, Buffer>): Promise<{ core: EnvCore; w: string; bin: string; trash: (p: string) => Promise<void> }> => {
    const root = tempDir()
    const w = join(root, 'RJ01000030 作品')
    tree(w, files)
    const core = new EnvCore(':memory:')
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const bin = tempDir()
    return { core, w, bin, trash: async (p) => renameSync(p, join(bin, basename(p))) }
  }

  it('a cut-off mp3 is not taken for a copy of the wav', async () => {
    const { core, w } = await setup({ 'a.mp3': xingMp3(2), 'a.wav': wav(2), 'b.mp3': xingMp3(2, 0.5), 'b.wav': wav(2) })
    const plan = await core.planWav(null).done
    expect(plan.find((p) => p.wav.endsWith('a.wav'))?.kind).toBe('delete') // whole file: fine
    expect(plan.find((p) => p.wav.endsWith('b.wav'))?.kind).toBe('skip') // half of it: wav stays
    expect(existsSync(join(w, 'b.wav'))).toBe(true)
    core.close()
  })

  it('checks again when it runs: mp3 gone or shorter, wav changed → the wav stays', async () => {
    const { core, w, bin, trash } = await setup({ 'a.mp3': mp3(2), 'a.wav': wav(2), 'b.mp3': mp3(2), 'b.wav': wav(2), 'c.mp3': mp3(2), 'c.wav': wav(2), 'd.wav': wav(1) })
    const plan = await core.planWav(null).done
    expect(plan.filter((p) => p.kind === 'delete')).toHaveLength(3)
    rmSync(join(w, 'a.mp3')) // deleted after 확인하기
    tree(w, { 'b.mp3': mp3(0.5) }) // replaced by a shorter one
    tree(w, { 'c.wav': wav(3), 'd.wav': wav(2) }) // wavs changed
    const r = await core.runWav(plan, trash).done
    expect(r.done).toBe(0)
    expect(r.failed).toHaveLength(4)
    for (const f of ['a.wav', 'b.wav', 'c.wav', 'd.wav']) expect(existsSync(join(w, f))).toBe(true)
    expect(existsSync(join(w, 'd.mp3'))).toBe(false)
    expect(readdirSync(bin)).toEqual([])
    core.close()
  })

  it('no Recycle Bin (network drive): the wav goes to "_wav 삭제 대기" in its library folder, which scans skip', async () => {
    const { core, w } = await setup({ 'mp3/a.mp3': mp3(2), 'mp3/a.wav': wav(2), 'b.wav': wav(1) })
    const root = dirname(w)
    tree(join(root, '_wav 삭제 대기', 'RJ01000030 作品', 'mp3'), { 'a.wav': wav(1) }) // a name already taken there
    const plan = await core.planWav(null).done
    const r = await core.runWav(plan, async () => {
      throw new Error('Failed to perform delete operation')
    }).done
    expect(r).toMatchObject({ ok: true, done: 2 })
    expect(r.message).toContain('_wav 삭제 대기')
    const hold = join(root, '_wav 삭제 대기', 'RJ01000030 作品')
    expect(existsSync(join(hold, 'mp3', 'a (2).wav'))).toBe(true) // next to the one there before
    expect(existsSync(join(hold, 'b.wav'))).toBe(true)
    expect(existsSync(join(w, 'mp3', 'a.wav'))).toBe(false)
    expect(existsSync(join(w, 'b.mp3'))).toBe(true) // converted
    await core.runScan().done
    expect(core.works().map((x) => x.title)).toEqual(['作品']) // the holding folder isn't a work
    core.close()
  }, 30000)

  it('when the wav can be neither trashed nor moved it stays', async () => {
    const { core, w } = await setup({ 'a.mp3': mp3(2), 'a.wav': wav(2) })
    const plan = await core.planWav(null).done
    core.saveSettings({ libraryDirs: [] })
    await core.runScan().done // the work is gone from the DB: no library folder to move into
    const r = await core.runWav(plan, async () => {
      throw new Error('no')
    }).done
    expect(r.done).toBe(0)
    expect(existsSync(join(w, 'a.wav'))).toBe(true)
    core.close()
  })
})

describe('wav 정리 across folders of a work (mp3/ · wav/)', () => {
  it('deletes a wav only when an mp3 elsewhere is certainly the same audio; anything less certain is converted', async () => {
    const root = tempDir()
    const a = join(root, 'RJ01000040 SE 있음 없음')
    tree(a, {
      'mp3/SEあり/01_話.mp3': mp3(2),
      'mp3/SEなし/01_話.mp3': mp3(2),
      'wav/SEあり/01_話.wav': wav(2), // ↔ mp3/SEあり: same track, SE on both → delete
      'wav/SEなし/01_話.wav': wav(2), // ↔ mp3/SEなし → delete (never the SEあり one)
      'wav/SEなし/02_話.wav': wav(3), // mp3/SEなし/02 is shorter → convert
      'mp3/SEなし/02_話.mp3': mp3(1)
    })
    const b = join(root, 'RJ01000041 SE 모름')
    tree(b, { 'MP3/01_話.mp3': mp3(2), 'WAV/01_話.wav': wav(2) }) // SE unknown → convert
    const c = join(root, 'RJ01000042 후보 둘')
    tree(c, { 'mp3/SEあり/01_話.mp3': mp3(2), 'mp3_2/SEあり/01_話.mp3': mp3(2), 'wav/SEあり/01_話.wav': wav(2) }) // two candidates → convert
    const d = join(root, 'RJ01000043 SE 추측')
    tree(d, { '本篇/mp3/01_話.mp3': mp3(2), '本篇/wav/01_話.wav': wav(2), 'SEなし/01_話.mp3': mp3(2) }) // SE of 本篇 only guessed → convert
    const core = new EnvCore(':memory:')
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const plan = await core.planWav(null).done
    const item = (p: string) => plan.find((x) => x.wav === p)!
    expect(item(join(a, 'wav/SEあり/01_話.wav'))).toMatchObject({ kind: 'delete', mp3: join(a, 'mp3/SEあり/01_話.mp3') })
    expect(item(join(a, 'wav/SEなし/01_話.wav'))).toMatchObject({ kind: 'delete', mp3: join(a, 'mp3/SEなし/01_話.mp3') })
    expect(item(join(a, 'wav/SEなし/02_話.wav')).kind).toBe('convert')
    expect(item(join(b, 'WAV/01_話.wav')).kind).toBe('convert')
    expect(item(join(c, 'wav/SEあり/01_話.wav')).kind).toBe('convert')
    expect(item(join(d, '本篇/wav/01_話.wav')).kind).toBe('convert')

    const bin = tempDir()
    const r = await core.runWav(plan.filter((x) => x.kind === 'delete'), async (p) => renameSync(p, join(bin, basename(p) + Math.random()))).done
    expect(r).toMatchObject({ ok: true, done: 2 })
    expect(existsSync(join(a, 'wav/SEあり/01_話.wav'))).toBe(false)
    expect(existsSync(join(a, 'mp3/SEあり/01_話.mp3'))).toBe(true)
    core.close()
  })
})
