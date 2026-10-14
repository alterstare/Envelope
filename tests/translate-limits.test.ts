import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/core'
import { TRANSLATE, TranslateStop, answerTokens, googleTranslator, llmTranslator, parseWait, translateLines } from '../src/core/translate'

const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('번역 엔진 한도', () => {
  it('reads waits the way providers write them', () => {
    expect(parseWait('12')).toBe(12)
    expect(parseWait('7.5s')).toBe(7.5)
    expect(parseWait('1m2.5s')).toBe(62.5)
    expect(parseWait('2h3m')).toBe(7380)
    expect(parseWait(null)).toBeNull()
  })

  it('asks for answer room that fits the lines, not 8 K', () => {
    expect(answerTokens(['おはよう', 'おやすみ'])).toBeLessThan(300)
    expect(answerTokens(new Array(40).fill('あ'.repeat(30)))).toBeLessThanOrEqual(TRANSLATE.maxAnswerTokens)
  })

  it('Google: many lines in one request, one at a time', async () => {
    TRANSLATE.googleGapMs = 0
    const urls: string[] = []
    const tr = googleTranslator(async (url) => {
      urls.push(url)
      const q = decodeURIComponent(new URL(url).searchParams.get('q')!)
      return json([[[q.split('\n').map((l) => `KO:${l}`).join('\n'), q]]])
    })
    const lines = ['おはよう', '', 'おやすみ', 'またね']
    const out = await translateLines(lines, tr, { kind: 'name', glossary: [] })
    expect(out).toEqual(['KO:おはよう', '', 'KO:おやすみ', 'KO:またね'])
    expect(urls.length).toBe(1)
  })

  it('Google: a block stops the job — no second endpoint, no retries', async () => {
    TRANSLATE.googleGapMs = 0
    let calls = 0
    const tr = googleTranslator(async () => {
      calls++
      return new Response('<html>Our systems have detected unusual traffic</html>', { status: 429 })
    })
    await expect(translateLines(['あ', 'い'], tr, { kind: 'name', glossary: [] })).rejects.toBeInstanceOf(TranslateStop)
    expect(calls).toBe(1)
  })

  it('LLM: waits what a 429 says and goes on; a daily limit stops', async () => {
    const s = { ...DEFAULT_SETTINGS, translator: 'llm' as const, llmProvider: 'groq' as const, llmApiKey: 'k', llmModel: 'qwen/qwen3.8-27b' }
    const bodies: { max_tokens: number; reasoning_effort?: string }[] = []
    let n = 0
    const waits: number[] = []
    const ok = llmTranslator(s, async (_u, init) => {
      bodies.push(JSON.parse(String(init!.body)))
      if (n++ === 0) return json({ error: { message: 'Rate limit reached … tokens per minute (TPM). Please try again in 0.05s' } }, 429)
      return json({ choices: [{ message: { content: '<think>…</think>[{"id":1,"ko":"안녕"}]' } }] })
    })
    expect(await translateLines(['こんにちは'], ok, { kind: 'name', glossary: [], onWait: (w) => waits.push(w) })).toEqual(['안녕'])
    expect(n).toBe(2)
    expect(waits.some((w) => w > 0)).toBe(true)
    expect(bodies[0].reasoning_effort).toBe('none')
    expect(bodies[0].max_tokens).toBeLessThan(1000)

    let m = 0
    const daily = llmTranslator(s, async () => {
      m++
      return json({ error: { message: 'Rate limit reached on tokens per day (TPD). Please try again in 41m12s' } }, 429)
    })
    await expect(translateLines(['あ', 'い'], daily, { kind: 'name', glossary: [] })).rejects.toThrow(/하루 사용 한도/)
    expect(m).toBe(1)
  })
})
