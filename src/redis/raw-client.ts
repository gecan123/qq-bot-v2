import { createConnection, Socket } from 'node:net'
import { URL } from 'node:url'

interface RedisConnectionOptions {
  host: string
  port: number
  username?: string
  password?: string
  db?: number
}

type RedisCommandArg = string | Buffer

type RedisReply = string | Buffer | number | null

function parseRedisUrl(redisUrl: string): RedisConnectionOptions {
  const url = new URL(redisUrl)
  if (url.protocol !== 'redis:') {
    throw new Error(`Unsupported redis protocol: ${url.protocol}`)
  }

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : undefined,
  }
}

function toBuffer(arg: RedisCommandArg): Buffer {
  return typeof arg === 'string' ? Buffer.from(arg) : arg
}

function encodeCommand(args: RedisCommandArg[]): Buffer {
  const header = Buffer.from(`*${args.length}\r\n`)
  const chunks: Buffer[] = [header]

  for (const arg of args) {
    const buf = toBuffer(arg)
    chunks.push(Buffer.from(`$${buf.length}\r\n`))
    chunks.push(buf)
    chunks.push(Buffer.from('\r\n'))
  }

  return Buffer.concat(chunks)
}

function parseLine(buffer: Buffer, offset: number): { line: Buffer; next: number } | null {
  const idx = buffer.indexOf('\r\n', offset)
  if (idx === -1) return null
  return {
    line: buffer.subarray(offset, idx),
    next: idx + 2,
  }
}

function parseReply(buffer: Buffer, offset = 0): { value: RedisReply; next: number } | null {
  if (offset >= buffer.length) return null

  const prefix = String.fromCharCode(buffer[offset])

  if (prefix === '+' || prefix === '-' || prefix === ':') {
    const line = parseLine(buffer, offset + 1)
    if (!line) return null

    if (prefix === '-') {
      throw new Error(`Redis error: ${line.line.toString('utf8')}`)
    }
    if (prefix === ':') {
      return { value: Number(line.line.toString('utf8')), next: line.next }
    }
    return { value: line.line.toString('utf8'), next: line.next }
  }

  if (prefix === '$') {
    const line = parseLine(buffer, offset + 1)
    if (!line) return null
    const length = Number(line.line.toString('utf8'))
    if (length === -1) return { value: null, next: line.next }

    const end = line.next + length
    if (buffer.length < end + 2) return null

    const payload = buffer.subarray(line.next, end)
    return { value: payload, next: end + 2 }
  }

  throw new Error(`Unsupported redis response prefix: ${prefix}`)
}

class RedisSocketSession {
  private readonly socket: Socket
  private buffer = Buffer.alloc(0)

  constructor(socket: Socket) {
    this.socket = socket
  }

  async command(args: RedisCommandArg[]): Promise<RedisReply> {
    const payload = encodeCommand(args)

    const reply = await new Promise<RedisReply>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk])
        try {
          const parsed = parseReply(this.buffer)
          if (!parsed) return
          this.buffer = this.buffer.subarray(parsed.next)
          cleanup()
          resolve(parsed.value)
        } catch (error) {
          cleanup()
          reject(error)
        }
      }

      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }

      const cleanup = () => {
        this.socket.off('data', onData)
        this.socket.off('error', onError)
      }

      this.socket.on('data', onData)
      this.socket.on('error', onError)
      this.socket.write(payload)
    })

    return reply
  }
}

export class RawRedisClient {
  private readonly options: RedisConnectionOptions

  constructor(redisUrl: string) {
    this.options = parseRedisUrl(redisUrl)
  }

  async set(key: string, value: string): Promise<void> {
    const socket = createConnection({
      host: this.options.host,
      port: this.options.port,
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })

    try {
      const session = new RedisSocketSession(socket)

      if (this.options.password) {
        if (this.options.username) {
          await session.command(['AUTH', this.options.username, this.options.password])
        } else {
          await session.command(['AUTH', this.options.password])
        }
      }

      if (typeof this.options.db === 'number' && !Number.isNaN(this.options.db)) {
        await session.command(['SELECT', String(this.options.db)])
      }

      await session.command(['SET', key, value])
    } finally {
      socket.end()
    }
  }
}
