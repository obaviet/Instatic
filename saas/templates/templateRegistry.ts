/**
 * Template Registry — Defines starter templates and database seeding logic.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface SiteTemplate {
  id: string
  name: string
  description: string
  category: string
  seedDbPath?: string
}

export const STARTER_TEMPLATES: Record<string, SiteTemplate> = {
  blank: {
    id: 'blank',
    name: 'Khởi Tạo Trắng (Blank)',
    description: 'Trang web mảng trắng mặc định của Instatic, sẵn sàng để tự do thiết kế.',
    category: 'Cơ bản',
  },
  portfolio: {
    id: 'portfolio',
    name: 'Hồ Sơ Cá Nhân (Portfolio)',
    description: 'Mẫu giao diện cá nhân, giới thiệu kinh nghiệm và dự án tiêu biểu.',
    category: 'Cá nhân',
  },
  business: {
    id: 'business',
    name: 'Doanh Nghiệp & Dịch Vụ',
    description: 'Mẫu giao diện công ty với trang chủ, giới thiệu dịch vụ và báo giá.',
    category: 'Doanh nghiệp',
  },
}

export async function seedSiteDatabase(
  templateId: string,
  targetDbPath: string,
  templatesDir = path.join(process.cwd(), 'saas/templates/seeds'),
): Promise<boolean> {
  const targetDir = path.dirname(targetDbPath)
  await mkdir(targetDir, { recursive: true })

  const seedFile = path.join(templatesDir, `${templateId}.db`)
  if (existsSync(seedFile)) {
    await copyFile(seedFile, targetDbPath)
    return true
  }

  // If no seed DB file exists yet, return false so fresh setup creates initial DB
  return false
}
