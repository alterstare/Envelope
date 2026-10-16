import { existsSync } from 'fs'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import { installEngines } from '../src/core/asr/install'
import { whisperBinary } from '../src/core/asr/engines'
import { cleanup, tempDir } from './helpers'

afterEach(cleanup)

const win = process.platform === 'win32'
const CPU = win ? 'whisper-bin-x64.zip' : 'whisper-bin-ubuntu-x64.tar.gz'
const VK = win ? 'whisper-vulkan-win-x64.zip' : 'whisper-vulkan-linux-x64.tar.gz'

// A zip with a fake whisper-cli (inside a folder, like the official CPU zip).
function zipWith(path: string): Buffer {
  const z = new AdmZip()
  z.addFile(path, Buffer.from('fake'))
  return z.toBuffer()
}

// GitHub API + asset downloads, served from memory.
function fakeGitHub(opts: { vulkan: boolean }): typeof fetch {
  const bin = win ? 'whisper-cli.exe' : 'whisper-cli'
  const files: Record<string, Buffer> = {
    'https://dl/cpu': zipWith(`Release/${bin}`),
    'https://dl/vk': zipWith(bin)
  }
  return (async (url: string) => {
    if (url.includes('ggml-org/whisper.cpp/releases'))
      return Response.json([
        { tag_name: 'v1.9.5', assets: [] }, // the version tags have no binaries
        { tag_name: 'b6000', assets: [{ name: CPU, browser_download_url: 'https://dl/cpu' }] }
      ])
    if (url.includes('alterstare/Envelope/releases'))
      return Response.json([
        { tag_name: 'v0.2.0', assets: [{ name: 'Envelope-Setup.exe', browser_download_url: 'https://dl/app' }] },
        { tag_name: 'whisper-vulkan-v2', draft: true, assets: [{ name: VK, browser_download_url: 'https://dl/vk' }] },
        ...(opts.vulkan ? [{ tag_name: 'whisper-vulkan-v1.9.5', assets: [{ name: VK, browser_download_url: 'https://dl/vk' }] }] : [])
      ])
    const body = files[url]
    if (!body) return new Response('', { status: 404 })
    return new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } })
  }) as typeof fetch
}

describe.skipIf(!win)('엔진 받기', () => {
  it('installs the CPU build and the Vulkan build from the newest published release', async () => {
    const dir = tempDir()
    const msg = await installEngines(dir, fakeGitHub({ vulkan: true }), () => {})
    expect(msg).toBe('whisper.cpp 엔진(Vulkan · CPU)을 받았습니다')
    expect(whisperBinary(dir, 'cpu')).toBe(join(dir, 'whisper-cpu', 'Release', 'whisper-cli.exe'))
    expect(whisperBinary(dir, 'vulkan')).toBe(join(dir, 'whisper-vulkan', 'whisper-cli.exe'))
  })

  it('keeps the CPU build and says why when the Vulkan build is missing', async () => {
    const dir = tempDir()
    const msg = await installEngines(dir, fakeGitHub({ vulkan: false }), () => {})
    expect(msg).toBe('CPU 엔진을 받았습니다. Vulkan 엔진은 받지 못했습니다: whisper.cpp Vulkan 빌드를 찾지 못했습니다')
    expect(whisperBinary(dir, 'cpu')).not.toBeNull()
    expect(existsSync(join(dir, 'whisper-vulkan'))).toBe(false)
  })
})
