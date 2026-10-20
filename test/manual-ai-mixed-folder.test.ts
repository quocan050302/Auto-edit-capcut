/**
 * test/manual-ai-mixed-folder.test.ts
 *
 * Unit and integration tests for mixed media folder discovery and media type classification.
 * Covers Part C, D, and Part I (Sections 93, 94, 95, 96).
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  assert,
  cleanupFixtures,
  createRunner,
  freshDir
} from './manual-ai-test-utils'
import {
  detectManualImportMediaType,
  countMixedMedia,
  listMixedMediaInFolder,
  MAX_DISCOVERED_MIXED_MEDIA,
  MAX_MIXED_FOLDER_DEPTH
} from '../src/main/visual-mix/manual-ai/manual-ai-mixed-media'

const { it, finish } = createRunner('Manual AI Mixed Folder Discovery Tests')

async function main(): Promise<void> {
  console.log('\n--- Manual AI Mixed Folder Discovery Tests ---')

  try {
    await it('detectManualImportMediaType: correctly classifies all supported images and videos', () => {
      // Images
      assert.strictEqual(detectManualImportMediaType('s1.png'), 'image')
      assert.strictEqual(detectManualImportMediaType('s1.PNG'), 'image')
      assert.strictEqual(detectManualImportMediaType('s2.jpg'), 'image')
      assert.strictEqual(detectManualImportMediaType('s2.JPG'), 'image')
      assert.strictEqual(detectManualImportMediaType('s3.jpeg'), 'image')
      assert.strictEqual(detectManualImportMediaType('s3.JPEG'), 'image')
      assert.strictEqual(detectManualImportMediaType('s4.webp'), 'image')
      assert.strictEqual(detectManualImportMediaType('s4.WEBP'), 'image')

      // Videos
      assert.strictEqual(detectManualImportMediaType('s5.mp4'), 'video')
      assert.strictEqual(detectManualImportMediaType('s5.MP4'), 'video')
      assert.strictEqual(detectManualImportMediaType('s6.mov'), 'video')
      assert.strictEqual(detectManualImportMediaType('s6.MOV'), 'video')
      assert.strictEqual(detectManualImportMediaType('s7.webm'), 'video')
      assert.strictEqual(detectManualImportMediaType('s7.WEBM'), 'video')
      assert.strictEqual(detectManualImportMediaType('s8.mkv'), 'video')
      assert.strictEqual(detectManualImportMediaType('s8.MKV'), 'video')

      // Unsupported
      assert.strictEqual(detectManualImportMediaType('doc.txt'), 'unsupported')
      assert.strictEqual(detectManualImportMediaType('file.pdf'), 'unsupported')
      assert.strictEqual(detectManualImportMediaType('archive.zip'), 'unsupported')
      assert.strictEqual(detectManualImportMediaType('anim.gif'), 'unsupported')
      assert.strictEqual(detectManualImportMediaType('raw.bmp'), 'unsupported')
      assert.strictEqual(detectManualImportMediaType('noextension'), 'unsupported')
    })

    await it('Section 93: discovers all 8 supported image and video formats in one folder', () => {
      const dir = freshDir('mixed-8-formats')
      fs.writeFileSync(path.join(dir, 'scene_001.jpg'), 'dummy')
      fs.writeFileSync(path.join(dir, 'scene_002.webm'), 'dummy')
      fs.writeFileSync(path.join(dir, 'scene_003.png'), 'dummy')
      fs.writeFileSync(path.join(dir, 'scene_004.mp4'), 'dummy')
      fs.writeFileSync(path.join(dir, 'scene_005.jpeg'), 'dummy')
      fs.writeFileSync(path.join(dir, 'scene_006.mov'), 'dummy')
      fs.writeFileSync(path.join(dir, 'scene_007.webp'), 'dummy')
      fs.writeFileSync(path.join(dir, 'scene_008.mkv'), 'dummy')
      fs.writeFileSync(path.join(dir, 'unsupported.txt'), 'text')
      fs.writeFileSync(path.join(dir, 'audio.mp3'), 'audio')

      const discovered = listMixedMediaInFolder(dir)
      assert.strictEqual(discovered.length, 8)

      const baseNames = discovered.map((f) => path.basename(f))
      assert.ok(baseNames.includes('scene_001.jpg'))
      assert.ok(baseNames.includes('scene_002.webm'))
      assert.ok(baseNames.includes('scene_003.png'))
      assert.ok(baseNames.includes('scene_004.mp4'))
      assert.ok(baseNames.includes('scene_005.jpeg'))
      assert.ok(baseNames.includes('scene_006.mov'))
      assert.ok(baseNames.includes('scene_007.webp'))
      assert.ok(baseNames.includes('scene_008.mkv'))
      assert.ok(!baseNames.includes('unsupported.txt'))
      assert.ok(!baseNames.includes('audio.mp3'))

      const counts = countMixedMedia(discovered)
      assert.strictEqual(counts.imageCount, 4)
      assert.strictEqual(counts.videoCount, 4)
    })

    await it('Section 94: recursively discovers mixed media in nested subdirectories up to maxDepth (3)', () => {
      const root = freshDir('mixed-nested')
      // Level 0
      fs.writeFileSync(path.join(root, 'scene_001.png'), 'd')
      // Level 1
      const l1 = path.join(root, 'sub1')
      fs.mkdirSync(l1)
      fs.writeFileSync(path.join(l1, 'scene_002.mp4'), 'd')
      // Level 2
      const l2 = path.join(l1, 'sub2')
      fs.mkdirSync(l2)
      fs.writeFileSync(path.join(l2, 'scene_003.jpg'), 'd')
      // Level 3
      const l3 = path.join(l2, 'sub3')
      fs.mkdirSync(l3)
      fs.writeFileSync(path.join(l3, 'scene_004.webm'), 'd')
      // Level 4 (beyond depth 3 -> should be skipped)
      const l4 = path.join(l3, 'sub4')
      fs.mkdirSync(l4)
      fs.writeFileSync(path.join(l4, 'scene_005.mov'), 'd')

      const discovered = listMixedMediaInFolder(root, MAX_MIXED_FOLDER_DEPTH)
      const baseNames = discovered.map((f) => path.basename(f))
      assert.strictEqual(discovered.length, 4)
      assert.ok(baseNames.includes('scene_001.png'))
      assert.ok(baseNames.includes('scene_002.mp4'))
      assert.ok(baseNames.includes('scene_003.jpg'))
      assert.ok(baseNames.includes('scene_004.webm'))
      assert.ok(!baseNames.includes('scene_005.mov'))
    })

    await it('Section 95: supports uppercase extensions (.JPG, .PNG, .WEBM, .MP4)', () => {
      const dir = freshDir('mixed-case')
      fs.writeFileSync(path.join(dir, 'SCENE_001.JPG'), 'd')
      fs.writeFileSync(path.join(dir, 'SCENE_002.PNG'), 'd')
      fs.writeFileSync(path.join(dir, 'SCENE_003.WEBM'), 'd')
      fs.writeFileSync(path.join(dir, 'SCENE_004.MP4'), 'd')

      const discovered = listMixedMediaInFolder(dir)
      assert.strictEqual(discovered.length, 4)
      const counts = countMixedMedia(discovered)
      assert.strictEqual(counts.imageCount, 2)
      assert.strictEqual(counts.videoCount, 2)
    })

    await it('skips hidden directories, files, and symlinks', () => {
      const dir = freshDir('mixed-hidden')
      fs.writeFileSync(path.join(dir, 'scene_001.png'), 'd')
      fs.writeFileSync(path.join(dir, '.DS_Store'), 'd')

      const hiddenSub = path.join(dir, '.git')
      fs.mkdirSync(hiddenSub)
      fs.writeFileSync(path.join(hiddenSub, 'scene_002.mp4'), 'd')

      const discovered = listMixedMediaInFolder(dir)
      assert.strictEqual(discovered.length, 1)
      assert.strictEqual(path.basename(discovered[0]), 'scene_001.png')
    })

    await it('sorts discovered files in natural alphanumeric order', () => {
      const dir = freshDir('mixed-sort')
      fs.writeFileSync(path.join(dir, 'scene_10.mp4'), 'd')
      fs.writeFileSync(path.join(dir, 'scene_2.jpg'), 'd')
      fs.writeFileSync(path.join(dir, 'scene_1.png'), 'd')
      fs.writeFileSync(path.join(dir, 'scene_20.webm'), 'd')

      const discovered = listMixedMediaInFolder(dir)
      const baseNames = discovered.map((f) => path.basename(f))
      assert.deepStrictEqual(baseNames, ['scene_1.png', 'scene_2.jpg', 'scene_10.mp4', 'scene_20.webm'])
    })

    await it('handles empty folder gracefully', () => {
      const dir = freshDir('mixed-empty')
      const discovered = listMixedMediaInFolder(dir)
      assert.strictEqual(discovered.length, 0)
    })

    await it('throws descriptive error when directory does not exist or is a file', () => {
      assert.throws(() => {
        listMixedMediaInFolder('/nonexistent/path/that/does/not/exist')
      }, /Folder does not exist/)

      const dir = freshDir('mixed-not-dir')
      const file = path.join(dir, 'file.txt')
      fs.writeFileSync(file, 'hello')
      assert.throws(() => {
        listMixedMediaInFolder(file)
      }, /Path is not a directory/)
    })

    await it('enforces file count safety limit (250) and emits warning', () => {
      const dir = freshDir('mixed-limit')
      for (let i = 1; i <= 260; i++) {
        const ext = i % 2 === 0 ? '.mp4' : '.jpg'
        fs.writeFileSync(path.join(dir, `scene_${String(i).padStart(4, '0')}${ext}`), 'd')
      }

      const warnings: string[] = []
      const discovered = listMixedMediaInFolder(dir, MAX_MIXED_FOLDER_DEPTH, warnings)
      assert.strictEqual(discovered.length, MAX_DISCOVERED_MIXED_MEDIA)
      assert.strictEqual(warnings.length, 1)
      assert.ok(warnings[0].includes('safety limit of 250'))
    })
  } finally {
    cleanupFixtures()
    finish()
  }
}

void main()
