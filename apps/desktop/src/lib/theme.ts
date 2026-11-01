const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

/**
 * 渲染进程的 prefers-color-scheme 跟随主进程的 nativeTheme.themeSource：
 * 用户选择跟随系统时随操作系统，选择浅色/深色时为强制值。
 * 这里根据它切换 <html> 上的 dark 类，驱动全局主题变量。
 */
export function applyThemeClass(): void {
  const dark = window.matchMedia(DARK_MEDIA_QUERY).matches
  document.documentElement.classList.toggle('dark', dark)
}

export function watchSystemTheme(onChange?: () => void): () => void {
  const media = window.matchMedia(DARK_MEDIA_QUERY)
  const handler = () => {
    applyThemeClass()
    onChange?.()
  }
  media.addEventListener('change', handler)
  return () => media.removeEventListener('change', handler)
}
