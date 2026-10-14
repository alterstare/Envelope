import { existsSync, readFileSync } from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvCore } from '../src/core'
import { fetchDlsite } from '../src/core/dlsite'
import { cleanup, mp3, tempDir, tree } from './helpers'

afterEach(cleanup)

const FAKE: Record<string, unknown> = {
  RJ01000030: [
    {
      work_name: '作品のタイトル',
      maker_name: 'サークル',
      creaters: { voice_by: [{ name: '声優A' }, { name: '声優B' }] },
      image_main: { url: '//img.dlsite.jp/x/RJ01000030_img_main.jpg' }
    }
  ],
  RJ01000031: []
}
const get = async (url: string): Promise<unknown> => FAKE[new URL(url).searchParams.get('workno')!] ?? []
const bytes = async (): Promise<Buffer> => Buffer.from('jpeg')

describe('DLsite', () => {
  it('reads title, circle, voices and cover; unknown codes give null', async () => {
    expect(await fetchDlsite('rj01000030', get)).toEqual({
      code: 'RJ01000030',
      title: '作品のタイトル',
      circle: 'サークル',
      voices: ['声優A', '声優B'],
      image: 'https://img.dlsite.jp/x/RJ01000030_img_main.jpg'
    })
    expect(await fetchDlsite('RJ01000031', get)).toBeNull()
    expect(await fetchDlsite('not-a-code', get)).toBeNull()
  })

  it('names a work whose folder is only its code, saves the cover in the data folder', async () => {
    const root = tempDir()
    tree(root, { 'RJ01000030/01.mp3': mp3(1), 'RJ01000031 フォルダ名/01.mp3': mp3(1) })
    const core = new EnvCore(tempDir(), { dlsiteGet: get, dlsiteBytes: bytes })
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const a = core.works().find((w) => w.code === 'RJ01000030')!
    expect(a.title).toBe('RJ01000030')
    expect(core.codeOnlyWorks()).toContain(a.id) // code-only name (and no picture)
    expect(await core.runDlsite(null).done).toEqual({ found: 1, missing: 1, failed: 0 })
    const w = core.works().find((x) => x.id === a.id)!
    expect(w).toMatchObject({ title: '作品のタイトル', folderTitle: 'RJ01000030', circle: 'サークル', voices: ['声優A', '声優B'] })
    expect(w.cover?.startsWith(core.paths.coversDir)).toBe(true)
    expect(existsSync(w.cover!) && readFileSync(w.cover!, 'utf8')).toBe('jpeg')
    expect(core.work(a.id)!.images).toEqual([w.cover])
    expect(core.works().find((x) => x.code === 'RJ01000031')!.title).toBe('フォルダ名') // nothing found → folder name
    expect(core.codeOnlyWorks()).toEqual([])
    await core.runScan().done // a rescan keeps what DLsite said
    expect(core.work(a.id)!.dlTitle).toBe('作品のタイトル')
    core.close()
  })
})
