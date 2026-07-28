import { contextBridge, webUtils } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
})
