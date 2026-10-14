// Test fixtures: folder trees of tiny generated files. No real works.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import iconv from 'iconv-lite'

const dirs: string[] = []
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'env-test-'))
  dirs.push(d)
  return d
}
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

// 8 kHz mono 8-bit PCM: 8000 bytes per second.
export function wav(seconds: number, riff: 'RIFF' | 'RF64' = 'RIFF'): Buffer {
  const data = Math.round(seconds * 8000)
  const b = Buffer.alloc(44 + data, 0x80)
  b.write(riff, 0, 'ascii')
  b.writeUInt32LE(riff === 'RF64' ? 0xffffffff : 36 + data, 4)
  b.write('WAVEfmt ', 8, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // mono
  b.writeUInt32LE(8000, 24)
  b.writeUInt32LE(8000, 28) // byte rate
  b.writeUInt16LE(1, 32)
  b.writeUInt16LE(8, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(riff === 'RF64' ? 0xffffffff : data, 40)
  return b
}

// CBR MPEG-1 Layer III, 128 kbps, 44.1 kHz: 16000 bytes per second.
export function mp3(seconds: number): Buffer {
  const b = Buffer.alloc(Math.round(seconds * 16000))
  b.set([0xff, 0xfb, 0x90, 0x64], 0)
  return b
}

// Write files under root: { 'a/b.mp3': Buffer | null } (null = empty file).
export function tree(root: string, files: Record<string, Buffer | null>): void {
  for (const [rel, buf] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, buf ?? Buffer.alloc(0))
  }
}

// What a Japanese name becomes when a zip is extracted on Korean Windows.
export function toMojibake(s: string): string {
  return iconv.decode(iconv.encode(s, 'shift_jis'), 'cp949')
}
