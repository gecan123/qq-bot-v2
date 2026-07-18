import { NCWebsocket } from 'node-napcat-ts'
import { config } from '../config/index.js'

export const napcat = new NCWebsocket({
  baseUrl: config.napcat.wsUrl,
  accessToken: config.napcat.accessToken,
  throwPromise: true,
  reconnection: {
    enable: true,
    attempts: 10,
    delay: 5000,
  },
})

export function disableNapcatReconnection(context: { reconnection: { enable: boolean } }): void {
  context.reconnection.enable = false
}

export function disconnectNapcatForShutdown(): void {
  napcat.once('socket.close', disableNapcatReconnection)
  napcat.disconnect()
}
