// 중복 작품: groups by code / title, 중복 아님, 따로 두기 and its undo.
import { existsSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvCore } from '../src/core'
import { DUP_DIR, titleKey } from '../src/core/dupes'
import { cleanup, mp3, tempDir, tree, wav } from './helpers'

afterEach(cleanup)

describe('중복 작品', () => {
  it('folds titles', () => {
    expect(titleKey('[サークル] 癒やしの耳かき (CV:誰か)')).toBe(titleKey('癒やしの 耳かき！'))
    expect(titleKey('abc')).toBeNull()
  })

  it('groups the same code / title, suggests the fuller copy, sets aside and undoes', async () => {
    const root = tempDir()
    tree(root, {
      'RJ01234567 癒やし/01.mp3': mp3(1),
      'RJ01234567 癒やし/02.mp3': mp3(1),
      'circle/RJ01234567/01.wav': wav(1),
      'RJ07654321 別/01.mp3': mp3(1),
      '耳かきボイス 完全版/01.mp3': mp3(1),
      '[サークル] 耳かきボイス 完全版/01.mp3': mp3(1)
    })
    const core = new EnvCore(':memory:')
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const groups = core.duplicates()
    expect(groups.map((g) => g.label).sort()).toEqual(['RJ01234567', '耳かきボイス 完全版'].sort())
    const rj = groups.find((g) => g.key === 'RJ01234567')!
    const works = core.works()
    const pathOf = (id: number): string => works.find((w) => w.id === id)!.path
    expect(pathOf(rj.members[0].id)).toBe(join(root, 'RJ01234567 癒やし')) // 2 tracks > 1
    expect(rj.members[1].formats).toEqual(['.wav'])

    // 중복 아님 hides the title group (and its undo shows it again)
    const tg = groups.find((g) => g.key.startsWith('title:'))!
    core.notDuplicate(
      tg.key,
      tg.members.map((m) => m.id),
      tg.label
    )
    expect(core.duplicates().map((g) => g.key)).toEqual(['RJ01234567'])
    await core.log.undo()
    expect(core.duplicates()).toHaveLength(2)

    // 따로 두기: the other copy moves to <root>/_중복 작품 and leaves the library
    const items = core.planSetAside([rj.members[1].id])
    expect(items[0].to).toBe(join(root, DUP_DIR, 'RJ01234567'))
    const r = await core.runSetAside(items).done
    expect(r.done).toBe(1)
    expect(existsSync(join(root, DUP_DIR, 'RJ01234567', '01.wav'))).toBe(true)
    await core.runScan().done
    expect(core.works().some((w) => w.path.includes(DUP_DIR))).toBe(false)
    expect(core.duplicates().map((g) => g.key)).not.toContain('RJ01234567')
    expect(core.history().some((h) => h.kind === 'dups')).toBe(true)

    // 되돌리기: back where it was, found again by the next scan
    await core.log.undo()
    expect(existsSync(join(root, 'circle', 'RJ01234567', '01.wav'))).toBe(true)
    await core.runScan().done
    expect(core.duplicates().map((g) => g.key)).toContain('RJ01234567')
    core.close()
  })
})
