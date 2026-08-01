import { describe, expect, test } from 'bun:test'
import { isPortAvailable, findFreePort } from '../provisioner/portAllocator'
import { getRoute, registerRoute, unregisterRoute, generateCaddyfile } from '../router/proxy'
import { STARTER_TEMPLATES } from '../templates/templateRegistry'

describe('SaaS Provisioner Unit Tests', () => {
  test('portAllocator > finds available TCP ports', async () => {
    const port = await findFreePort(4500)
    expect(port).toBeGreaterThanOrEqual(4500)
    const available = await isPortAvailable(port)
    expect(available).toBe(true)
  })

  test('proxyRouter > registers and unregisters domain routes', () => {
    registerRoute('mysite.localhost', 4001, 'mysite')
    const route = getRoute('mysite.localhost')
    expect(route).toBeDefined()
    expect(route?.targetPort).toBe(4001)
    expect(route?.siteId).toBe('mysite')

    const caddyfile = generateCaddyfile()
    expect(caddyfile).toContain('mysite.localhost')
    expect(caddyfile).toContain('reverse_proxy 127.0.0.1:4001')

    const unregistered = unregisterRoute('mysite.localhost')
    expect(unregistered).toBe(true)
    expect(getRoute('mysite.localhost')).toBeUndefined()
  })

  test('templateRegistry > exposes starter templates', () => {
    expect(STARTER_TEMPLATES.blank).toBeDefined()
    expect(STARTER_TEMPLATES.portfolio).toBeDefined()
    expect(STARTER_TEMPLATES.business).toBeDefined()
  })
})
