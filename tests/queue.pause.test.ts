import { describe, expect, it } from 'vitest'
import { JobQueue, CancelledError } from '../src/core/queue'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// a job that runs `steps` ticks, honoring abort; counts how often it started
function ticker(steps: number, log: string[], name: string) {
  return async ({ signal }: { signal: AbortSignal }): Promise<string> => {
    log.push(`start ${name}`)
    for (let i = 0; i < steps; i++) {
      if (signal.aborted) return 'partial'
      await wait(5)
    }
    return name
  }
}

describe('JobQueue 모두 중지 / 재개 / 모두 취소', () => {
  it('pauses a resumable job, runs it again on resume', async () => {
    const q = new JobQueue()
    const log: string[] = []
    const a = q.add('a', ticker(10, log, 'a'))
    const b = q.add('b', ticker(2, log, 'b'))
    await wait(12)
    q.pauseAll()
    await wait(40)
    expect(log).toEqual(['start a']) // stopped, nothing new started
    expect(q.isPaused).toBe(true)
    q.resumeAll()
    expect(await a.done).toBe('a')
    expect(await b.done).toBe('b')
    expect(log).toEqual(['start a', 'start a', 'start b']) // a first in line again
    expect(q.isPaused).toBe(false)
  })

  it('lets a file-changing job finish, then holds the rest', async () => {
    const q = new JobQueue()
    const log: string[] = []
    const a = q.add('a', ticker(4, log, 'a'), { resumable: false })
    const b = q.add('b', ticker(1, log, 'b'))
    await wait(5)
    q.pauseAll()
    expect(await a.done).toBe('a')
    await wait(20)
    expect(log).toEqual(['start a'])
    q.resumeAll()
    expect(await b.done).toBe('b')
  })

  it('cancels everything', async () => {
    const q = new JobQueue()
    const log: string[] = []
    const a = q.add('a', ticker(10, log, 'a'))
    const b = q.add('b', ticker(1, log, 'b'))
    await wait(5)
    expect(q.cancelAll()).toBe(2)
    await expect(a.done).rejects.toBeInstanceOf(CancelledError)
    await expect(b.done).rejects.toBeInstanceOf(CancelledError)
    expect(q.size).toBe(0)
  })

  it('cancel all while paused clears the pause', async () => {
    const q = new JobQueue()
    const a = q.add('a', ticker(10, [], 'a'))
    await wait(5)
    q.pauseAll()
    await wait(10)
    q.cancelAll()
    await expect(a.done).rejects.toBeInstanceOf(CancelledError)
    const c = q.add('c', async () => 'c')
    expect(await c.done).toBe('c')
  })
})
