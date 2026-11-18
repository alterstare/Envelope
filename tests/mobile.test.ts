import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvCore } from '../src/core'
import { EDITS_FORMAT, PACK_EDITS, PACK_FILE } from '../src/shared/mobilePack'
import type { MobileEditFile, MobilePack } from '../src/shared/mobilePack'
import { relOf } from '../src/core/mobile'
import { cleanup, mp3, tempDir, tree } from './helpers'

afterEach(cleanup)

async function setup(): Promise<{ core: EnvCore; root: string; id: number }> {
  const root = tempDir()
  tree(root, {
    'RJ01234567 テスト/01.mp3': mp3(1),
    'RJ01234567 テスト/02.mp3': mp3(1),
    'RJ01234567 テスト/01.ja.vtt': Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nこんにちは\n')
  })
  const core = new EnvCore(':memory:')
  core.saveSettings({ libraryDirs: [root], mobileShare: true })
  await core.runScan().done
  return { core, root, id: core.works()[0].id }
}

const readPack = (root: string): MobilePack => JSON.parse(gunzipSync(readFileSync(join(root, PACK_FILE))).toString()) as MobilePack

describe('모바일 공유', () => {
  it('names files relative to the library folder', () => {
    expect(relOf('C:\\lib', 'C:\\lib\\RJ1 a\\01.mp3')).toBe('RJ1 a/01.mp3')
    expect(relOf('C:\\lib\\', 'c:\\LIB\\w|RJ01234567')).toBe('w|RJ01234567')
    expect(relOf('C:\\lib', 'C:\\library\\x')).toBeNull()
  })

  it('writes the pack with the works and what the user did', async () => {
    const { core, root, id } = await setup()
    core.setFavorite([id], true)
    core.createGroup('잠잘 때', [id])
    const g = core.work(id)!.groups[0]
    core.saveProgress({ workId: id, groupKey: g.key, position: 42 })
    core.addBookmark(id, g.key, 10, '여기')
    const d = core.mobileDraft(root)
    await core.writeMobilePack(d, 'test')
    const p = readPack(root)
    expect(p.works).toHaveLength(1)
    const w = p.works[0]
    expect(w.rel).toBe('RJ01234567 テスト')
    expect(w.tracks.map((t) => t.rel).sort()).toEqual(['RJ01234567 テスト/01.mp3', 'RJ01234567 テスト/02.mp3'])
    expect(w.tracks.find((t) => t.rel.endsWith('01.mp3'))!.subs[0].rel).toBe('RJ01234567 テスト/01.ja.vtt')
    expect(w.favorite).toBe(true)
    expect(w.groups).toEqual(['잠잘 때'])
    expect(w.progress[g.key].position).toBe(42)
    expect(w.bookmarks[0]).toMatchObject({ groupKey: g.key, position: 10, name: '여기' })
    // unchanged library → same hash (the host writes only when it changes)
    expect(core.mobileDraft(root).hash).toBe(d.hash)
  })

  it('applies the phone changes and deletes their file', async () => {
    const { core, root, id } = await setup()
    const g = core.work(id)!.groups[0]
    core.saveProgress({ workId: id, groupKey: g.key, position: 5 })
    core.addBookmark(id, g.key, 10, '지울 것')
    const now = Date.now() + 1000
    const file: MobileEditFile = {
      format: EDITS_FORMAT,
      version: 1,
      device: 'phone',
      createdAt: now,
      basedOn: 0,
      edits: [
        { op: 'work', at: now, work: 'RJ01234567 テスト', set: { favorite: true, rank: 4, groups: ['출퇴근'] } },
        { op: 'progress', at: now, work: 'RJ01234567 テスト', groupKey: g.key, position: 30, duration: null },
        { op: 'progress', at: 1, work: 'RJ01234567 テスト', groupKey: g.key, position: 99, duration: null }, // older: ignored
        { op: 'offset', at: now, work: 'RJ01234567 テスト', groupKey: g.key, offset: 0.3 },
        { op: 'bookmark', at: now, work: 'RJ01234567 テスト', action: 'delete', groupKey: g.key, position: 10.2 },
        { op: 'bookmark', at: now, work: 'RJ01234567 テスト', action: 'add', groupKey: g.key, position: 20, name: '폰' },
        { op: 'play', at: now, work: 'RJ01234567 テスト' },
        { op: 'work', at: now, work: '없는 작품', set: { favorite: true } }
      ]
    }
    mkdirSync(join(root, PACK_EDITS), { recursive: true })
    const f = join(root, PACK_EDITS, `phone-${now}.json`)
    writeFileSync(f, JSON.stringify(file))
    expect(await core.applyMobileEdits(root)).toBeGreaterThan(0)
    expect(existsSync(f)).toBe(false)
    const w = core.work(id)!
    const sum = core.works()[0]
    expect(sum.favorite).toBe(true)
    expect(sum.rank).toBe(4)
    expect(sum.plays).toBe(1)
    expect(core.groups().map((x) => x.name)).toEqual(['출퇴근'])
    const g2 = w.groups.find((x) => x.key === g.key)!
    expect(g2.position).toBe(30)
    expect(g2.subOffset).toBe(0.3)
    expect(w.bookmarks.map((b) => b.name)).toEqual(['폰'])
  })
})
