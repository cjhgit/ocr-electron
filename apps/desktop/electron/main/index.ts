import { app, BrowserWindow, shell } from 'electron'
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

export const VITE_DEV_SERVER_URL =
  process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

if (process.platform === 'win32') {
  // 避免 Windows 上 GPU 进程崩溃导致应用无法启动（虚拟机/RDP/驱动异常等场景）
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('disable-direct-composition')
  // 关闭 Chromium 后台联网（组件更新/连通性检测等），避免不可达 HTTPS 产生 SSL 报错日志
  app.commandLine.appendSwitch('disable-background-networking')
  app.setAppUserModelId(app.getName())

  try {
    execSync('chcp 65001 >nul', { stdio: 'ignore', windowsHide: true })
  } catch {
    // ignore
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null

const preload = path.join(__dirname, '../preload/index.js')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

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
  win = new BrowserWindow({
    title: 'Flow Chat',
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    width: 800,
    height: 600,
    webPreferences: {
      preload,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(indexHtml)
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  createWindow()
  createHttpServer()
})

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})
