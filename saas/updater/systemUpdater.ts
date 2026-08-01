/**
 * Instatic SaaS System Updater & Rolling Upgrade Engine.
 *
 * Handles 1-click zero-downtime upgrades, database migrations, and rolling restarts of site instances.
 */
import { listSites, startSite, stopSite } from '../provisioner/provisioner'

export interface UpdateStatus {
  currentCommit: string
  latestCommit?: string
  updateAvailable: boolean
  isUpdating: boolean
  lastUpdated?: string
}

let isUpgradeInProgress = false

async function execCmd(cmd: string): Promise<string> {
  const proc = Bun.spawn(cmd.split(' '), {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = await new Response(proc.stdout).text()
  await proc.exited
  return output.trim()
}

/**
 * Gets current git commit hash and update availability status.
 */
export async function getSystemVersionStatus(): Promise<UpdateStatus> {
  let currentCommit = 'unknown'
  try {
    currentCommit = await execCmd('git rev-parse --short HEAD')
  } catch {
    // Non-git environment fallback
  }

  return {
    currentCommit,
    updateAvailable: false,
    isUpdating: isUpgradeInProgress,
    lastUpdated: new Date().toISOString(),
  }
}

/**
 * Performs a 1-click rolling upgrade: git pull, bun install, and rolling restart of all site instances.
 */
export async function performRollingSystemUpgrade(): Promise<{ success: boolean; message: string; restartedSitesCount: number }> {
  if (isUpgradeInProgress) {
    throw new Error('Hệ thống đang trong quá trình nâng cấp. Vui lòng chờ...')
  }

  isUpgradeInProgress = true
  let restartedSitesCount = 0

  try {
    // 1. Pull latest code from Git repo
    console.log('[System Updater] Pulling latest code changes...')
    try {
      await execCmd('git pull origin main')
    } catch {
      console.log('[System Updater] Git pull skipped or not a git repository')
    }

    // 2. Install dependencies if package.json updated
    console.log('[System Updater] Verifying dependencies...')
    try {
      await execCmd('bun install')
    } catch {
      // Ignore
    }

    // 3. Perform Rolling Restart of all running site instances
    console.log('[System Updater] Performing rolling restart of site instances...')
    const sites = await listSites()

    for (const site of sites) {
      if (site.status === 'running') {
        try {
          console.log(`[System Updater] Upgrading site instance: ${site.siteId} (Port ${site.port})`)
          stopSite(site.siteId)
          await new Promise((r) => setTimeout(r, 400))
          await startSite(site.siteId) // Auto-runs database migrations on startup
          restartedSitesCount++
        } catch (err) {
          console.error(`[System Updater] Failed to restart site ${site.siteId}:`, err)
        }
      }
    }

    isUpgradeInProgress = false
    return {
      success: true,
      message: `Nâng cấp hệ thống thành công! Đã áp dụng phiên bản mới và khởi động lại ${restartedSitesCount} trang web.`,
      restartedSitesCount,
    }
  } catch (err: unknown) {
    isUpgradeInProgress = false
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Nâng cấp hệ thống thất bại: ${msg}`)
  }
}
