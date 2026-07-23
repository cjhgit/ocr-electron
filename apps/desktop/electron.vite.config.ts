import { isAbsolute, resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const OCR_WORKER_MODULE_RE = /electron\/main\/(?:ocr\/|logger\.ts)/
const OCR_BUNDLE_PACKAGES = ['paddleocr', 'jpeg-js', 'fast-png', 'fflate', 'iobuffer'] as const

function isBareImport(id: string): boolean {
  return !id.startsWith('.') && !id.startsWith('\0') && !isAbsolute(id)
}

function isOcrBundlePackage(id: string): boolean {
  return OCR_BUNDLE_PACKAGES.some((pkg) => id === pkg || id.startsWith(`${pkg}/`))
}

function mainSelectiveExternalPlugin(): Plugin {
  return {
    name: 'main-selective-external',
    enforce: 'pre',
    config(config) {
      config.build ??= {}
      config.build.rollupOptions ??= {}
      config.build.rollupOptions.external = (id, importer) => {
        if (id.startsWith('node:')) return true
        if (id === 'electron' || id.startsWith('electron/')) return true
        if (id === 'onnxruntime-node' || id.startsWith('onnxruntime-node/')) return true
        if (isOcrBundlePackage(id)) return false

        const fromOcrWorker = Boolean(importer && OCR_WORKER_MODULE_RE.test(importer))
        if (fromOcrWorker) return false

        return isBareImport(id)
      }
    },
  }
}

function fixElectronRequire(): Plugin {
  return {
    name: 'fix-electron-require',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      for (const fileName in bundle) {
        const chunk = bundle[fileName]
        if (chunk.type === 'chunk' && fileName.includes('index')) {
          const electronImport = 'const electron = require("electron");'
          let newCode = chunk.code.replace(/^const electron = require\("electron"\);$/gm, '')
          newCode = newCode.replace(/("use strict";)/, `$1\n${electronImport}`)
          chunk.code = newCode
        }
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [mainSelectiveExternalPlugin(), fixElectronRequire()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          'ocr-worker': resolve(__dirname, 'electron/main/ocr/worker.ts'),
        },
        output: {
          format: 'cjs',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    root: '.',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
    server: {
      port: 7777,
      strictPort: true,
      host: '127.0.0.1',
    },
    plugins: [react(), tailwindcss()],
  },
})
