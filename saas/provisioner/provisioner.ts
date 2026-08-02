/**
 * Instatic Provisioner Engine — Core site creation, setup, and orchestration.
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { findFreePort } from './portAllocator'
import { spawnSiteProcess, stopSiteProcess, getSiteProcess } from './processManager'
import { registerRoute, unregisterRoute } from '../router/proxy'
import { seedSiteDatabase } from '../templates/templateRegistry'

export interface ProvisionSiteOptions {
  siteName: string
  subdomain: string
  ownerEmail: string
  ownerPassword: string
  displayName?: string
  templateId?: string
  customDomain?: string
}

export interface SiteRecord {
  siteId: string
  siteName: string
  subdomain: string
  customDomain?: string
  ownerEmail: string
  displayName: string
  templateId: string
  port: number
  dbPath: string
  uploadsDir: string
  createdAt: string
  status: 'running' | 'stopped' | 'failed'
  liveUrl: string
  adminUrl: string
}

const REGISTRY_FILE = path.join(process.cwd(), '.tmp/saas/registry.json')

async function loadRegistry(): Promise<Record<string, SiteRecord>> {
  try {
    if (existsSync(REGISTRY_FILE)) {
      const data = await readFile(REGISTRY_FILE, 'utf-8')
      return JSON.parse(data) as Record<string, SiteRecord>
    }
  } catch {
    // Return empty if unreadable
  }
  return {}
}

async function saveRegistry(data: Record<string, SiteRecord>): Promise<void> {
  const dir = path.dirname(REGISTRY_FILE)
  await mkdir(dir, { recursive: true })
  await writeFile(REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

export async function provisionSite(options: ProvisionSiteOptions): Promise<SiteRecord> {
  const siteId = options.subdomain.toLowerCase().trim().replace(/[^a-z0-9-]/g, '')
  if (!siteId) {
    throw new Error('Tên subdomain/siteId không hợp lệ')
  }

  const registry = await loadRegistry()
  if (registry[siteId]) {
    throw new Error(`Website với subdomain "${siteId}" đã tồn tại`)
  }

  const siteDir = path.join(process.cwd(), `.tmp/saas/sites/${siteId}`)
  const dbPath = path.join(siteDir, 'data.db')
  const uploadsDir = path.join(siteDir, 'uploads')

  await mkdir(uploadsDir, { recursive: true })

  // 1. Seed database template if selected
  const templateId = options.templateId ?? 'blank'
  await seedSiteDatabase(templateId, dbPath)

  // 2. Find available TCP port
  const port = await findFreePort(4001)

  // 3. Spawn Bun instance
  spawnSiteProcess(siteId, port, dbPath, uploadsDir)

  // 4. Wait for server readiness
  await waitForServerReady(port)

  // 5. Call CMS /setup endpoint if site needs setup
  const setupStatusRes = await fetch(`http://127.0.0.1:${port}/admin/api/cms/setup/status`)
  if (setupStatusRes.ok) {
    const statusData = (await setupStatusRes.json()) as { needsSetup?: boolean }
    if (statusData.needsSetup) {
      const setupRes = await fetch(`http://127.0.0.1:${port}/admin/api/cms/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteName: options.siteName,
          email: options.ownerEmail,
          password: options.ownerPassword,
          displayName: options.displayName ?? 'Site Admin',
        }),
      })

      if (!setupRes.ok) {
        const errText = await setupRes.text()
        throw new Error(`Khởi tạo tài khoản Owner thất bại: ${errText}`)
      }
    }
  }

  const BASE_DOMAIN = (process.env.BASE_DOMAIN || 'onewebs.net').toLowerCase()
  const SCHEME = process.env.NODE_ENV === 'production' || BASE_DOMAIN !== 'localhost' ? 'http' : 'http'

  // 6. Register proxy route for subdomain (e.g. caphe-hanoi.onewebs.net and caphe-hanoi.localhost)
  const mainHost = `${siteId}.${BASE_DOMAIN}`
  registerRoute(mainHost, port, siteId)
  registerRoute(`${siteId}.localhost`, port, siteId)

  if (options.customDomain) {
    registerRoute(options.customDomain, port, siteId)
  }

  const liveUrl = BASE_DOMAIN === 'localhost' ? `http://localhost:${port}` : `${SCHEME}://${mainHost}`
  const adminUrl = BASE_DOMAIN === 'localhost' ? `http://localhost:${port}/admin` : `${SCHEME}://${mainHost}/admin`

  const record: SiteRecord = {
    siteId,
    siteName: options.siteName,
    subdomain: siteId,
    customDomain: options.customDomain,
    ownerEmail: options.ownerEmail,
    displayName: options.displayName ?? 'Site Admin',
    templateId,
    port,
    dbPath,
    uploadsDir,
    createdAt: new Date().toISOString(),
    status: 'running',
    liveUrl,
    adminUrl,
  }

  registry[siteId] = record
  await saveRegistry(registry)

  return record
}

export async function listSites(): Promise<SiteRecord[]> {
  const registry = await loadRegistry()
  const records = Object.values(registry)
  const BASE_DOMAIN = (process.env.BASE_DOMAIN || 'onewebs.net').toLowerCase()
  const SCHEME = process.env.NODE_ENV === 'production' || BASE_DOMAIN !== 'localhost' ? 'https' : 'http'

  for (const record of records) {
    const proc = getSiteProcess(record.siteId)
    if (proc) {
      record.status = proc.status
    }

    // Dynamically upgrade old stored localhost URLs to proper domain URLs
    if (BASE_DOMAIN !== 'localhost' && (record.liveUrl.includes('localhost') || !record.liveUrl.includes(BASE_DOMAIN))) {
      record.liveUrl = `${SCHEME}://${record.subdomain}.${BASE_DOMAIN}`
      record.adminUrl = `${SCHEME}://${record.subdomain}.${BASE_DOMAIN}/admin`
    }
  }

  return records
}

export async function stopSite(siteId: string): Promise<boolean> {
  const registry = await loadRegistry()
  const record = registry[siteId]
  if (!record) return false

  const stopped = stopSiteProcess(siteId)
  record.status = 'stopped'
  await saveRegistry(registry)
  return stopped
}

export async function startSite(siteId: string): Promise<SiteRecord> {
  const registry = await loadRegistry()
  const record = registry[siteId]
  if (!record) throw new Error('Không tìm thấy thông tin website')

  spawnSiteProcess(siteId, record.port, record.dbPath, record.uploadsDir)
  await waitForServerReady(record.port)

  record.status = 'running'
  await saveRegistry(registry)
  return record
}

export async function deleteSite(siteId: string): Promise<boolean> {
  const registry = await loadRegistry()
  const record = registry[siteId]
  if (!record) return false

  stopSiteProcess(siteId)
  unregisterRoute(`${siteId}.localhost`)
  if (record.customDomain) {
    unregisterRoute(record.customDomain)
  }

  const siteDir = path.join(process.cwd(), `.tmp/saas/sites/${siteId}`)
  await rm(siteDir, { recursive: true, force: true })

  delete registry[siteId]
  await saveRegistry(registry)
  return true
}

export async function bindCustomDomain(siteId: string, customDomain: string): Promise<SiteRecord> {
  const registry = await loadRegistry()
  const record = registry[siteId]
  if (!record) throw new Error('Không tìm thấy thông tin website')

  const domainClean = customDomain.trim().toLowerCase()
  if (!domainClean) throw new Error('Tên miền custom domain không hợp lệ')

  if (record.customDomain) {
    unregisterRoute(record.customDomain)
  }

  record.customDomain = domainClean
  registerRoute(domainClean, record.port, siteId)
  await saveRegistry(registry)
  return record
}

export interface SiteStats {
  totalSites: number
  runningSites: number
  stoppedSites: number
  totalStorageBytes: number
  totalStorageFormatted: string
}

export async function getSiteStats(): Promise<SiteStats> {
  const sites = await listSites()
  let runningSites = 0
  let stoppedSites = 0
  let totalStorageBytes = 0

  for (const site of sites) {
    if (site.status === 'running') runningSites++
    else stoppedSites++

    try {
      if (existsSync(site.dbPath)) {
        const fileStat = await Bun.file(site.dbPath).stat()
        totalStorageBytes += fileStat.size
      }
    } catch {
      // Ignore unreadable size
    }
  }

  const formattedStorage =
    totalStorageBytes > 1024 * 1024
      ? `${(totalStorageBytes / (1024 * 1024)).toFixed(2)} MB`
      : `${(totalStorageBytes / 1024).toFixed(1)} KB`

  return {
    totalSites: sites.length,
    runningSites,
    stoppedSites,
    totalStorageBytes,
    totalStorageFormatted: formattedStorage,
  }
}

export async function rehydrateRoutesOnBoot(): Promise<void> {
  const registry = await loadRegistry()
  const BASE_DOMAIN = (process.env.BASE_DOMAIN || 'onewebs.net').toLowerCase()

  for (const record of Object.values(registry)) {
    registerRoute(`${record.subdomain}.${BASE_DOMAIN}`, record.port, record.siteId)
    registerRoute(`${record.subdomain}.localhost`, record.port, record.siteId)
    if (record.customDomain) {
      registerRoute(record.customDomain, record.port, record.siteId)
    }
  }
}

async function waitForServerReady(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/api/cms/setup/status`)
      if (res.ok || res.status === 409 || res.status === 200) {
        return
      }
    } catch {
      // Retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Server Instatic trên port ${port} không phản hồi trong ${timeoutMs}ms`)
}

