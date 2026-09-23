import { app } from 'electron'
import { join } from 'path'
import * as winston from 'winston'
import * as fs from 'fs'

const logsDir = join(app.getPath('userData'), 'logs')
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true })
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`
  })
)

export const logger = winston.createLogger({
  level: 'debug',
  format: logFormat,
  transports: [
    new winston.transports.File({
      filename: join(logsDir, 'app.log'),
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: join(logsDir, 'error.log'),
      level: 'error'
    })
  ]
})

// Also log to console in dev
if (process.env.NODE_ENV === 'development') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), logFormat)
    })
  )
}

export const ffmpegLogger = winston.createLogger({
  level: 'debug',
  format: logFormat,
  transports: [
    new winston.transports.File({
      filename: join(logsDir, 'ffmpeg.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 3
    })
  ]
})

export const logsDirectory = logsDir
