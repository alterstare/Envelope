// Preload of the 최소화 모드 volume pop-up (a tiny window over the one-bar
// window, which is too short to hold it): the slider talks to main.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('pop', {
  input: (v: number) => ipcRenderer.send('pop:input', v),
  enter: () => ipcRenderer.send('pop:enter'), // drag starts
  leave: () => ipcRenderer.send('pop:leave'), // drag ends
  onShow: (cb: (s: { value: number; colors: Record<string, string> }) => void) => ipcRenderer.on('pop:show', (_e, s) => cb(s)),
  onValue: (cb: (v: number) => void) => ipcRenderer.on('pop:value', (_e, v) => cb(v)),
  onHide: (cb: () => void) => ipcRenderer.on('pop:hide', () => cb())
})
