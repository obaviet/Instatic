/**
 * Instatic SaaS Multi-Server Cluster & Node Management Engine.
 *
 * Manages Master & Worker Nodes, load balancing site allocations across VPS instances.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface ClusterNode {
  nodeId: string
  nodeName: string
  nodeUrl: string
  role: 'master' | 'worker'
  status: 'healthy' | 'unhealthy' | 'offline'
  maxSites: number
  activeSitesCount: number
  lastHeartbeat: string
  isLocal: boolean
}

const NODES_FILE = path.join(process.cwd(), '.tmp/saas/cluster_nodes.json')
const CURRENT_NODE_ID = process.env.NODE_ID || 'node-local'
const CURRENT_NODE_ROLE = (process.env.NODE_ROLE as 'master' | 'worker') || 'master'
const CURRENT_NODE_URL = process.env.NODE_URL || 'http://127.0.0.1:9000'

async function loadClusterNodes(): Promise<Record<string, ClusterNode>> {
  try {
    if (existsSync(NODES_FILE)) {
      const data = await readFile(NODES_FILE, 'utf-8')
      return JSON.parse(data) as Record<string, ClusterNode>
    }
  } catch {
    // Return empty if unreadable
  }
  return {}
}

async function saveClusterNodes(nodes: Record<string, ClusterNode>): Promise<void> {
  const dir = path.dirname(NODES_FILE)
  await mkdir(dir, { recursive: true })
  await writeFile(NODES_FILE, JSON.stringify(nodes, null, 2), 'utf-8')
}

/**
 * Initializes local cluster node and registers heartbeat.
 */
export async function initClusterNode(): Promise<ClusterNode> {
  const nodes = await loadClusterNodes()

  const localNode: ClusterNode = {
    nodeId: CURRENT_NODE_ID,
    nodeName: CURRENT_NODE_ID === 'node-local' ? 'Local Master Node' : `Cluster Node (${CURRENT_NODE_ID})`,
    nodeUrl: CURRENT_NODE_URL,
    role: CURRENT_NODE_ROLE,
    status: 'healthy',
    maxSites: Number(process.env.MAX_NODE_SITES || '500'),
    activeSitesCount: 0,
    lastHeartbeat: new Date().toISOString(),
    isLocal: true,
  }

  nodes[CURRENT_NODE_ID] = localNode
  await saveClusterNodes(nodes)
  return localNode
}

/**
 * Returns all active nodes in the cluster with health metrics.
 */
export async function listClusterNodes(): Promise<ClusterNode[]> {
  const nodes = await loadClusterNodes()
  const list = Object.values(nodes)
  const now = Date.now()

  // Mark nodes missing heartbeats for > 60s as offline
  for (const node of list) {
    if (!node.isLocal) {
      const age = now - new Date(node.lastHeartbeat).getTime()
      if (age > 60000) {
        node.status = 'offline'
      }
    }
  }

  return list
}

/**
 * Registers or updates a worker VPS node heartbeat.
 */
export async function registerNodeHeartbeat(node: Omit<ClusterNode, 'isLocal'>): Promise<ClusterNode> {
  const nodes = await loadClusterNodes()

  const updatedNode: ClusterNode = {
    ...node,
    isLocal: node.nodeId === CURRENT_NODE_ID,
    lastHeartbeat: new Date().toISOString(),
    status: 'healthy',
  }

  nodes[node.nodeId] = updatedNode
  await saveClusterNodes(nodes)
  return updatedNode
}

/**
 * Intelligent Cluster Load Balancer: Selects the healthiest node with the lowest site load for new site provisioning.
 */
export async function selectBestNodeForProvisioning(): Promise<ClusterNode> {
  const nodesList = await listClusterNodes()
  const healthyNodes = nodesList.filter((n) => n.status === 'healthy' && n.activeSitesCount < n.maxSites)

  if (healthyNodes.length === 0) {
    // Fallback to local node if no external healthy worker found
    const local = nodesList.find((n) => n.isLocal)
    if (local) return local
    throw new Error('Không tìm thấy máy chủ Worker Node nào khả dụng trong cụm Cluster')
  }

  // Sort by lowest active sites count
  healthyNodes.sort((a, b) => a.activeSitesCount - b.activeSitesCount)
  return healthyNodes[0]
}
