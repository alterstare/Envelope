// App icons from the logo (`Env_icon_v2.png`, 1024², square — corners are
// rounded here, the same shape as Sorta's):
//   build/icon.png      1024² with rounded corners
//   build/icon.ico      16–256 px for Windows (exe, window, taskbar, desktop)
//   build/icons/N.png   the same sizes as PNG (Linux window / desktop icons)
// Every size is rendered on its own from the full-size art: the halftone dots
// are area-averaged into a smooth tone (shrinking one big image lets Windows
// turn them into moiré blotches), and the purple stripe is drawn again as a
// sharp shape at that size — a little wider on the tiniest sizes so it stays
// a clear line.
//   node scripts/make-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = 'Env_icon_v2.png'
const SIZE = 1024
const RADIUS = 0.22 // corner radius / side (as Sorta)
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512]
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
// the stripe in the 1024² art (measured): top edge y 153.5 from x 805.5 to
// 935, bottom edge y 870 from x 89 to 219.5
const STRIPE = { top: 153.5, bottom: 870, tl: 805.5, tr: 935, bl: 89, br: 219.5, color: '#6e2cf5' }
const BACKGROUND = '#f0eef8' // the art's light ground
const MIN_STRIPE_PX = 2.4 // horizontal stripe width at the smallest sizes

const roundMask = (n) =>
  Buffer.from(`<svg width="${n}" height="${n}"><rect width="${n}" height="${n}" rx="${n * RADIUS}" ry="${n * RADIUS}" fill="#fff"/></svg>`)

const stripe = (n, color = STRIPE.color, pad = 0) => {
  const k = n / SIZE
  const w = (STRIPE.tr - STRIPE.tl) * k
  const grow = Math.max(pad, (MIN_STRIPE_PX - w) / 2) // each side, in px at this size
  const pts = [
    [STRIPE.tl * k - grow, STRIPE.top * k],
    [STRIPE.tr * k + grow, STRIPE.top * k],
    [STRIPE.br * k + grow, STRIPE.bottom * k],
    [STRIPE.bl * k - grow, STRIPE.bottom * k]
  ]
  return Buffer.from(
    `<svg width="${n}" height="${n}"><polygon points="${pts.map((p) => p.map((v) => v.toFixed(3)).join(',')).join(' ')}" fill="${color}"/></svg>`
  )
}

// the art without its stripe (painted over with the background, a little
// wider than the stripe and its anti-aliased edge), so averaging the dots
// doesn't smear purple around the stripe drawn again on top
const art = await sharp(readFileSync(join(root, SOURCE)))
  .resize(SIZE, SIZE)
  .removeAlpha()
  .composite([{ input: stripe(SIZE, BACKGROUND, 3) }])
  .png()
  .toBuffer()

const render = async (n) => {
  // dots → tone: blur away the dot pattern first (about half a target pixel),
  // then shrink — a plain resize leaves a checker moiré at 32–64 px
  const sigma = (SIZE / n) * 0.5
  const tone = await sharp(sigma >= 0.3 ? await sharp(art).blur(sigma).png().toBuffer() : art)
    .resize(n, n, { kernel: 'mitchell' })
    .png()
    .toBuffer()
  let img = sharp(tone).composite([{ input: stripe(n) }])
  img = sharp(await img.png().toBuffer())
    .ensureAlpha()
    .composite([{ input: roundMask(n), blend: 'dest-in' }])
  return img.png({ compressionLevel: 9 }).toBuffer()
}

mkdirSync(join(root, 'build/icons'), { recursive: true })
writeFileSync(join(root, 'build/icon.png'), await render(SIZE))
const pngs = new Map()
for (const n of SIZES) {
  const b = await render(n)
  pngs.set(n, b)
  writeFileSync(join(root, `build/icons/${n}x${n}.png`), b)
}

// ICO container with PNG-compressed entries.
const imgs = ICO_SIZES.map((n) => pngs.get(n))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(ICO_SIZES.length, 4)
const dir = Buffer.alloc(16 * ICO_SIZES.length)
let offset = 6 + dir.length
ICO_SIZES.forEach((n, i) => {
  const e = i * 16
  dir.writeUInt8(n >= 256 ? 0 : n, e)
  dir.writeUInt8(n >= 256 ? 0 : n, e + 1)
  dir.writeUInt16LE(1, e + 4)
  dir.writeUInt16LE(32, e + 6)
  dir.writeUInt32LE(imgs[i].length, e + 8)
  dir.writeUInt32LE(offset, e + 12)
  offset += imgs[i].length
})
writeFileSync(join(root, 'build/icon.ico'), Buffer.concat([header, dir, ...imgs]))
// renderer assets: the title strip's icon, and the top bar's logo (28 px on
// screen — rendered at twice that here so the browser only halves it, which
// keeps the dots from turning into moiré)
writeFileSync(join(root, 'src/renderer/src/assets/app-icon.png'), pngs.get(32))
writeFileSync(join(root, 'src/renderer/src/assets/logo.png'), await render(56))
console.log('icons:', SIZES.join(', '))
