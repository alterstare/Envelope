// Electron shell for the standalone app: window, single instance, auto-update.
// Everything Env does on the main-process side lives in ./host (shared with
// Halftone, which embeds it); the engine in ../core.
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, protocol } from 'electron'
import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs'
import { join } from 'path'
import electronUpdater from 'electron-updater'
import { IPC } from '../shared/ipc'
import type { UpdateStatus } from '../shared/ipc'
import { ENV_SCHEME, closeEnv, envCore, initEnv } from './host'
import { setupVolumePop } from './volumePop'

let win: BrowserWindow | null = null

// The app was called "Env" before 0.1.0: its data folder moves to the new
// name (%APPDATA%/Env → %APPDATA%/Envelope) the first time, before anything
// opens it. Entries already in the new folder (Chromium makes some at start)
// are left; ours move over.
function moveOldData(): void {
  const from = join(app.getPath('appData'), 'Env')
  const to = app.getPath('userData')
  // only into the default folder (a --user-data-dir run must never take it)
  if (to !== join(app.getPath('appData'), 'Envelope')) return
  if (!existsSync(join(from, 'env.db')) || existsSync(join(to, 'env.db'))) return
  try {
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) if (!existsSync(join(to, name))) renameSync(join(from, name), join(to, name))
  } catch (e) {
    console.error('could not move the old data folder', e)
  }
}
moveOldData()

protocol.registerSchemesAsPrivileged([ENV_SCHEME])

// Window / taskbar icon in dev (packaged builds use the exe icon).
const DEV_ICON = join(__dirname, process.platform === 'win32' ? '../../build/icon.ico' : '../../build/icons/256x256.png')

const COMPACT_W = 420 // ≤ 845 → the small-window layout
// 최소화 모드: one bar (height of its content), the width it had within limits
const MINI = { h: 76, minW: 620, maxW: 1100, animMs: 300 } // the squeeze / stretch

function createWindow(theme: 'light' | 'dark'): void {
  Menu.setApplicationMenu(null)
  nativeTheme.themeSource = theme
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: theme === 'dark' ? '#0b0d13' : '#f4f5f8',
    // no native title bar: the top bar is the drag area and draws ─ □ ✕, so
    // 최소화 모드 can be just the one bar
    titleBarStyle: 'hidden',
    ...(existsSync(DEV_ICON) ? { icon: DEV_ICON } : {}),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      additionalArguments: [`--env-theme=${theme}`]
    }
  })
  win.on('ready-to-show', () => win?.show())
  // Mouse side buttons: Windows sends APPCOMMAND_BROWSER_BACKWARD/FORWARD
  // (the renderer also catches DOM buttons 3/4 and dedupes).
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') win?.webContents.send(IPC.navBack)
    else if (cmd === 'browser-forward') win?.webContents.send(IPC.navForward)
  })
  win.on('closed', () => (win = null))
  // window buttons and 최소화 모드
  let mini: Electron.Rectangle | null = null // the normal bounds while in 최소화 모드
  let onTop = envCore()?.settings().miniOnTop ?? true
  const state = (): void => win?.webContents.send(IPC.windowState, { maximized: !!win?.isMaximized(), mini: !!mini, onTop })
  win.on('maximize', state)
  win.on('unmaximize', state)
  ipcMain.removeAllListeners(IPC.winControl)
  ipcMain.on(IPC.winControl, (_e, a: 'minimize' | 'maximize' | 'close') => {
    if (!win) return
    if (a === 'minimize') win.minimize()
    else if (a === 'close') win.close()
    else if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.removeHandler(IPC.setMini)
  // 최소화 모드 motion, the way Windows minimizes: a picture of the window is
  // squeezed (or stretched back) in a transparent overlay — a GPU transform,
  // smooth — while the real window changes size once, out of sight, and shows
  // again when the picture lands. Nothing inside the app is laid out frame by
  // frame (stepping the real window's size made it judder).
  let overlay: BrowserWindow | null = null
  const getOverlay = async (): Promise<BrowserWindow> => {
    if (overlay && !overlay.isDestroyed()) return overlay
    overlay = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      // it is hidden between uses: no throttling, or its frames would stall
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
    })
    overlay.setIgnoreMouseEvents(true)
    await overlay.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent">' +
            '<img id="i" style="position:fixed;display:block;transform-origin:0 0;will-change:transform,opacity">' +
            '</body></html>'
        )
    )
    return overlay
  }
  const union = (a: Electron.Rectangle, b: Electron.Rectangle): Electron.Rectangle => {
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
  }
  // the picture moves from rect `from` to rect `to` (screen coordinates)
  const fly = async (shot: Electron.NativeImage, from: Electron.Rectangle, to: Electron.Rectangle, going: 'in' | 'out'): Promise<void> => {
    const o = await getOverlay()
    const area = union(from, to)
    o.setBounds(area)
    const r = (q: Electron.Rectangle): { x: number; y: number; w: number; h: number } => ({ x: q.x - area.x, y: q.y - area.y, w: q.width, h: q.height })
    const a = r(from)
    const b = r(to)
    const src = going === 'in' ? a : b // the picture is the bigger window
    await o.webContents.executeJavaScript(`new Promise((done) => {
      const i = document.getElementById('i')
      i.getAnimations().forEach((a) => a.cancel())
      i.onload = () => {
        const s = ${JSON.stringify(src)}
        i.style.left = s.x + 'px'; i.style.top = s.y + 'px'; i.style.width = s.w + 'px'; i.style.height = s.h + 'px'
        const at = (q) => 'translate(' + (q.x - s.x) + 'px,' + (q.y - s.y) + 'px) scale(' + q.w / s.w + ',' + q.h / s.h + ')'
        const from = ${JSON.stringify(a)}, to = ${JSON.stringify(b)}
        i.style.transform = at(from)
        done(true)
        window.__go = () => i.animate(
          ${going === 'in' ? `[{ transform: at(from), opacity: 1 }, { transform: at(to), opacity: 0.15 }]` : `[{ transform: at(from), opacity: 0.15 }, { transform: at(to), opacity: 1 }]`},
          { duration: ${MINI.animMs}, easing: '${going === 'in' ? 'cubic-bezier(0.5, 0, 0.75, 0)' : 'cubic-bezier(0.2, 0.8, 0.3, 1)'}', fill: 'forwards' }
        ).finished
      }
      i.src = ${JSON.stringify(shot.toDataURL())}
    })`)
    o.showInactive()
    await o.webContents.executeJavaScript('window.__go().then(() => true)')
  }
  const still = async (shot: Electron.NativeImage, at: Electron.Rectangle, area: Electron.Rectangle): Promise<void> => {
    const o = await getOverlay()
    o.setBounds(area)
    const q = { x: at.x - area.x, y: at.y - area.y, w: at.width, h: at.height }
    await o.webContents.executeJavaScript(`new Promise((done) => {
      const i = document.getElementById('i')
      i.getAnimations().forEach((a) => a.cancel())
      i.onload = () => {
        const q = ${JSON.stringify(q)}
        i.style.left = q.x + 'px'; i.style.top = q.y + 'px'; i.style.width = q.w + 'px'; i.style.height = q.h + 'px'
        i.style.transform = 'none'; i.style.opacity = '1'
        done(true)
      }
      i.src = ${JSON.stringify(shot.toDataURL())}
    })`)
    o.showInactive()
  }
  // never leave the real window hidden: give up on the picture after a while
  const flySafe = (shot: Electron.NativeImage, from: Electron.Rectangle, to: Electron.Rectangle, going: 'in' | 'out'): Promise<void> =>
    Promise.race([fly(shot, from, to, going).catch(() => {}), new Promise<void>((r) => setTimeout(r, MINI.animMs + 1500))])
  const hideOverlay = (): void => {
    if (overlay && !overlay.isDestroyed()) {
      overlay.hide()
      void overlay.webContents.executeJavaScript("document.getElementById('i').removeAttribute('src')").catch(() => {})
    }
  }
  const painted = (): Promise<void> => new Promise((r) => setTimeout(r, 120))
  ipcMain.handle(IPC.setMini, async (_e, on: boolean) => {
    if (!win || on === !!mini) return state()
    try {
      if (on) {
        if (win.isMaximized()) win.unmaximize()
        if (win.isFullScreen()) win.setFullScreen(false)
        mini = win.getBounds()
        const shot = await win.webContents.capturePage()
        // the bar stays where the bottom bar was (the window's bottom edge)
        const c = win.getContentBounds()
        const frame = { w: mini.width - c.width, h: mini.height - c.height }
        const w = Math.min(Math.max(c.width, MINI.minW), MINI.maxW)
        const bar = { x: mini.x, y: mini.y + mini.height - MINI.h - frame.h, width: w + frame.w, height: MINI.h + frame.h }
        win.setOpacity(0)
        win.setMaximizable(false)
        win.setMinimumSize(MINI.minW, MINI.h)
        win.setBounds(bar)
        win.setMaximumSize(10000, MINI.h + frame.h)
        win.setAlwaysOnTop(onTop)
        state()
        await flySafe(shot, mini, bar, 'in')
      } else {
        const back = mini
        if (!back) return
        const bar = win.getBounds()
        // the bar stays on screen (as a picture) while the full screen is
        // drawn out of sight — no blank moment before the stretch
        await Promise.race([still(await win.webContents.capturePage(), bar, union(bar, back)).catch(() => {}), new Promise((r) => setTimeout(r, 400))])
        mini = null
        win.setOpacity(0)
        win.setAlwaysOnTop(false)
        win.setMaximumSize(0, 0)
        win.setMaximizable(true)
        win.setMinimumSize(360, 480)
        win.setBounds(back)
        state()
        await painted() // the full screen drawn at its size, then pictured
        const shot = await win.webContents.capturePage()
        await flySafe(shot, bar, back, 'out')
      }
    } finally {
      win?.setOpacity(1)
      hideOverlay()
    }
    state()
  })
  ipcMain.removeHandler(IPC.setOnTop)
  ipcMain.handle(IPC.setOnTop, (_e, on: boolean) => {
    onTop = on
    envCore()?.saveSettings({ miniOnTop: on })
    if (mini) win?.setAlwaysOnTop(on)
    state()
  })
  win.webContents.on('did-finish-load', state)
  setupVolumePop(() => win)
  // 작은 창 ⇄ 큰 창: narrow like the Halftone side panel, then back to the
  // size it had (or a default) — same top-left corner.
  let wide: Electron.Rectangle | null = null
  ipcMain.removeHandler(IPC.setCompact)
  ipcMain.handle(IPC.setCompact, (_e, on: boolean) => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    const b = win.getBounds()
    if (on) {
      if (b.width > COMPACT_W) wide = b
      win.setBounds({ x: b.x, y: b.y, width: COMPACT_W, height: b.height })
    } else {
      win.setBounds({ x: b.x, y: b.y, width: wide && wide.width > 845 ? wide.width : 1200, height: wide?.height ?? b.height })
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// 자동 업데이트 from GitHub Releases (publish config in electron-builder.yml).
// Packaged builds only. Downloads in the background; installs on quit or when
// the user picks "재시작해서 업데이트". Off in 설정 → no check, no download.
let updateStatus: UpdateStatus = { state: app.isPackaged ? 'idle' : 'dev' }
let applyAutoUpdate: (on: boolean) => void = () => {}
function sendUpdate(s: UpdateStatus): void {
  updateStatus = s
  win?.webContents.send(IPC.updateStatus, s)
}
function setupAutoUpdate(enabled: boolean): void {
  if (!app.isPackaged) {
    ipcMain.handle(IPC.checkUpdate, () => updateStatus)
    return
  }
  const { autoUpdater } = electronUpdater
  let checked = false
  const check = (): void => {
    sendUpdate({ state: 'checking' })
    autoUpdater.checkForUpdates().catch((e) => sendUpdate({ state: 'error', error: String(e?.message ?? e) }))
  }
  applyAutoUpdate = (on) => {
    autoUpdater.autoDownload = on
    autoUpdater.autoInstallOnAppQuit = on
    if (on && !checked) {
      checked = true
      check()
    }
  }
  autoUpdater.on('update-available', (i) => sendUpdate({ state: 'available', version: i.version }))
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }))
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', version: updateStatus.version, percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ state: 'downloaded', version: i.version }))
  autoUpdater.on('error', (e) => sendUpdate({ state: 'error', error: String(e?.message ?? e) }))
  ipcMain.handle(IPC.checkUpdate, async () => {
    if (updateStatus.state !== 'downloading' && updateStatus.state !== 'downloaded') {
      autoUpdater.autoDownload = true // a manual check downloads even with auto-update off
      check()
    }
    return updateStatus
  })
  ipcMain.on(IPC.installUpdate, () => autoUpdater.quitAndInstall())
  applyAutoUpdate(enabled)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  void app.whenReady().then(() => {
    initEnv({
      dataDir: app.getPath('userData'),
      appName: 'Envelope',
      appVersion: app.getVersion(),
      window: () => win,
      send: (ch, payload) => win?.webContents.send(ch, payload),
      onTheme: (t) => (nativeTheme.themeSource = t),
      onSettingsSaved: (patch, s) => {
        if ('autoUpdate' in patch) applyAutoUpdate(s.autoUpdate)
      }
    })
    const core = envCore()
    createWindow(core?.settings().theme ?? 'dark')
    setupAutoUpdate(core?.settings().autoUpdate ?? true)
  })
  app.on('window-all-closed', () => {
    closeEnv()
    app.quit()
  })
}
