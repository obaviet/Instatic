/**
 * SaaS User Account & Authentication Persistence Manager.
 *
 * Stores user credentials in .tmp/saas/users.json with Bun.password bcrypt hashing.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface SaaSUser {
  id: string
  name: string
  email: string
  passwordHash: string
  role: 'owner' | 'admin' | 'user'
  createdAt: string
}

export interface AuthSession {
  token: string
  userId: string
  user: Omit<SaaSUser, 'passwordHash'>
  expiresAt: string
}

const USERS_FILE = path.join(process.cwd(), '.tmp/saas/users.json')
const SESSIONS_FILE = path.join(process.cwd(), '.tmp/saas/sessions.json')

async function loadUsers(): Promise<Record<string, SaaSUser>> {
  try {
    if (existsSync(USERS_FILE)) {
      const data = await readFile(USERS_FILE, 'utf-8')
      return JSON.parse(data) as Record<string, SaaSUser>
    }
  } catch {
    // Return empty if unreadable
  }
  return {}
}

async function saveUsers(users: Record<string, SaaSUser>): Promise<void> {
  const dir = path.dirname(USERS_FILE)
  await mkdir(dir, { recursive: true })
  await writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8')
}

async function loadSessions(): Promise<Record<string, AuthSession>> {
  try {
    if (existsSync(SESSIONS_FILE)) {
      const data = await readFile(SESSIONS_FILE, 'utf-8')
      return JSON.parse(data) as Record<string, AuthSession>
    }
  } catch {
    // Return empty if unreadable
  }
  return {}
}

async function saveSessions(sessions: Record<string, AuthSession>): Promise<void> {
  const dir = path.dirname(SESSIONS_FILE)
  await mkdir(dir, { recursive: true })
  await writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf-8')
}

export async function registerSaaSUser(name: string, email: string, passwordRaw: string): Promise<AuthSession> {
  const emailClean = email.toLowerCase().trim()
  if (!emailClean || !passwordRaw) {
    throw new Error('Thiếu email hoặc mật khẩu đăng ký')
  }

  if (passwordRaw.length < 8) {
    throw new Error('Mật khẩu phải có độ dài tối thiểu 8 ký tự')
  }

  const users = await loadUsers()
  if (users[emailClean]) {
    throw new Error(`Email "${emailClean}" đã được đăng ký tài khoản`)
  }

  // Hash password using native Bun password hashing
  const passwordHash = await Bun.password.hash(passwordRaw)
  const userId = `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`

  const userRecord: SaaSUser = {
    id: userId,
    name: name.trim() || emailClean.split('@')[0],
    email: emailClean,
    passwordHash,
    role: 'owner',
    createdAt: new Date().toISOString(),
  }

  users[emailClean] = userRecord
  await saveUsers(users)

  return createSession(userRecord)
}

export async function loginSaaSUser(email: string, passwordRaw: string): Promise<AuthSession> {
  const emailClean = email.toLowerCase().trim()
  if (!emailClean || !passwordRaw) {
    throw new Error('Vui lòng nhập đầy đủ email và mật khẩu')
  }

  const users = await loadUsers()
  const userRecord = users[emailClean]
  if (!userRecord) {
    throw new Error('Email hoặc mật khẩu không chính xác')
  }

  // Verify password hash using Bun native verify
  const isValid = await Bun.password.verify(passwordRaw, userRecord.passwordHash)
  if (!isValid) {
    throw new Error('Email hoặc mật khẩu không chính xác')
  }

  return createSession(userRecord)
}

async function createSession(userRecord: SaaSUser): Promise<AuthSession> {
  const sessions = await loadSessions()
  const token = `saas_session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

  const session: AuthSession = {
    token,
    userId: userRecord.id,
    user: {
      id: userRecord.id,
      name: userRecord.name,
      email: userRecord.email,
      role: userRecord.role,
      createdAt: userRecord.createdAt,
    },
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
  }

  sessions[token] = session
  await saveSessions(sessions)

  return session
}

export async function verifySession(token: string): Promise<AuthSession | null> {
  if (!token) return null
  const sessions = await loadSessions()
  const session = sessions[token]
  if (!session) return null

  if (new Date(session.expiresAt).getTime() < Date.now()) {
    delete sessions[token]
    await saveSessions(sessions)
    return null
  }

  return session
}

export async function seedSuperAdmin(): Promise<void> {
  const users = await loadUsers()
  const adminEmail = 'admin@instatic.cloud'

  if (!users[adminEmail]) {
    const passwordHash = await Bun.password.hash('AdminPassword123!')
    users[adminEmail] = {
      id: 'user_super_admin',
      name: 'Super Admin',
      email: adminEmail,
      passwordHash,
      role: 'admin',
      createdAt: new Date().toISOString(),
    }
    await saveUsers(users)
    console.log('[SaaS Auth] Seeded default Super Admin account: admin@instatic.cloud')
  }
}
