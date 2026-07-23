import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOG_DIR = join(homedir(), '.finance-checker', 'log')
const ERROR_LOG_PATH = join(LOG_DIR, 'error.log')

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ?? arg.message
  }
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg)
    } catch {
      return String(arg)
    }
  }
  return String(arg)
}

function formatMessage(args: unknown[]): string {
  return args.map(formatArg).join(' ')
}

export function writeErrorLog(message: string): void {
  try {
    ensureLogDir()
    appendFileSync(ERROR_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // ignore logging failures
  }
}

export function initErrorLogging(tag: string): void {
  const originalConsoleError = console.error.bind(console)

  console.error = (...args: unknown[]) => {
    originalConsoleError(...args)
    writeErrorLog(formatMessage(args))
  }

  process.on('uncaughtException', (error) => {
    console.error(`[${tag}] uncaught exception:`, error)
  })

  process.on('unhandledRejection', (reason) => {
    console.error(`[${tag}] unhandled rejection:`, reason)
  })
}
