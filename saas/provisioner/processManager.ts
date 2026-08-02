/**
 * Process Manager — Manages background Bun subprocesses for site instances.
 */

import path from 'node:path'

export interface ManagedInstanceProcess {
  siteId: string
  port: number
  pid: number | null
  status: 'running' | 'stopped' | 'failed'
  startedAt: string | null
  process: Bun.Subprocess | null
}

const activeProcesses = new Map<string, ManagedInstanceProcess>()

export function spawnSiteProcess(
  siteId: string,
  port: number,
  dbPath: string,
  uploadsDir: string,
  rootDir = process.cwd(),
): ManagedInstanceProcess {
  const existing = activeProcesses.get(siteId)
  if (existing && existing.status === 'running') {
    return existing
  }

  const bunBinary = process.execPath ?? 'bun'
  const command = [bunBinary, 'server/index.ts']

  const masterSecretKey = process.env.INSTATIC_SECRET_KEY?.trim() || 'J2a8X7mP0qN5vL3wR6yT1uK9zF4hB2cG8dE0sA5iO1M='

  const env: Record<string, string> = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: `sqlite:${dbPath}`,
    UPLOADS_DIR: uploadsDir,
    STATIC_DIR: path.join(rootDir, 'dist'),
    INSTATIC_SECRET_KEY: masterSecretKey,
  }

  const child = Bun.spawn(command, {
    cwd: rootDir,
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const instanceRecord: ManagedInstanceProcess = {
    siteId,
    port,
    pid: child.pid,
    status: 'running',
    startedAt: new Date().toISOString(),
    process: child,
  }

  activeProcesses.set(siteId, instanceRecord)

  void child.exited.then((code) => {
    const current = activeProcesses.get(siteId)
    if (current && current.process === child) {
      current.status = code === 0 ? 'stopped' : 'failed'
      current.pid = null
      current.process = null
    }
  })

  return instanceRecord
}

export function stopSiteProcess(siteId: string): boolean {
  const record = activeProcesses.get(siteId)
  if (!record || !record.process) return false

  try {
    record.process.kill('SIGTERM')
    record.status = 'stopped'
    record.pid = null
    record.process = null
    return true
  } catch {
    return false
  }
}

export function getSiteProcess(siteId: string): ManagedInstanceProcess | undefined {
  return activeProcesses.get(siteId)
}

export function getAllSiteProcesses(): ManagedInstanceProcess[] {
  return Array.from(activeProcesses.values())
}
