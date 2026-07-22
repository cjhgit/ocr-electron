import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import path from 'node:path'
import Koa from 'koa'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import { recognizeText } from './ocr/service'
import type { OcrModelVariant } from './ocr/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '../..')

export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'out/renderer')

const isDev =
  process.env.NODE_ENV_ELECTRON_VITE === 'development' || !app.isPackaged

function resolveDevServerUrl(): string | undefined {
  const url =
    process.env.ELECTRON_RENDERER_URL?.trim() ||
    process.env.VITE_DEV_SERVER_URL?.trim()

  if (url) return url.replace(/\/$/, '')
  if (isDev) return 'http://127.0.0.1:7777'
  return undefined
}

function configureWindowsGpu(): void {
  app.setAppUserModelId(app.getName())

  const gpuMode = process.env.ELECTRON_GPU_MODE ?? 'disable'

  switch (gpuMode) {
    case 'native':
      break
    case 'swiftshader':
      app.commandLine.appendSwitch('disable-gpu-sandbox')
      app.commandLine.appendSwitch('use-angle', 'swiftshader')
      app.commandLine.appendSwitch('use-gl', 'angle')
      break
    case 'disable':
    default:
      // Electron 38+ / Chromium 139+：须同时禁用 GPU 与 DirectComposition，否则 Windows 白屏
      app.disableHardwareAcceleration()
      app.commandLine.appendSwitch('disable-gpu')
      app.commandLine.appendSwitch('disable-direct-composition')
      app.commandLine.appendSwitch('disable-gpu-sandbox')
      break
  }

  try {
    execSync('chcp 65001 >nul', { stdio: 'ignore', windowsHide: true })
  } catch {
    // ignore
  }
}

if (process.platform === 'win32') {
  configureWindowsGpu()
}

if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

process.env.VITE_PUBLIC = resolveDevServerUrl()
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null

const preloadPath = path.join(__dirname, '../preload/index.js')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

async function logRendererState(label: string) {
  if (!win || win.webContents.isDestroyed()) return

  try {
    const state = await win.webContents.executeJavaScript(`({
      url: location.href,
      title: document.title,
      rootLen: document.getElementById('root')?.innerHTML?.length ?? 0,
      bodyLen: document.body?.innerText?.length ?? 0,
    })`)
    console.log(`[renderer] ${label}:`, state)
  } catch (error) {
    console.error(`[renderer] ${label} inspect failed:`, error)
  }
}

function createHttpServer() {
  const koaApp = new Koa()
  const router = new Router()

  koaApp.use(async (ctx, next) => {
    ctx.set('Access-Control-Allow-Origin', '*')
    ctx.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    ctx.set('Access-Control-Allow-Headers', 'Content-Type')

    if (ctx.method === 'OPTIONS') {
      ctx.status = 200
      return
    }

    try {
      await next()
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      ctx.set('Access-Control-Allow-Origin', '*')
      ctx.status = err?.status ?? 500
      ctx.body = {
        code: -1,
        message: err?.message ?? '服务器错误',
      }
    }
  })

  koaApp.use(bodyParser())

  router.get('/', (ctx) => {
    ctx.body = 'hello chat'
  })

  router.post('/api/ocr/recognize', async (ctx) => {
    const body = ctx.request.body as {
      modelRoot?: string
      variant?: OcrModelVariant
      image?: {
        width?: number
        height?: number
        dataBase64?: string
      }
    }

    const modelRoot = body.modelRoot?.trim()
    const variant = body.variant
    const image = body.image

    if (!modelRoot) {
      ctx.status = 400
      ctx.body = { code: -1, message: '请配置 paddleocr-js-onnx 路径' }
      return
    }

    if (variant !== 'mobile' && variant !== 'server') {
      ctx.status = 400
      ctx.body = { code: -1, message: '模型类型无效，请选择 mobile 或 server' }
      return
    }

    if (
      !image?.width ||
      !image?.height ||
      !image?.dataBase64 ||
      image.width <= 0 ||
      image.height <= 0
    ) {
      ctx.status = 400
      ctx.body = { code: -1, message: '图片数据无效' }
      return
    }

    const pixelData = Buffer.from(image.dataBase64, 'base64')
    const expectedLength = image.width * image.height * 4

    if (pixelData.length !== expectedLength) {
      ctx.status = 400
      ctx.body = { code: -1, message: '图片像素数据长度不匹配' }
      return
    }

    const result = await recognizeText({
      modelRoot,
      variant,
      image: {
        width: image.width,
        height: image.height,
        data: new Uint8Array(pixelData),
      },
    })

    ctx.body = {
      code: 0,
      data: {
        text: result.text,
      },
    }
  })

  koaApp.use(router.routes())
  koaApp.use(router.allowedMethods())

  koaApp.use(async (ctx) => {
    ctx.status = 404
    ctx.body = { error: 'Not Found' }
  })

  const PORT = 38765
  const server = koaApp.listen(PORT, () => {
    console.log(`HTTP 服务器运行在 http://localhost:${PORT}`)
  })

  return server
}

async function createWindow() {
  const devServerUrl = resolveDevServerUrl()
  console.log('[main] isDev:', isDev)
  console.log('[main] ELECTRON_RENDERER_URL:', process.env.ELECTRON_RENDERER_URL)
  console.log('[main] load target:', devServerUrl ?? indexHtml)

  const webPreferences: Electron.WebPreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  }

  if (existsSync(preloadPath)) {
    webPreferences.preload = preloadPath
  }

  win = new BrowserWindow({
    title: 'Flow Chat',
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    width: 800,
    height: 600,
    backgroundColor: '#ffffff',
    webPreferences,
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, url) => {
    console.error('[renderer] load failed:', errorCode, errorDescription, url)
  })

  win.webContents.on('did-finish-load', () => {
    console.log('[renderer] did-finish-load:', win?.webContents.getURL())
    void logRendererState('after load')
    setTimeout(() => {
      void logRendererState('after 2s')
    }, 2000)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone:', details.reason)
  })

  win.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event
    if (level === 'warning' || level === 'error') {
      console.error(`[renderer] ${message} (${sourceId}:${lineNumber})`)
    }
  })

  if (devServerUrl) {
    await win.loadURL(devServerUrl)
  } else {
    await win.loadFile(indexHtml)
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  await createWindow()
  createHttpServer()
  if (isDev) {
    console.log('[main] DevTools: View -> Toggle Developer Tools, or chrome://inspect -> 127.0.0.1:9222')
  }
})

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow()
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})
