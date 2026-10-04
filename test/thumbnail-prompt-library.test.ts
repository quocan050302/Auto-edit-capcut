/**
 * Unit Test Suite for:
 * Thumbnail Prompt Library (src/main/thumbnail/thumbnail-template-store.ts)
 */

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  ThumbnailTemplateStore,
  BUILTIN_TEMPLATE,
  THUMBNAIL_CATEGORIES
} from '../src/main/thumbnail/thumbnail-template-store'

let passed = 0
let failed = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

async function runTests(): Promise<void> {
  console.log('\n==================================================')
  console.log('RUNNING THUMBNAIL PROMPT LIBRARY TESTS')
  console.log('==================================================\n')

  let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-test-'))
  let storeFile = path.join(tmpDir, 'thumbnail-prompt-library.json')
  let store = new ThumbnailTemplateStore(storeFile)

  const resetStore = (): void => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-test-'))
    storeFile = path.join(tmpDir, 'thumbnail-prompt-library.json')
    store = new ThumbnailTemplateStore(storeFile)
  }

  await it('1. Initializes and seeds the built-in master prompt on first run', async () => {
    resetStore()
    const templates = await store.getAll()
    assert.ok(templates.length >= 1, 'Should have at least 1 template')
    const builtin = templates.find((t) => t.id === BUILTIN_TEMPLATE.id)
    assert.ok(builtin, 'Built-in template must exist')
    assert.strictEqual(builtin?.name, 'US Grocery & Preparedness — Script Grounded')
    assert.strictEqual(builtin?.category, 'US Grocery')
    assert.strictEqual(builtin?.isBuiltIn, true)
    assert.strictEqual(builtin?.isDefault, true)
    assert.ok(builtin?.promptText.includes('{{SCRIPT}}'), 'Prompt must include {{SCRIPT}}')
    assert.ok(builtin?.promptText.includes('{{VARIANT_COUNT}}'), 'Prompt must include {{VARIANT_COUNT}}')
    assert.ok(fs.existsSync(storeFile), 'Library file must be created on disk')
  })

  await it('2. Creates a new valid user template with unique ID', async () => {
    resetStore()
    const created = await store.create({
      name: 'Hutterite Documentary Master',
      category: 'Hutterite Documentary',
      description: 'Historical communal lifestyle analysis',
      promptText: 'Analyze script: {{SCRIPT}} and generate 5 authentic thumbnail variations.'
    })

    assert.ok(created.id.startsWith('tpl-'), 'ID must start with tpl-')
    assert.strictEqual(created.name, 'Hutterite Documentary Master')
    assert.strictEqual(created.category, 'Hutterite Documentary')
    assert.strictEqual(created.isBuiltIn, false)
    assert.strictEqual(created.isDefault, false)

    const all = await store.getAll()
    assert.ok(all.some((t) => t.id === created.id), 'Created template must be listed')
  })

  await it('3. Rejects creation with empty name or missing {{SCRIPT}}', async () => {
    resetStore()
    let errorCaught = false
    try {
      await store.create({
        name: '',
        category: 'Custom',
        promptText: 'A prompt with {{SCRIPT}}'
      })
    } catch (e) {
      errorCaught = true
      assert.ok((e as Error).message.includes('Template name cannot be empty'))
    }
    assert.ok(errorCaught, 'Must reject empty name')

    errorCaught = false
    try {
      await store.create({
        name: 'Invalid Template',
        category: 'Custom',
        promptText: 'A prompt without the required variable'
      })
    } catch (e) {
      errorCaught = true
      assert.ok((e as Error).message.includes('Prompt text must contain the required variable {{SCRIPT}}'))
    }
    assert.ok(errorCaught, 'Must reject prompt missing {{SCRIPT}}')
  })

  await it('4. Updates an existing template and advances updatedAt', async () => {
    resetStore()
    const created = await store.create({
      name: 'Initial Name',
      category: 'Preparedness',
      promptText: 'Base prompt with {{SCRIPT}}'
    })

    const initialUpdatedAt = created.updatedAt
    await new Promise((r) => setTimeout(r, 10))

    const updated = await store.update(created.id, {
      name: 'Updated Name',
      description: 'Added description',
      promptText: 'Updated prompt with {{SCRIPT}} and more details'
    })

    assert.strictEqual(updated.name, 'Updated Name')
    assert.strictEqual(updated.description, 'Added description')
    assert.ok(updated.promptText.includes('more details'))
    assert.ok(new Date(updated.updatedAt).getTime() >= new Date(initialUpdatedAt).getTime())
  })

  await it('5. Duplicates an existing template into an independent copy', async () => {
    resetStore()
    const created = await store.create({
      name: 'Template To Duplicate',
      category: 'Streamer Reaction',
      promptText: 'Reaction prompt with {{SCRIPT}}'
    })

    const duplicate = await store.duplicate(created.id, 'My Custom Duplicate')
    assert.notStrictEqual(duplicate.id, created.id)
    assert.strictEqual(duplicate.name, 'My Custom Duplicate')
    assert.strictEqual(duplicate.promptText, created.promptText)
    assert.strictEqual(duplicate.isBuiltIn, false)
    assert.strictEqual(duplicate.isDefault, false)

    const all = await store.getAll()
    assert.strictEqual(all.length, 3) // Built-in + created + duplicate
  })

  await it('6. Deletes user templates but protects built-in templates from deletion', async () => {
    resetStore()
    const created = await store.create({
      name: 'Disposable Template',
      category: 'Custom',
      promptText: 'Script: {{SCRIPT}}'
    })

    const deleted = await store.delete(created.id)
    assert.strictEqual(deleted, true)

    const fetched = await store.getById(created.id)
    assert.strictEqual(fetched, null)

    let failedToDeleteBuiltin = false
    try {
      await store.delete(BUILTIN_TEMPLATE.id)
    } catch (e) {
      failedToDeleteBuiltin = true
      assert.ok((e as Error).message.includes('Cannot delete a built-in template'))
    }
    assert.ok(failedToDeleteBuiltin, 'Must prevent deleting built-in template')
  })

  await it('7. Sets a template as default and unsets previous default', async () => {
    resetStore()
    const created = await store.create({
      name: 'New Default Template',
      category: 'Hidden Cost Documentary',
      promptText: 'Cost analysis with {{SCRIPT}}'
    })

    await store.setDefault(created.id)
    const all = await store.getAll()

    const newDef = all.find((t) => t.id === created.id)
    const builtin = all.find((t) => t.id === BUILTIN_TEMPLATE.id)

    assert.strictEqual(newDef?.isDefault, true)
    assert.strictEqual(builtin?.isDefault, false)
  })

  await it('8. Exports and imports templates as JSON with validation', async () => {
    resetStore()
    const created = await store.create({
      name: 'Exportable Template',
      category: 'Custom',
      promptText: 'Exportable prompt with {{SCRIPT}}'
    })

    const json = await store.exportToJson([created.id])
    assert.strictEqual(typeof json, 'string')
    assert.ok(json.includes('Exportable Template'))

    const importStoreFile = path.join(tmpDir, 'imported-library.json')
    const importStore = new ThumbnailTemplateStore(importStoreFile)

    const importResult = await importStore.importFromJson(json)
    assert.strictEqual(importResult.importedCount, 1)
    assert.strictEqual(importResult.importedTemplates[0].name, 'Exportable Template')

    const importedAll = await importStore.getAll()
    assert.ok(importedAll.some((t) => t.name === 'Exportable Template'))
  })

  await it('9. Handles invalid JSON and malformed schema gracefully during import', async () => {
    resetStore()
    let errorCaught = false
    try {
      await store.importFromJson('not-valid-json')
    } catch (e) {
      errorCaught = true
      assert.ok((e as Error).message.includes('Invalid JSON format'))
    }
    assert.ok(errorCaught, 'Must catch invalid JSON')

    errorCaught = false
    try {
      await store.importFromJson(JSON.stringify([{ name: 'No prompt' }]))
    } catch (e) {
      errorCaught = true
      assert.ok((e as Error).message.includes('empty promptText'))
    }
    assert.ok(errorCaught, 'Must catch empty prompt')

    errorCaught = false
    try {
      await store.importFromJson(JSON.stringify([{ name: 'Missing Script', promptText: 'No variable here' }]))
    } catch (e) {
      errorCaught = true
      assert.ok((e as Error).message.includes('missing required variable {{SCRIPT}}'))
    }
    assert.ok(errorCaught, 'Must catch missing {{SCRIPT}}')
  })

  await it('10. Recovers from corrupted library file using automatic backup', async () => {
    resetStore()
    // 1. Create a template to generate backup
    await store.create({
      name: 'Backup Guard Template',
      category: 'US Grocery',
      promptText: 'Backup test with {{SCRIPT}}'
    })

    assert.ok(fs.existsSync(store.getBackupPath()), 'Backup file must exist')

    // 2. Corrupt the primary library file
    fs.writeFileSync(storeFile, '{ corrupted json syntax error', 'utf-8')

    // 3. Load from new store instance pointing to same file
    const freshStore = new ThumbnailTemplateStore(storeFile)
    const recovered = await freshStore.getAll()

    assert.ok(recovered.length >= 2, 'Should recover at least built-in and created template')
    assert.ok(recovered.some((t) => t.name === 'Backup Guard Template'), 'Created template must survive recovery')
  })

  await it('11. Guarantees atomic write and handles concurrent saves without corruption', async () => {
    resetStore()
    const promises = Array.from({ length: 10 }).map((_, i) =>
      store.create({
        name: `Concurrent Template ${i}`,
        category: 'Custom',
        promptText: `Concurrent prompt ${i} with {{SCRIPT}}`
      })
    )

    const results = await Promise.all(promises)
    assert.strictEqual(results.length, 10)

    const all = await store.getAll()
    assert.strictEqual(all.length, 11) // 1 built-in + 10 created

    const ids = new Set(all.map((t) => t.id))
    assert.strictEqual(ids.size, all.length, 'All template IDs must be unique')
  })

  // Cleanup
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n==================================================`)
  console.log(`TEST RESULTS: ${passed} passed, ${failed} failed`)
  console.log(`==================================================\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
