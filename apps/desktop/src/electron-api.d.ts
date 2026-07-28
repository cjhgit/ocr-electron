export {}

declare global {
  interface Window {
    electronAPI?: {
      getPathForFile: (file: File) => string
    }
  }
}
