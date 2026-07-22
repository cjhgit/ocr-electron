import { app, BrowserWindow, Menu, shell } from 'electron'
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

  // swiftshader: 软件 GL，兼顾 GPU 崩溃环境与正常渲染（避免 disableHardwareAcceleration 白屏）
  // disable: 完全禁用硬件加速（原方案，部分机器会白屏且 DevTools 无法打开）
  // native: 不干预，使用系统 GPU
  const gpuMode = process.env.ELECTRON_GPU_MODE ?? 'swiftshader'

  switch (gpuMode) {
    case 'disable':
      app.disableHardwareAcceleration()
      app.commandLine.appendSwitch('disable-gpu-sandbox')
      app.commandLine.appendSwitch('enable-software-rasterizer')
      break
    case 'native':
      break
    case 'swiftshader':
    default:
      app.commandLine.appendSwitch('disable-gpu-sandbox')
      app.commandLine.appendSwitch('use-angle', 'swiftshader')
      app.commandLine.appendSwitch('use-gl', 'angle')
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

function setupAppMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
    webSecurity: !isDev,
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
    if (isDev) {
      win?.webContents.openDevTools({ mode: 'right' })
    }
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone:', details.reason)
  })

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[renderer] ${message} (${sourceId}:${line})`)
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
  setupAppMenu()
  await createWindow()
  createHttpServer()
  if (isDev) {
    console.log('[main] remote debugging: chrome://inspect -> 127.0.0.1:9222')
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
