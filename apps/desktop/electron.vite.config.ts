import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin, Plugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    plugins: [externalizeDepsPlugin(), fixElectronRequire()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/main/index.ts'),
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
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
    server: {
      port: 7777,
      strictPort: true,
    },
    plugins: [react()],
  },
})
