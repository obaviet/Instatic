/**
 * Port Allocator — dynamically finds available TCP ports for site instances.
 */
import { createServer } from 'node:net'

export async function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => {
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => {
        resolve(true)
      })
    })
    server.listen(port, host)
  })
}

export async function findFreePort(startPort = 4001, maxAttempts = 100): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    if (await isPortAvailable(port)) {
      return port
    }
  }
  throw new Error(`No free TCP ports available in range ${startPort}–${startPort + maxAttempts}`)
}
