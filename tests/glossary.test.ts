import { writeFileSync } from 'fs'
import { join } from 'path'
import iconv from 'iconv-lite'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvCore } from '../src/core'
import { mergeGlossary, parseGlossaryText } from '../src/core/glossaryText'
import { cleanup, tempDir } from './helpers'

afterEach(cleanup)

describe('용어집 from a text document', () => {
  it('reads the usual ways of writing a pair, skipping headers and noise', () => {
    const text = [
      '# 캐릭터 이름',
      'お兄ちゃん → 오빠',
      'ご主人様 -> 주인님',
      '先輩 = 선배',
      'メスガキ: 메스가키',
      '魔法少女\t마법소녀',
      '妹, 여동생',
      '- 「アオイ」 → 아오이',
      '1. 先生 => 선생님',
      '',
      '| 원문 | 번역 |',
      '| --- | --- |',
      '| 姉 | 누나 |',
      '번역만 있는 줄'
    ].join('\n')
    expect(parseGlossaryText(text)).toEqual([
      { source: 'お兄ちゃん', target: '오빠' },
      { source: 'ご主人様', target: '주인님' },
      { source: '先輩', target: '선배' },
      { source: 'メスガキ', target: '메스가키' },
      { source: '魔法少女', target: '마법소녀' },
      { source: '妹', target: '여동생' },
      { source: 'アオイ', target: '아오이' },
      { source: '先生', target: '선생님' },
      { source: '姉', target: '누나' }
    ])
  })

  it('merges: new pairs added, the same source takes the new translation', () => {
    const r = mergeGlossary(
      [
        { source: 'お兄ちゃん', target: '오라버니' },
        { source: '先輩', target: '선배' }
      ],
      [
        { source: 'お兄ちゃん', target: '오빠' },
        { source: '先輩', target: '선배' },
        { source: '妹', target: '여동생' }
      ]
    )
    expect(r).toMatchObject({ added: 1, changed: 1 })
    expect(r.entries).toEqual([
      { source: 'お兄ちゃん', target: '오빠' },
      { source: '先輩', target: '선배' },
      { source: '妹', target: '여동생' }
    ])
  })

  it('imports a file (any text encoding) into the common glossary', async () => {
    const dir = tempDir()
    const f = join(dir, 'glossary.txt')
    writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('お兄ちゃん → 오빠\n先輩 = 선배\n', 'utf16-le')])) // Notepad's "Unicode"
    writeFileSync(join(dir, 'sjis.txt'), iconv.encode('姉 = あね\n', 'shift_jis'))
    writeFileSync(join(dir, 'g.md'), '| 원문 | 번역 |\n|---|---|\n| 妹 | 여동생 |\n')
    const core = new EnvCore(':memory:')
    expect((await core.importGlossary(null, f)).ok).toBe(true)
    expect((await core.importGlossary(null, join(dir, 'g.md'))).message).toContain('1개 더함')
    expect((await core.importGlossary(null, join(dir, 'sjis.txt'))).ok).toBe(true)
    expect(core.glossaryOwn(null).map((e) => e.source)).toEqual(['お兄ちゃん', '先輩', '妹', '姉'])
    writeFileSync(join(dir, 'empty.txt'), '아무 것도 없음\n')
    expect((await core.importGlossary(null, join(dir, 'empty.txt'))).ok).toBe(false)
    core.close()
  })
})
