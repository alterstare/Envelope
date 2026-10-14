// Diagnosis helper (ENV_DIAG=1): how a whole script without headings splits
// over the tracks, from the large-model transcripts cached in a test env.db.
//   ENV_DIAG=1 ENV_DIAG_DB=…/env.db ENV_DIAG_SCRIPT=…/daihon.txt node scripts/test.mjs tests/real-diag.test.ts
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { describe, it } from 'vitest'
import type { AsrSegment } from '../src/core/asr/clean'
import { scriptLines } from '../src/core/script/text'
import { ALIGN, alignAcross, alignJapanese, matchLines, normJa, segWords, timedChars } from '../src/core/script/align'

describe.skipIf(!process.env.ENV_DIAG)('diag', () => {
  it('prints', () => {
    const db = new Database(process.env.ENV_DIAG_DB!, { readonly: true })
    const rows = db.prepare("SELECT key, result_json FROM jobs WHERE kind = 'asr' AND key LIKE '%large-v3%:mc0:dtw|%|w|%'").all() as { key: string; result_json: string }[]
    const lines = scriptLines(readFileSync(process.env.ENV_DIAG_SCRIPT!, 'utf8')).map((l) => l.text)
    // per track, chunks in order (chunk-local times are fine for confidence)
    const byTrack = new Map<string, { i: number; segs: AsrSegment[] }[]>()
    for (const r of rows) {
      const p = r.key.split('|')
      const name = p[4].split(/[\\/]/).pop()!
      const list = byTrack.get(name) ?? []
      list.push({ i: Number(p[7]), segs: JSON.parse(r.result_json) })
      byTrack.set(name, list)
    }
    const names = [...byTrack.keys()].sort()
    const tracks = names.map((n) => {
      let off = 0
      const segs: AsrSegment[] = []
      for (const c of byTrack.get(n)!.sort((a, b) => a.i - b.i)) {
        const shift = (t: number): number => t + off
        for (const s of c.segs) segs.push({ ...s, start: shift(s.start), end: shift(s.end), words: s.words?.map((w) => ({ ...w, start: shift(w.start), end: shift(w.end) })) })
        off = segs.length ? segs[segs.length - 1].end + 1 : off
      }
      return { segs, total: off }
    })
    const out = alignAcross(lines, tracks)
    // the same lines on a second, independent hearing (tiny): starts agree?
    const other = (model: string): Map<string, AsrSegment[]> => {
      const m = new Map<string, AsrSegment[]>()
      for (const r of db.prepare("SELECT key, result_json FROM jobs WHERE kind = 'asr' AND key LIKE ?").all(`%${model}%:mc0|%|w|%`) as { key: string; result_json: string }[])
        m.set(r.key.split('|')[4].split(/[\\/]/).pop()!, JSON.parse(r.result_json))
      return m
    }
    const tiny = other('ggml-tiny')
    let all = 0, agree = 0, sure = 0, sureAgree = 0
    names.forEach((n, k) => {
      const r = out.get(k)
      const t = tiny.get(n)
      if (!r || !t) return
      const al2 = alignJapanese(r.lines, t, tracks[k].total)
      let a = 0, sa = 0, sn = 0
      r.al.forEach((x, i) => {
        const ok = Math.abs(x.start - al2[i].start) <= 0.5
        if (ok) a++
        if (x.conf >= ALIGN.lowConf) { sn++; if (ok) sa++ }
      })
      if (k === 0) console.log('DIFF', r.al.slice(0, 30).map((x, i) => (al2[i].start - x.start).toFixed(1) + '@' + x.start.toFixed(0)).join(' '))
      all += r.al.length; agree += a; sure += sn; sureAgree += sa
      console.log('AGREE', n, `all ${Math.round((a * 100) / r.al.length)}%, sure lines ${Math.round((sa * 100) / Math.max(1, sn))}%`)
    })
    console.log('AGREE total', `all ${Math.round((agree * 100) / all)}%, sure lines ${Math.round((sureAgree * 100) / sure)}% (${sure}/${all} sure)`)
    // per block of 10 lines: which track's speech shares the most rare 3-grams
    const tg = (t: string): Set<string> => { const o = new Set<string>(); for (let i = 0; i + 3 <= t.length; i++) o.add(t.slice(i, i + 3)); return o }
    const sets = tracks.map((t) => tg(normJa(segWords(t.segs).map((w) => w.text).join(''))))
    const df = new Map<string, number>()
    for (const set of sets) for (const x of set) df.set(x, (df.get(x) ?? 0) + 1)
    const row: string[] = []
    for (let i = 0; i < lines.length; i += 10) {
      const g = tg(lines.slice(i, i + 10).map(normJa).join(''))
      const sc = sets.map((set) => { let h = 0; for (const x of g) if (set.has(x)) h += Math.log(sets.length / df.get(x)!); return h })
      const k = sc.indexOf(Math.max(...sc))
      row.push(`L${i}:${k + 1}(${sc[k].toFixed(0)})`)
    }
    console.log(row.join(' '))
    let at = 0
    names.forEach((n, k) => {
      const r = out.get(k)
      if (!r) return console.log(n, 'no lines')
      const low = r.al.filter((a) => a.conf < ALIGN.lowConf).length
      const sc = r.lines.map(normJa).join('').length
      const tc = timedChars(segWords(tracks[k].segs))
      console.log('  script chars', sc, 'speech chars', tc.length, 'raw', segWords(tracks[k].segs).map((w) => w.text).join('').length, 'sample', tc.slice(400, 440).map((c) => c.c).join(''), '| line', normJa(r.lines[20] ?? ''))
      const ml = matchLines(r.lines, tc)
      console.log('  matchLines conf>=.5', ml.filter((x) => x.conf >= 0.5).length, 'conf>0', ml.filter((x) => x.conf > 0).length, 'first10', ml.slice(0, 10).map((x) => x.conf.toFixed(2)).join(' '))
      console.log(n, `lines L${at}–L${at + r.lines.length - 1} (${r.lines.length}), unsure ${((low / r.lines.length) * 100).toFixed(0)}%`)
      if (process.env.ENV_DIAG_SHOW === n.slice(4, 7)) r.lines.forEach((l, i) => console.log('   ', r.al[i].conf.toFixed(2), r.al[i].start.toFixed(1), l.slice(0, 50)))
      at += r.lines.length
    })
  })
})
