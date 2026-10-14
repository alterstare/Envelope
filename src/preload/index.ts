import { contextBridge, ipcRenderer } from 'electron'
import { createApi } from './api'

contextBridge.exposeInMainWorld('api', createApi(ipcRenderer))

// The saved theme on <html> before the first paint (main passes it as
// --env-theme); otherwise the light defaults flash until the settings load.
const theme = process.argv.find((a) => a.startsWith('--env-theme='))?.split('=')[1]
if (theme) {
  const apply = (): boolean => {
    if (!document.documentElement) return false
    document.documentElement.dataset.theme = theme
    return true
  }
  if (!apply())
    new MutationObserver((_m, mo) => {
      if (apply()) mo.disconnect()
    }).observe(document, { childList: true })
}
