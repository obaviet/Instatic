/**
 * SaaS Orchestrator Management API & Dashboard Server.
 *
 * Runs on port 9000 by default.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  provisionSite,
  listSites,
  startSite,
  stopSite,
  deleteSite,
  bindCustomDomain,
  getSiteStats,
  rehydrateRoutesOnBoot,
  type ProvisionSiteOptions,
} from '../provisioner/provisioner'
import { STARTER_TEMPLATES } from '../templates/templateRegistry'
import { createProxyServer, generateCaddyfile } from '../router/proxy'
import { registerSaaSUser, loginSaaSUser, verifySession, seedSuperAdmin } from '../auth/usersManager'
import { initClusterNode, listClusterNodes, registerNodeHeartbeat, type ClusterNode } from '../cluster/nodeManager'
import { getSystemVersionStatus, performRollingSystemUpgrade } from '../updater/systemUpdater'

const SAAS_PORT = Number(process.env.SAAS_PORT ?? '9000')
const PROXY_PORT = Number(process.env.PROXY_PORT ?? '8080')

// Rehydrate proxy routes, seed Super Admin & initialize Cluster Node on server boot
await rehydrateRoutesOnBoot()
await seedSuperAdmin()
await initClusterNode()

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

Bun.serve({
  port: SAAS_PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      })
    }

    // SaaS User Auth endpoints
    if (url.pathname === '/api/v1/auth/register' && req.method === 'POST') {
      try {
        const body = (await req.json()) as { email: string; password: string; name?: string }
        const session = await registerSaaSUser(body.name || '', body.email, body.password)
        return json({
          success: true,
          user: session.user,
          token: session.token,
        }, 201)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return json({ error: message }, 400)
      }
    }

    if (url.pathname === '/api/v1/auth/login' && req.method === 'POST') {
      try {
        const body = (await req.json()) as { email: string; password: string }
        const session = await loginSaaSUser(body.email, body.password)
        return json({
          success: true,
          user: session.user,
          token: session.token,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return json({ error: message }, 400)
      }
    }

    if (url.pathname === '/api/v1/auth/me' && req.method === 'GET') {
      const authHeader = req.headers.get('Authorization')
      const token = authHeader?.replace(/^Bearer\s+/i, '') || ''
      const session = await verifySession(token)
      if (!session) return json({ error: 'Phiên đăng nhập hết hạn hoặc không hợp lệ' }, 401)
      return json({ user: session.user })
    }

    // Dashboard UI
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const htmlPath = path.join(process.cwd(), 'saas/dashboard/index.html')
      try {
        const content = await readFile(htmlPath, 'utf-8')
        return new Response(content, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      } catch {
        return new Response('Dashboard UI file not found', { status: 404 })
      }
    }

    // Cluster Multi-Server Nodes API
    if (url.pathname === '/api/v1/cluster/nodes' && req.method === 'GET') {
      const nodes = await listClusterNodes()
      return json(nodes)
    }

    if (url.pathname === '/api/v1/cluster/heartbeat' && req.method === 'POST') {
      try {
        const body = (await req.json()) as Omit<ClusterNode, 'isLocal'>
        const updatedNode = await registerNodeHeartbeat(body)
        return json({ success: true, node: updatedNode })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return json({ error: message }, 400)
      }
    }

    // Templates
    if (url.pathname === '/api/v1/templates' && req.method === 'GET') {
      return json(Object.values(STARTER_TEMPLATES))
    }

    // System Version & Upgrade Endpoints
    if (url.pathname === '/api/v1/admin/version' && req.method === 'GET') {
      const versionStatus = await getSystemVersionStatus()
      return json(versionStatus)
    }

    if (url.pathname === '/api/v1/admin/upgrade' && req.method === 'POST') {
      try {
        const result = await performRollingSystemUpgrade()
        return json(result)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return json({ error: message }, 400)
      }
    }

    // System Health & Diagnostics API
    if (url.pathname === '/api/v1/admin/system' && req.method === 'GET') {
      const stats = await getSiteStats()
      const mem = process.memoryUsage()
      return json({
        uptimeSeconds: Math.floor(process.uptime()),
        memory: {
          rssMb: (mem.rss / (1024 * 1024)).toFixed(2),
          heapTotalMb: (mem.heapTotal / (1024 * 1024)).toFixed(2),
          heapUsedMb: (mem.heapUsed / (1024 * 1024)).toFixed(2),
        },
        runtime: {
          bunVersion: Bun.version,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
        },
        ports: {
          saasPort: SAAS_PORT,
          proxyPort: PROXY_PORT,
        },
        sites: stats,
      })
    }

    // Stats
    if (url.pathname === '/api/v1/stats' && req.method === 'GET') {
      const stats = await getSiteStats()
      return json(stats)
    }

    // Caddyfile export
    if (url.pathname === '/api/v1/caddyfile' && req.method === 'GET') {
      const caddyfile = generateCaddyfile()
      return new Response(caddyfile, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    // List sites
    if (url.pathname === '/api/v1/sites' && req.method === 'GET') {
      const sites = await listSites()
      return json(sites)
    }

    // Provision new site
    if (url.pathname === '/api/v1/provision' && req.method === 'POST') {
      try {
        const body = (await req.json()) as ProvisionSiteOptions
        const record = await provisionSite(body)
        return json({ success: true, site: record }, 201)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return json({ error: message }, 400)
      }
    }

    // Dynamic site operations: /api/v1/sites/:siteId/(start|stop|domain)
    const siteMatch = url.pathname.match(/^\/api\/v1\/sites\/([a-zA-Z0-9-]+)(?:\/(start|stop|domain))?$/)
    if (siteMatch) {
      const [, siteId, action] = siteMatch

      if (req.method === 'DELETE') {
        const success = await deleteSite(siteId)
        return json({ success })
      }

      if (req.method === 'POST' && action === 'start') {
        try {
          const record = await startSite(siteId)
          return json({ success: true, site: record })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          return json({ error: message }, 400)
        }
      }

      if (req.method === 'POST' && action === 'stop') {
        const success = await stopSite(siteId)
        return json({ success })
      }

      if (req.method === 'POST' && action === 'domain') {
        try {
          const body = (await req.json()) as { customDomain?: string }
          if (!body.customDomain) return json({ error: 'Missing customDomain' }, 400)
          const record = await bindCustomDomain(siteId, body.customDomain)
          return json({ success: true, site: record })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          return json({ error: message }, 400)
        }
      }
    }

    return json({ error: 'Endpoint not found' }, 404)
  },
})

// Start multi-tenant proxy router on port 8080
createProxyServer(PROXY_PORT)

console.log('')
console.log('---------------------------------------------------------')
console.log(`[SaaS Orchestrator] API & Dashboard: http://localhost:${SAAS_PORT}`)
console.log(`[SaaS Multi-Tenant Proxy] Router:   http://localhost:${PROXY_PORT}`)
console.log('---------------------------------------------------------')
console.log('')
