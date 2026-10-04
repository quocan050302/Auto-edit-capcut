import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../logger'
import type { ThumbnailPromptTemplate } from '../../../shared/types'

export const THUMBNAIL_CATEGORIES = [
  'US Grocery',
  'Preparedness',
  'Hutterite Documentary',
  'Hidden Cost Documentary',
  'Streamer Reaction',
  'Custom'
] as const

export const BUILT_IN_PROMPT_CATEGORIES = THUMBNAIL_CATEGORIES

export const BUILTIN_MASTER_PROMPT_TEXT = `# MASTER PROMPT — SCRIPT TO YOUTUBE THUMBNAIL

Bạn là chuyên gia thiết kế thumbnail cho kênh YouTube thị trường Mỹ.

Đọc toàn bộ script được cung cấp và tạo đúng {{VARIANT_COUNT}} phương án thumbnail khác nhau. Giá trị mặc định của {{VARIANT_COUNT}} là 5.

Mục tiêu hình ảnh:

- Ảnh chụp đời thực, photorealistic, giàu chi tiết và trông như một khoảnh khắc có thể xảy ra tại Mỹ.
- Bối cảnh có thể là siêu thị dạng kho, kệ thực phẩm, quầy đồ hộp, cửa hàng tạp hóa, bãi đỗ xe hoặc kho dự trữ tại nhà, tùy nội dung script.
- Thumbnail 16:9, thiết kế ở 3840 × 2160 px.
- Hai dòng chữ cực lớn ở vùng 35–45% phía trên ảnh.
- Dòng đầu màu vàng tươi.
- Dòng thứ hai màu trắng.
- Chữ in hoa, condensed sans-serif siêu đậm, viền đen dày và bóng tối nhẹ.
- Phần dưới thể hiện rõ thực phẩm, vật dụng, con người hoặc tình huống trung tâm.
- Thumbnail phải đọc được trên điện thoại.
- Mỗi phương án phải tạo một curiosity gap nhưng không được bóp méo nội dung script.

DỮ LIỆU ĐẦU VÀO

FULL SCRIPT:

{{SCRIPT}}

VIDEO TITLE HIỆN CÓ:

{{VIDEO_TITLE}}

GLOBAL VISUAL CONTEXT:

{{GLOBAL_VISUAL_CONTEXT}}

OUTPUT LANGUAGE:

{{OUTPUT_LANGUAGE}}

CÁC CONCEPT ĐÃ DÙNG Ở CÁC ROUND TRƯỚC:

{{PREVIOUS_CONCEPTS}}

BƯỚC 1 — HIỂU SCRIPT

Đọc toàn bộ script và xác định:

1. Chủ đề chính video thực sự giải thích.
2. Một chi tiết cụ thể và dễ thể hiện bằng hình ảnh.
3. Điều người xem lo lắng hoặc muốn đạt được.
4. Lời hứa thực tế video có thể đáp ứng.
5. Các con số, địa điểm, thời hạn hoặc sản phẩm được script nhắc đến rõ ràng.
6. Những tuyên bố không được phép suy diễn thêm.

Không lấy riêng một câu giật gân rồi tạo thumbnail sai trọng tâm.

Không tự bịa:

- Tình trạng thiếu hàng.
- Tăng giá.
- Thiên tai.
- Hạn chót.
- Khủng hoảng.
- Con số.
- Dự báo.
- Sự kiện chưa được script hỗ trợ.

Nếu script chỉ nói về cách chuẩn bị nói chung, sử dụng hook về lợi ích hoặc sự tò mò, không tuyên bố một cuộc khủng hoảng sắp xảy ra.

BƯỚC 2 — TẠO ĐÚNG 5 GÓC THUMBNAIL

Tạo đúng 5 phương án khác nhau về ý tưởng hình ảnh, bố cục, chủ thể hoặc curiosity gap.

Có thể sử dụng các hướng:

A — Con người và tình huống:
Người mua hàng, gia đình, giỏ hàng hoặc một hành động cụ thể. Khuôn mặt và hành động đủ lớn để nhìn rõ khi thu nhỏ.

B — Sản phẩm và giải pháp:
Kệ hàng, thực phẩm hoặc vật dụng thiết yếu được xếp rõ ràng. Có một nhóm sản phẩm chính nổi bật.

C — Hậu quả hoặc sự thay đổi:
Giá tại quầy, kệ hàng, before/after hoặc sự thay đổi đối với người xem, nhưng chỉ khi script hỗ trợ.

D — Proof object:
Một vật thể chứng minh trọng tâm video như receipt, price tag, shelf label, grocery total, pantry inventory hoặc sản phẩm cụ thể được script nhắc đến.

E — Curiosity or contrast:
Một sự đối lập rõ ràng, một tình huống chưa giải thích hết hoặc một chi tiết khiến người xem muốn biết nguyên nhân.

Nếu một hướng không phù hợp, thay bằng một hướng khác phù hợp hơn.

Năm phương án không được chỉ thay đổi vài chữ trên cùng một bức ảnh.

BƯỚC 3 — QUY TẮC TEXT OVERLAY

Mỗi thumbnail có đúng hai dòng chữ.

- Dòng 1 màu vàng tươi.
- Dòng 2 màu trắng.
- Ưu tiên tổng cộng 4–7 từ.
- Tối đa 9 từ nếu thật cần thiết.
- Chữ phải hiểu được trong chưa đến một giây.
- Chỉ thể hiện một thông điệp chính.
- Không thêm logo, badge, mũi tên hoặc dòng phụ không cần thiết.
- Không dùng ngày tháng hoặc hạn chót nếu script không xác nhận.
- Không dùng tuyên bố tuyệt đối như NEVER EXPIRE, GUARANTEED hoặc WILL BE DEVASTATING nếu script không hỗ trợ.
- Text thumbnail và title phải bổ sung cho nhau.
- Không lặp lại nguyên văn toàn bộ thumbnail text trong title.
- Kiểm tra chính tả tiếng Anh Mỹ.
- Tất cả text xuất hiện trên thumbnail phải là tiếng Anh Mỹ.

BƯỚC 4 — IMAGE PROMPT

Mỗi option phải có một IMAGE PROMPT đầy đủ bằng tiếng Anh và sẵn sàng gửi trực tiếp sang Google Flow.

Mỗi image prompt phải tự đầy đủ, không viết “same as above” và không tham chiếu option khác.

Image prompt phải mô tả:

1. YouTube thumbnail 16:9, 3840 × 2160.
2. Địa điểm cụ thể tại Mỹ phù hợp với script.
3. Chủ thể chính, vị trí, kích thước, hành động và biểu cảm.
4. Bố cục với vùng chữ phía trên.
5. Không để chữ che mặt, tay hoặc proof object.
6. Tiền cảnh rõ, hậu cảnh có ngữ cảnh nhưng không rối.
7. Photorealistic documentary look.
8. Tương phản cao nhưng da người tự nhiên.
9. Hai dòng text chính xác đã chọn.
10. Dòng đầu màu vàng và dòng thứ hai màu trắng.
11. Font condensed sans-serif siêu đậm, chữ in hoa, viền đen dày.
12. Safe margin.
13. Không đặt thông tin quan trọng ở góc dưới bên phải.
14. Giải phẫu chính xác.
15. Không có mặt hoặc bàn tay bị méo.
16. Không lặp người.
17. Không có bao bì biến dạng quá mức.
18. Không logo hoặc watermark ngoài nội dung được yêu cầu.

Nếu script nói về người hoặc cộng đồng có thật, không trình bày cảnh dàn dựng như bằng chứng chụp tại một sự kiện có thật.

BƯỚC 5 — TITLE

Với mỗi option, tạo hai title tiếng Anh Mỹ:

- titleClear: nói rõ video mang lại thông tin gì.
- titleCuriosity: tạo lý do bấm xem nhưng vẫn đúng nội dung.

Không tự tạo con số chỉ để tăng click.

BƯỚC 6 — ROUND MỚI

Nếu PREVIOUS_CONCEPTS không trống:

- Không lặp lại concept cũ.
- Không chỉ đổi góc camera hoặc vài từ.
- Phải tạo 5 ý tưởng hình ảnh mới thực sự khác biệt.
- Vẫn giữ đúng nội dung script và visual identity của niche.

OUTPUT

Chỉ trả về một JSON object hợp lệ.

Không markdown.
Không code fence.
Không giải thích bên ngoài JSON.
Không trailing comma.

Schema bắt buộc:

{
  "scriptInsight": {
    "mainTopic": "string",
    "groundedHook": "string",
    "strongestVisualDetail": "string",
    "viewerConcernOrGoal": "string",
    "unsupportedClaimsToAvoid": ["string"]
  },
  "options": [
    {
      "id": "A",
      "conceptName": "string",
      "yellowText": "string",
      "whiteText": "string",
      "visualConcept": "string",
      "imagePrompt": "complete English prompt",
      "titleClear": "string",
      "titleCuriosity": "string",
      "whyItWorks": "string"
    }
  ],
  "recommendedOptionId": "A",
  "recommendationReason": "string",
  "postGenerationCheck": "string"
}

Yêu cầu bắt buộc:

- options phải có đúng 5 phần tử.
- ID lần lượt là A, B, C, D, E.
- Mỗi imagePrompt phải đầy đủ.
- Không để placeholder.
- Không viết same as above.
- Chưa tạo ảnh trong bước lập kế hoạch này.`

export const BUILTIN_TEMPLATE: ThumbnailPromptTemplate = {
  id: 'builtin-us-grocery-preparedness',
  name: 'US Grocery & Preparedness — Script Grounded',
  description:
    'Script-grounded 5-variant YouTube thumbnail generator tailored for US grocery and preparedness topics with bold 2-line overlay text.',
  category: 'US Grocery',
  promptText: BUILTIN_MASTER_PROMPT_TEXT,
  isBuiltIn: true,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

export interface LibraryFileSchema {
  schemaVersion: number
  updatedAt: string
  templates: ThumbnailPromptTemplate[]
}

export class ThumbnailTemplateStore {
  private customPath?: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(customPath?: string) {
    this.customPath = customPath
  }

  public getFilePath(): string {
    if (this.customPath) {
      return this.customPath
    }
    const dir = app && typeof app.getPath === 'function' ? app.getPath('userData') : process.cwd()
    return path.join(dir, 'thumbnail-prompt-library.json')
  }

  public getBackupPath(): string {
    return `${this.getFilePath()}.backup.json`
  }

  private runInLock<T>(task: () => Promise<T>): Promise<T> {
    const res = this.queue.then(task, task)
    this.queue = res.catch(() => {})
    return res
  }

  public async getAll(): Promise<ThumbnailPromptTemplate[]> {
    return this.runInLock(async () => this.loadInternal())
  }

  public async getById(id: string): Promise<ThumbnailPromptTemplate | null> {
    return this.runInLock(async () => {
      const list = await this.loadInternal()
      return list.find((t) => t.id === id) || null
    })
  }

  public async getDefault(): Promise<ThumbnailPromptTemplate> {
    return this.runInLock(async () => {
      const list = await this.loadInternal()
      const def = list.find((t) => t.isDefault)
      if (def) return def
      const builtin = list.find((t) => t.isBuiltIn)
      if (builtin) return builtin
      return list[0] || BUILTIN_TEMPLATE
    })
  }

  public async create(data: {
    name: string
    description?: string
    category: string
    promptText: string
    isDefault?: boolean
  }): Promise<ThumbnailPromptTemplate> {
    this.validateTemplateData(data.name, data.promptText)

    return this.runInLock(async () => {
      const list = await this.loadInternal()
      const now = new Date().toISOString()
      const id = `tpl-${uuidv4()}`

      const newTemplate: ThumbnailPromptTemplate = {
        id,
        name: data.name.trim(),
        description: data.description?.trim() || undefined,
        category: data.category?.trim() || 'Custom',
        promptText: data.promptText.trim(),
        isBuiltIn: false,
        isDefault: Boolean(data.isDefault),
        createdAt: now,
        updatedAt: now
      }

      if (newTemplate.isDefault) {
        list.forEach((t) => {
          t.isDefault = false
        })
      }

      list.push(newTemplate)
      await this.saveInternal(list)
      return newTemplate
    })
  }

  public async update(
    id: string,
    updates: {
      name?: string
      description?: string
      category?: string
      promptText?: string
      isDefault?: boolean
    }
  ): Promise<ThumbnailPromptTemplate> {
    return this.runInLock(async () => {
      const list = await this.loadInternal()
      const index = list.findIndex((t) => t.id === id)
      if (index === -1) {
        throw new Error(`Template not found: ${id}`)
      }

      const current = list[index]
      const nextName = updates.name !== undefined ? updates.name : current.name
      const nextPrompt = updates.promptText !== undefined ? updates.promptText : current.promptText

      this.validateTemplateData(nextName, nextPrompt)

      const now = new Date().toISOString()

      if (updates.isDefault) {
        list.forEach((t) => {
          t.isDefault = false
        })
      }

      const updated: ThumbnailPromptTemplate = {
        ...current,
        name: nextName.trim(),
        description: updates.description !== undefined ? updates.description.trim() || undefined : current.description,
        category: updates.category !== undefined ? updates.category.trim() : current.category,
        promptText: nextPrompt.trim(),
        isDefault: updates.isDefault !== undefined ? updates.isDefault : current.isDefault,
        updatedAt: now
      }

      list[index] = updated
      await this.saveInternal(list)
      return updated
    })
  }

  public async duplicate(id: string, newName?: string): Promise<ThumbnailPromptTemplate> {
    return this.runInLock(async () => {
      const list = await this.loadInternal()
      const source = list.find((t) => t.id === id)
      if (!source) {
        throw new Error(`Template not found: ${id}`)
      }

      const now = new Date().toISOString()
      const copyName = newName?.trim() || `${source.name} (Copy)`
      const newTemplate: ThumbnailPromptTemplate = {
        ...source,
        id: `tpl-${uuidv4()}`,
        name: copyName,
        isBuiltIn: false,
        isDefault: false,
        createdAt: now,
        updatedAt: now
      }

      list.push(newTemplate)
      await this.saveInternal(list)
      return newTemplate
    })
  }

  public async delete(id: string): Promise<boolean> {
    return this.runInLock(async () => {
      const list = await this.loadInternal()
      const target = list.find((t) => t.id === id)
      if (!target) {
        return false
      }

      if (target.isBuiltIn) {
        throw new Error('Cannot delete a built-in template')
      }

      const filtered = list.filter((t) => t.id !== id)

      // If deleted template was default, make another one default
      if (target.isDefault && filtered.length > 0) {
        const builtin = filtered.find((t) => t.isBuiltIn) || filtered[0]
        builtin.isDefault = true
      }

      await this.saveInternal(filtered)
      return true
    })
  }

  public async setDefault(id: string): Promise<ThumbnailPromptTemplate> {
    return this.runInLock(async () => {
      const list = await this.loadInternal()
      const target = list.find((t) => t.id === id)
      if (!target) {
        throw new Error(`Template not found: ${id}`)
      }

      list.forEach((t) => {
        t.isDefault = t.id === id
      })

      await this.saveInternal(list)
      return target
    })
  }

  public async exportToJson(ids?: string[]): Promise<string> {
    return this.runInLock(async () => {
      const list = await this.loadInternal()
      const toExport = ids && ids.length > 0 ? list.filter((t) => ids.includes(t.id)) : list
      return JSON.stringify(toExport, null, 2)
    })
  }

  public async importFromJson(
    jsonString: string
  ): Promise<{ importedCount: number; importedTemplates: ThumbnailPromptTemplate[] }> {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonString)
    } catch (err) {
      throw new Error(`Invalid JSON format: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Support array or { templates: [...] }
    let rawTemplates: unknown[]
    if (Array.isArray(parsed)) {
      rawTemplates = parsed
    } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).templates)) {
      rawTemplates = (parsed as Record<string, unknown>).templates as unknown[]
    } else {
      throw new Error('Import data must be a JSON array of templates or an object with a "templates" array')
    }

    if (rawTemplates.length === 0) {
      throw new Error('No templates found in import data')
    }

    return this.runInLock(async () => {
      const currentList = await this.loadInternal()
      const existingIds = new Set(currentList.map((t) => t.id))
      const importedTemplates: ThumbnailPromptTemplate[] = []
      const now = new Date().toISOString()

      for (let i = 0; i < rawTemplates.length; i++) {
        const item = rawTemplates[i]
        if (!item || typeof item !== 'object') {
          throw new Error(`Template at index ${i} is not a valid object`)
        }
        const record = item as Record<string, unknown>
        const name = typeof record.name === 'string' ? record.name.trim() : ''
        const promptText = typeof record.promptText === 'string' ? record.promptText.trim() : ''
        const category = typeof record.category === 'string' ? record.category.trim() : 'Custom'
        const description = typeof record.description === 'string' ? record.description.trim() : undefined

        if (!name) {
          throw new Error(`Template at index ${i} has empty name`)
        }
        if (!promptText) {
          throw new Error(`Template "${name}" has empty promptText`)
        }
        if (!promptText.includes('{{SCRIPT}}')) {
          throw new Error(`Template "${name}" is missing required variable {{SCRIPT}}`)
        }

        // Guarantee unique ID
        let id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `tpl-${uuidv4()}`
        if (existingIds.has(id)) {
          id = `tpl-${uuidv4()}`
        }
        existingIds.add(id)

        const template: ThumbnailPromptTemplate = {
          id,
          name,
          description,
          category,
          promptText,
          isBuiltIn: false,
          isDefault: false,
          createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
          updatedAt: now
        }

        currentList.push(template)
        importedTemplates.push(template)
      }

      await this.saveInternal(currentList)
      return {
        importedCount: importedTemplates.length,
        importedTemplates
      }
    })
  }

  public validateTemplateData(name: string, promptText: string): void {
    if (!name || !name.trim()) {
      throw new Error('Template name cannot be empty')
    }
    if (!promptText || !promptText.trim()) {
      throw new Error('Prompt text cannot be empty')
    }
    if (!promptText.includes('{{SCRIPT}}')) {
      throw new Error('Prompt text must contain the required variable {{SCRIPT}}')
    }
  }

  private async loadInternal(): Promise<ThumbnailPromptTemplate[]> {
    const filePath = this.getFilePath()
    const backupPath = this.getBackupPath()

    let raw = ''
    let loadedFromBackup = false

    if (fs.existsSync(filePath)) {
      try {
        raw = fs.readFileSync(filePath, 'utf-8')
      } catch (err) {
        logger.warn(`[ThumbnailStore] Failed to read primary library file: ${err}`)
      }
    }

    if (!raw && fs.existsSync(backupPath)) {
      try {
        raw = fs.readFileSync(backupPath, 'utf-8')
        loadedFromBackup = true
        logger.info('[ThumbnailStore] Recovered template library from backup')
      } catch (err) {
        logger.warn(`[ThumbnailStore] Failed to read backup file: ${err}`)
      }
    }

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as LibraryFileSchema | ThumbnailPromptTemplate[]
        let templates: ThumbnailPromptTemplate[] = []
        if (Array.isArray(parsed)) {
          templates = parsed
        } else if (parsed && Array.isArray(parsed.templates)) {
          templates = parsed.templates
        }

        // Ensure built-in template always exists
        const hasBuiltin = templates.some((t) => t.isBuiltIn && t.id === BUILTIN_TEMPLATE.id)
        if (!hasBuiltin) {
          templates.unshift({ ...BUILTIN_TEMPLATE })
        }

        // Ensure exactly one default
        const hasDefault = templates.some((t) => t.isDefault)
        if (!hasDefault && templates.length > 0) {
          const builtin = templates.find((t) => t.isBuiltIn) || templates[0]
          builtin.isDefault = true
        }

        if (loadedFromBackup) {
          await this.saveInternal(templates)
        }

        return templates
      } catch (err) {
        logger.error(`[ThumbnailStore] Corrupted library file: ${err}. Attempting recovery...`)
        if (!loadedFromBackup && fs.existsSync(backupPath)) {
          try {
            const bRaw = fs.readFileSync(backupPath, 'utf-8')
            const bParsed = JSON.parse(bRaw) as LibraryFileSchema | ThumbnailPromptTemplate[]
            const bTemplates = Array.isArray(bParsed) ? bParsed : bParsed.templates || []
            if (bTemplates.length > 0) {
              // Ensure built-in template exists
              if (!bTemplates.some((t) => t.isBuiltIn && t.id === BUILTIN_TEMPLATE.id)) {
                bTemplates.unshift({ ...BUILTIN_TEMPLATE })
              }
              await this.saveInternal(bTemplates)
              return bTemplates
            }
          } catch {
            // backup corrupted too
          }
        }
      }
    }

    // Default seed
    const initialList: ThumbnailPromptTemplate[] = [{ ...BUILTIN_TEMPLATE }]
    await this.saveInternal(initialList)
    return initialList
  }

  private async saveInternal(templates: ThumbnailPromptTemplate[]): Promise<void> {
    const filePath = this.getFilePath()
    const backupPath = this.getBackupPath()
    const dir = path.dirname(filePath)

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const payload: LibraryFileSchema = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      templates
    }

    const serialized = JSON.stringify(payload, null, 2)
    const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`

    // Atomic write via tmp + rename
    fs.writeFileSync(tmpPath, serialized, 'utf-8')
    try {
      fs.renameSync(tmpPath, filePath)
      // Keep backup updated with latest valid file
      try {
        fs.copyFileSync(filePath, backupPath)
      } catch {
        // ignore
      }
    } finally {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath)
        } catch {
          // ignore
        }
      }
    }
  }
}

export const thumbnailTemplateStore = new ThumbnailTemplateStore()
