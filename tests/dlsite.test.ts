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
      image_main: { url: '//img.dlsite.jp/x/RJ01000030_img_main.jpg' },
      options: 'JPN#SND',
      genres: [
        { name: '최면', name_base: '催眠' },
        { name: '연속 절정', name_base: '連続絶頂' }
      ]
    }
  ],
  RJ01000031: []
}
const asked: string[] = []
const get = async (url: string): Promise<unknown> => (asked.push(url), FAKE[new URL(url).searchParams.get('workno')!] ?? [])
const bytes = async (): Promise<Buffer> => Buffer.from('jpeg')

describe('DLsite', () => {
  it('reads title, circle, voices and cover; unknown codes give null', async () => {
    expect(await fetchDlsite('rj01000030', get)).toEqual({
      code: 'RJ01000030',
      title: '作品のタイトル',
      circle: 'サークル',
      voices: ['声優A', '声優B'],
      image: 'https://img.dlsite.jp/x/RJ01000030_img_main.jpg',
      lang: 'ja',
      tags: [
        { ko: '최면', ja: '催眠' },
        { ko: '연속 절정', ja: '連続絶頂' }
      ]
    })
    expect(new URL(asked[0]).searchParams.get('locale')).toBe('ko_KR') // Korean tag names
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
    expect(w.tags.map((t) => t.ko)).toEqual(['최면', '연속 절정'])
    expect(core.work(a.id)!.tags.map((t) => t.ja)).toEqual(['催眠', '連続絶頂'])
    expect(w.cover?.startsWith(core.paths.coversDir)).toBe(true)
    expect(existsSync(w.cover!) && readFileSync(w.cover!, 'utf8')).toBe('jpeg')
    expect(core.work(a.id)!.images).toEqual([w.cover])
    expect(core.works().find((x) => x.code === 'RJ01000031')!.title).toBe('フォルダ名') // nothing found → folder name
    expect(core.codeOnlyWorks()).toEqual([])
    await core.runScan().done // a rescan keeps what DLsite said
    expect(core.work(a.id)!.dlTitle).toBe('作品のタイトル')
    // asked before tags were kept → asked again by "not asked yet"
    core.db.prepare('UPDATE works SET dl_tags = NULL WHERE id = ?').run(a.id)
    expect(await core.runDlsite(null).done).toMatchObject({ found: 1 })
    expect(core.works().find((x) => x.id === a.id)!.tags.length).toBe(2)
    core.close()
  })
})

describe('release language', () => {
  it('a Korean folder name is not a Korean release; DLsite and 【한국어 자막판】 say what it is', async () => {
    const LANGS: Record<string, unknown> = {
      RJ01000040: [{ work_name: '日本語の作品', options: 'JPN#SND' }],
      RJ01000041: [{ work_name: '번역판', options: 'SND#KO_KR', translation_info: { lang: 'KO_KR' } }],
      RJ01000042: [{ work_name: '한국 작품', options: 'SND#KO_KR', translation_info: { lang: null } }]
    }
    const getL = async (url: string): Promise<unknown> => LANGS[new URL(url).searchParams.get('workno')!] ?? []
    const root = tempDir()
    tree(root, {
      'RJ01000040 한국어로 바꾼 폴더 이름/01.mp3': mp3(1),
      'RJ01000041 번역판/01.mp3': mp3(1),
      'RJ01000042 한국 작품/01.mp3': mp3(1),
      '【한국어 자막판】 표시만 있는 작품/01.mp3': mp3(1)
    })
    const core = new EnvCore(tempDir(), { dlsiteGet: getL, dlsiteBytes: bytes })
    core.saveSettings({ libraryDirs: [root] })
    await core.runScan().done
    const lang = (code: string | null): string => core.works().find((w) => w.code === code)!.lang
    expect(lang('RJ01000040')).toBe('ja') // Korean name, but nothing says it's a Korean release
    expect(lang(null)).toBe('ko-sub') // the marker
    await core.runDlsite(null).done
    expect(lang('RJ01000040')).toBe('ja')
    expect(lang('RJ01000041')).toBe('ko-sub') // DLsite: a Korean translation
    expect(lang('RJ01000042')).toBe('ko-voice') // DLsite: a Korean original
    core.close()
  })
})
