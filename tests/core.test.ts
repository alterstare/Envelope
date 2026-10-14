import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { CancelledError, DEFAULT_SETTINGS, EnvCore, JobQueue } from '../src/core'
import { MIGRATIONS, NewerDataError, openDb } from '../src/core/db'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'env-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('database', () => {
  it('creates the schema at the latest version', () => {
    const core = new EnvCore(':memory:')
    expect(core.schemaVersion).toBe(MIGRATIONS.length)
    core.close()
  })

  it('creates the data folders and env.db on disk', () => {
    const dir = tempDir()
    const core = new EnvCore(dir)
    expect(core.paths.dbPath).toBe(join(dir, 'env.db'))
    core.close()
    // reopening keeps the version (no migration re-run)
    const again = new EnvCore(dir)
    expect(again.schemaVersion).toBe(MIGRATIONS.length)
    again.close()
  })

  it('refuses data made by a newer Env', () => {
    const file = join(tempDir(), 'env.db')
    const db = new Database(file)
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`)
    db.close()
    expect(() => openDb(file)).toThrow(NewerDataError)
  })
})

describe('settings', () => {
  it('falls back to defaults and saves patches', () => {
    const core = new EnvCore(':memory:')
    expect(core.settings()).toEqual(DEFAULT_SETTINGS)
    const s = core.saveSettings({ theme: 'light', libraryDirs: ['D:/voice'] })
    expect(s.theme).toBe('light')
    expect(core.settings().libraryDirs).toEqual(['D:/voice'])
    core.close()
  })

  it('ignores unknown keys', () => {
    const core = new EnvCore(':memory:')
    core.saveSettings({ nope: 1 } as never)
    expect(core.db.prepare("SELECT 1 FROM settings WHERE key = 'nope'").get()).toBeUndefined()
    core.close()
  })
})

describe('action log', () => {
  it('undoes and redoes the newest action', async () => {
    const core = new EnvCore(':memory:')
    let value = 1
    core.log.register<{ value: number; label: string }>(
      'set',
      (p) => void (value = p.value),
      (p) => ({ ...p, value })
    )
    core.log.record('set', { value: 1, label: '값 변경' }) // previous value
    value = 2
    expect((await core.log.undo())?.type).toBe('set')
    expect(value).toBe(1)
    expect(await core.log.redo()).toBe('값 변경')
    expect(value).toBe(2)
    expect(await core.log.redo()).toBeNull()
    core.close()
  })
})

describe('job queue', () => {
  it('runs jobs in order and reports progress', async () => {
    const q = new JobQueue(1)
    const states: string[] = []
    q.onProgress((e) => states.push(`${e.jobId}:${e.state}`))
    const a = q.add('a', async (ctx) => (ctx.report(1, 1), 'A'))
    const b = q.add('b', async () => 'B')
    expect(await a.done).toBe('A')
    expect(await b.done).toBe('B')
    expect(states.indexOf(`${a.id}:done`)).toBeLessThan(states.indexOf(`${b.id}:running`))
  })

  it('cancels a queued job', async () => {
    const q = new JobQueue(1)
    let release!: () => void
    const first = q.add('first', () => new Promise<void>((r) => (release = r)))
    const second = q.add('second', async () => 'never')
    expect(q.cancel(second.id)).toBe(true)
    await expect(second.done).rejects.toBeInstanceOf(CancelledError)
    release()
    await first.done
  })
})
