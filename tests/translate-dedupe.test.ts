import { describe, expect, it } from 'vitest'
import { TRANSLATE, dedupable, dedupeKey, isSoundWord, translateLines } from '../src/core/translate'
import type { Translator } from '../src/core/translate'

function fake(): { tr: Translator; calls: { lines: string[]; before: string[]; after: string[] }[] } {
  const calls: { lines: string[]; before: string[]; after: string[] }[] = []
  const tr: Translator = {
    id: 'fake',
    llm: true,
    translate: async (lines, before, after) => (calls.push({ lines, before, after }), lines.map((l) => 'KO ' + l))
  }
  return { tr, calls }
}

describe('같은 줄 빼기', () => {
  it('judges which repeats may share a translation', () => {
    expect(dedupeKey('  あっ……！！ ')).toBe('あっ…!')
    expect(dedupeKey('ん〜〜')).toBe(dedupeKey('ん～'))
    for (const s of ['あっ', 'んっ…', 'はぁ…はぁ…', 'ちゅっ', 'うぅ', 'おおお'] as const) expect(isSoundWord(dedupeKey(s))).toBe(true)
    for (const s of ['はい', 'いいよ', 'ほら', 'うん', 'お兄ちゃん'] as const) expect(dedupable(dedupeKey(s))).toBe(false)
    expect(dedupable('(泣)')).toBe(true) // stage direction
    expect(dedupable('今日はずっと一緒にいようね')).toBe(true) // 8+ characters
  })

  it('sends a repeated line once and copies its translation; short words still go each time', async () => {
    const { tr, calls } = fake()
    const lines = ['あっ…', 'はい', 'お兄ちゃん、おかえりなさい', 'あっ……', 'はい', '(泣)', 'お兄ちゃん、おかえりなさい', '(泣)']
    const out = await translateLines(lines, tr, { kind: 'subtitle', glossary: [] }, undefined, { dedupe: true })
    expect(calls.flatMap((c) => c.lines)).toEqual(['あっ…', 'はい', 'お兄ちゃん、おかえりなさい', 'はい', '(泣)'])
    expect(out).toEqual(['KO あっ…', 'KO はい', 'KO お兄ちゃん、おかえりなさい', 'KO あっ…', 'KO はい', 'KO (泣)', 'KO お兄ちゃん、おかえりなさい', 'KO (泣)'])
  })

  it('tells after each request how far the lines are final, repeats included', async () => {
    const old = TRANSLATE.batch
    TRANSLATE.batch = 2
    try {
      const { tr } = fake()
      const seen: [number, string[]][] = []
      // sent: 0 1 | 3 ; line 2 repeats line 0, line 4 repeats line 1
      const lines = ['(泣)', 'お兄ちゃん、おかえりなさい', '(泣)', 'はい', 'お兄ちゃん、おかえりなさい']
      await translateLines(lines, tr, { kind: 'subtitle', glossary: [] }, undefined, {
        dedupe: true,
        onDone: (upTo, out) => void seen.push([upTo, out.slice(0, upTo)])
      })
      expect(seen).toEqual([
        [3, ['KO (泣)', 'KO お兄ちゃん、おかえりなさい', 'KO (泣)']],
        [5, ['KO (泣)', 'KO お兄ちゃん、おかえりなさい', 'KO (泣)', 'KO はい', 'KO お兄ちゃん、おかえりなさい']]
      ])
    } finally {
      TRANSLATE.batch = old
    }
  })

  it('without dedupe every line goes out', async () => {
    const { tr, calls } = fake()
    await translateLines(['あっ', 'あっ'], tr, { kind: 'subtitle', glossary: [] })
    expect(calls[0].lines).toEqual(['あっ', 'あっ'])
  })

  it('tracks share a request, but context stops at a track boundary', async () => {
    const { tr, calls } = fake()
    // track 1: a b c, track 2: d e — one request, nothing from track 1 as context of track 2
    await translateLines(['a1', 'b1', 'c1', 'd2', 'e2'], tr, { kind: 'subtitle', glossary: [] }, undefined, { breaks: [0, 3] })
    expect(calls.length).toBe(1)
    expect(calls[0].before).toEqual([])
    expect(calls[0].after).toEqual([])

    // split at the boundary: track 1's request gets no context from track 2, and back
    const old = TRANSLATE.batch
    TRANSLATE.batch = 3
    try {
      const f = fake()
      await translateLines(['a1', 'b1', 'c1', 'd2', 'e2'], f.tr, { kind: 'subtitle', glossary: [] }, undefined, { breaks: [0, 3] })
      expect(f.calls.map((c) => [c.lines, c.before, c.after])).toEqual([
        [['a1', 'b1', 'c1'], [], []],
        [['d2', 'e2'], [], []]
      ])
      const g = fake()
      await translateLines(['a1', 'b1', 'c1', 'd1', 'e1'], g.tr, { kind: 'subtitle', glossary: [] })
      expect(g.calls[0].after).toEqual(['d1', 'e1']) // one track: context as before
    } finally {
      TRANSLATE.batch = old
    }
  })
})
