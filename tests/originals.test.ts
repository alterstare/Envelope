import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvCore } from '../src/core'
import { ORIGINALS_FILE } from '../src/core/originals'
import { cleanup, mp3, tempDir, toMojibake, tree } from './helpers'

afterEach(cleanup)

const vtt = (text: string): string => `WEBVTT\n\n00:00.000 --> 00:01.000\n${text}\n`

async function setup(opts: { folder?: boolean } = {}) {
  const root = tempDir()
  const w = join(root, 'RJ01000030 お兄ちゃん作品')
  tree(w, {
    'mp3/01_はじめに.mp3': mp3(1),
    'mp3/02_おやすみ.mp3': mp3(2),
    [`${toMojibake('特典')}/03_${toMojibake('おまけ')}.mp3`]: mp3(1)
  })
  writeFileSync(join(w, 'mp3', '01_はじめに.ja.vtt'), vtt('はじめまして'))
  const data = tempDir()
  const core = new EnvCore(data)
  core.saveSettings({ libraryDirs: [root], originalsInFolder: opts.folder ?? true })
  await core.runScan().done
  const id = core.works()[0].id
  return { root, w, core, id, data }
}

// translate names (as 이름 번역 would) and rename to them
async function renameTranslated(core: EnvCore, id: number, w: string): Promise<string> {
  const put = core.db.prepare('INSERT OR REPLACE INTO names (path, translated, engine, updated_at) VALUES (?, ?, ?, ?)')
  put.run(w, '오빠 작품', 'test', 0)
  put.run(join(w, 'mp3', '01_はじめに.mp3'), '01_처음에', 'test', 0)
  put.run(join(w, 'mp3', '02_おやすみ.mp3'), '02_잘자', 'test', 0)
  const plan = await core.planRename([id], 'translate').done
  expect((await core.runRename(plan).done).ok).toBe(true)
  return core.work(id)!.path
}

describe('원래 이름 기록', () => {
  it('records names (뷁어 as its repaired Japanese) and Japanese subtitles at the first scan', async () => {
    const { core, id } = await setup()
    const rec = JSON.parse((core.db.prepare('SELECT json FROM originals WHERE work_id = ?').get(id) as { json: string }).json)
    expect(rec.work.folder).toBe('RJ01000030 お兄ちゃん作品')
    const origs = rec.entries.map((e: { orig: string }) => e.orig).sort()
    expect(origs).toContain('mp3/01_はじめに.mp3')
    expect(origs).toContain('特典/03_おまけ.mp3') // repaired, not the broken name
    expect(rec.subs).toEqual([{ file: 'mp3/01_はじめに.mp3', lang: 'ja', vtt: expect.stringContaining('はじめまして') }])
    core.close()
  })

  it('leaves the record in the folder with a folder change, and renames back to the originals', async () => {
    const { core, id, w } = await setup()
    expect(existsSync(join(w, ORIGINALS_FILE))).toBe(false) // a scan alone writes nothing into the folder
    const now = await renameTranslated(core, id, w)
    expect(now).not.toBe(w)
    expect(readdirSync(join(now, 'mp3')).sort()).toContain('01_처음에.mp3')
    // left in the (renamed) work folder, never renamed itself
    const file = JSON.parse(readFileSync(join(now, ORIGINALS_FILE), 'utf8'))
    expect(file.entries.find((e: { orig: string }) => e.orig === 'mp3/01_はじめに.mp3').cur).toBe('mp3/01_처음에.mp3')

    const back = await core.planRename([id], 'original').done
    expect(back.every((x) => x.original)).toBe(true)
    await core.runRename(back).done
    expect(core.work(id)!.path).toBe(w)
    expect(readdirSync(join(w, 'mp3')).sort()).toEqual(['01_はじめに.ja.vtt', '01_はじめに.mp3', '02_おやすみ.mp3'].sort())
    expect(existsSync(join(w, '特典', '03_おまけ.mp3'))).toBe(true) // the repaired Japanese
    core.close()
  })

  it('finds files renamed elsewhere by size and date', async () => {
    const { core, id, w } = await setup()
    renameSync(join(w, 'mp3', '02_おやすみ.mp3'), join(w, 'mp3', '02_renamed.mp3'))
    await core.runScan().done
    const back = await core.planRename([id], 'original').done
    expect(back.find((x) => x.from.endsWith('02_renamed.mp3'))?.to).toBe(join(w, 'mp3', '02_おやすみ.mp3'))
    core.close()
  })

  it('reads the record back from the work folder when the program has none (a new install)', async () => {
    const { core, id, w, root } = await setup()
    const now = await renameTranslated(core, id, w)
    core.close()
    const fresh = new EnvCore(tempDir())
    fresh.saveSettings({ libraryDirs: [root] })
    await fresh.runScan().done
    const id2 = fresh.works()[0].id
    expect(fresh.work(id2)!.path).toBe(now)
    const back = await fresh.planRename([id2], 'original').done
    expect(back.find((x) => x.work)?.to).toBe(w)
    fresh.close()
  })

  it('does not write into the folder when turned off', async () => {
    const { core, id, w } = await setup({ folder: false })
    const now = await renameTranslated(core, id, w)
    expect(existsSync(join(now, ORIGINALS_FILE))).toBe(false)
    expect((await core.planRename([id], 'original').done).length).toBeGreaterThan(0) // still kept in the program
    core.close()
  })

  it('brings the recorded Japanese subtitles back into the program, undoably', async () => {
    const { core, id } = await setup()
    const track = core.work(id)!.groups.find((g) => g.title.includes('01'))!
    await core.saveSubtitle(track.chosen, 'ja', [{ start: 0, end: 1, text: '書き直した' }])
    const r = await core.restoreSubs([id]).done
    expect(r.done).toBe(1)
    const ja = core.work(id)!.groups.find((g) => g.key === track.key)!.versions[0].subs.find((s) => s.lang === 'ja')!
    expect((await core.readSubtitle(ja.path)).cues[0].text).toBe('はじめまして')
    expect((await core.restoreSubs([id]).done).done).toBe(0) // same as now: nothing to do
    await core.log.undo()
    expect((await core.readSubtitle(ja.path)).cues[0].text).toBe('書き直した')
    core.close()
  })
})
