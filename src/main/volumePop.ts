// 최소화 모드 volume pop-up: the one-bar window is too short for a bar that
// opens upward, so it opens in its own small window right above the button
// (transparent, no frame, never takes the focus). It rises in while the
// pointer is over the button, the bar sets the volume, and it sinks away once
// the pointer has been off both the button and the bar for a moment — told by
// where the cursor really is (enter / leave events across two windows are not
// reliable), never in the middle of a drag.
import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import type { VolPopCommand } from '../shared/ipc'

const W = 44
const H = 128
const GAP = 6
const LEAVE_MS = 180 // pointer gone from button and bar this long → close
const CLOSE_MS = 140 // its sinking away

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none}
.p{position:absolute;left:4px;right:4px;top:4px;bottom:4px;display:grid;place-items:center;border-radius:999px;
  background:var(--bg);border:1px solid var(--line);box-shadow:0 6px 18px rgba(0,0,0,.35);
  transform-origin:50% 100%;opacity:0;transform:translateY(8px) scale(.94);transition:opacity .18s cubic-bezier(.2,.8,.2,1),transform .18s cubic-bezier(.2,.8,.2,1)}
.p.on{opacity:1;transform:none}
input{-webkit-appearance:none;appearance:none;writing-mode:vertical-lr;direction:rtl;width:16px;height:86px;margin:0;background:transparent;cursor:pointer}
input::-webkit-slider-runnable-track{width:4px;border-radius:2px;background:linear-gradient(to top,var(--accent) var(--p),var(--track) var(--p))}
input::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;margin-left:-4px;border-radius:50%;background:var(--text)}
</style></head><body><div class="p" id="p"><input id="v" type="range" min="0" max="1" step="0.01"></div><script>
const p=document.getElementById('p'),v=document.getElementById('v')
const fill=()=>v.style.setProperty('--p',(v.value*100)+'%')
v.addEventListener('input',()=>{fill();pop.input(Number(v.value))})
document.addEventListener('wheel',(e)=>{v.value=Math.min(1,Math.max(0,Number(v.value)-Math.sign(e.deltaY)*0.05));fill();pop.input(Number(v.value))})
v.addEventListener('pointerdown',()=>pop.enter())
window.addEventListener('pointerup',()=>pop.leave())
pop.onShow((s)=>{for(const[k,c] of Object.entries(s.colors))document.documentElement.style.setProperty('--'+k,c);v.value=s.value;fill();p.classList.remove('on');void p.offsetWidth;p.classList.add('on')})
pop.onValue((x)=>{v.value=x;fill()})
pop.onHide(()=>p.classList.remove('on'))
</script></body></html>`

export function setupVolumePop(parent: () => BrowserWindow | null): void {
  let pop: BrowserWindow | null = null
  let button: Electron.Rectangle | null = null // on screen
  let dragging = false
  let closing: ReturnType<typeof setTimeout> | null = null
  let watch: ReturnType<typeof setInterval> | null = null
  const POLL_MS = 80

  const ensure = async (): Promise<BrowserWindow> => {
    if (pop && !pop.isDestroyed()) return pop
    pop = new BrowserWindow({
      width: W,
      height: H,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: { preload: join(__dirname, '../preload/volumePop.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false }
    })
    await pop.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
    return pop
  }
  const inside = (p: Electron.Point, r: Electron.Rectangle | null, pad = 0): boolean =>
    !!r && p.x >= r.x - pad && p.x < r.x + r.width + pad && p.y >= r.y - pad && p.y < r.y + r.height + pad
  const startWatch = (): void => {
    if (watch) clearInterval(watch)
    let outFor = 0
    watch = setInterval(() => {
      if (!pop || pop.isDestroyed() || !pop.isVisible()) return stopWatch()
      const at = screen.getCursorScreenPoint()
      // the gap between button and bar counts as inside
      const over = dragging || inside(at, pop.getBounds()) || inside(at, button, GAP)
      outFor = over ? 0 : outFor + POLL_MS
      if (outFor >= LEAVE_MS) close()
    }, POLL_MS)
  }
  const stopWatch = (): void => {
    if (watch) clearInterval(watch)
    watch = null
  }
  const close = (): void => {
    stopWatch()
    if (!pop || pop.isDestroyed() || !pop.isVisible()) return
    pop.webContents.send('pop:hide')
    if (closing) clearTimeout(closing)
    closing = setTimeout(() => pop?.hide(), CLOSE_MS)
  }

  ipcMain.removeAllListeners(IPC.volPop)
  ipcMain.on(IPC.volPop, async (_e, c: VolPopCommand) => {
    const win = parent()
    if (!win) return
    if (c.action === 'show') {
      if (closing) clearTimeout(closing)
      const p = await ensure()
      const b = win.getContentBounds()
      button = { x: Math.round(b.x + c.rect.x), y: Math.round(b.y + c.rect.y), width: Math.round(c.rect.w), height: Math.round(c.rect.h) }
      p.setBounds({ x: Math.round(b.x + c.rect.x + c.rect.w / 2 - W / 2), y: Math.round(b.y + c.rect.y - H - GAP + 4), width: W, height: H })
      if (!p.isVisible()) {
        p.showInactive()
        p.webContents.send('pop:show', { value: c.value, colors: c.colors })
      }
      startWatch()
    } else if (c.action === 'leave') {
      // the cursor watch decides
    } else if (c.action === 'value') {
      if (pop && !pop.isDestroyed()) pop.webContents.send('pop:value', c.value)
    } else {
      close()
    }
  })
  ipcMain.removeAllListeners('pop:input')
  ipcMain.on('pop:input', (_e, v: number) => parent()?.webContents.send(IPC.volPopInput, v))
  ipcMain.removeAllListeners('pop:enter')
  ipcMain.on('pop:enter', () => (dragging = true))
  ipcMain.removeAllListeners('pop:leave')
  ipcMain.on('pop:leave', () => (dragging = false))
}
