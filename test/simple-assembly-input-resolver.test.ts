import * as fs from 'fs'
import * as path from 'path'
import {
  naturalCompareScenes,
  extractSceneNumber,
  resolveDirectFolderScenes,
  resolveSimpleAssemblyInputs
} from '../src/main/simple-assembly/simple-assembly-input-resolver'
import { assert, createRunner, freshDir } from './manual-ai-test-utils'

const { it, finish } = createRunner('Simple Assembly Input Resolver Tests')

void (async () => {
  const testRoot = freshDir('resolver-tests')

  await it('Section 1: Natural numeric ordering — Scene 2 comes before Scene 10', () => {
    const filenames = ['Scene 10.mp4', 'Scene 1.mp4', 'Scene 2.mp4', 'Scene 20.mp4', 'Scene 3.mp4']
    const sorted = [...filenames].sort(naturalCompareScenes)
    assert.deepStrictEqual(sorted, [
      'Scene 1.mp4',
      'Scene 2.mp4',
      'Scene 3.mp4',
      'Scene 10.mp4',
      'Scene 20.mp4'
    ])
  })

  await it('Section 2: Leading zeros handling — S0001, S0002, S0010', () => {
    const filenames = ['S0010.mp4', 'S0001.mp4', 'S0002.mp4']
    const sorted = [...filenames].sort(naturalCompareScenes)
    assert.deepStrictEqual(sorted, ['S0001.mp4', 'S0002.mp4', 'S0010.mp4'])
    assert.strictEqual(extractSceneNumber('S0001.mp4'), 1)
    assert.strictEqual(extractSceneNumber('S0010.mp4'), 10)
  })

  await it('Section 3: Direct scene folder resolution — valid files', () => {
    const sceneDir = path.join(testRoot, 'valid-scenes')
    fs.mkdirSync(sceneDir, { recursive: true })
    fs.writeFileSync(path.join(sceneDir, 'Scene 1.mp4'), 'clip1')
    fs.writeFileSync(path.join(sceneDir, 'Scene 2.webm'), 'clip2')
    fs.writeFileSync(path.join(sceneDir, 'Scene 10.mov'), 'clip10')

    const scenes = resolveDirectFolderScenes(sceneDir)

    assert.strictEqual(scenes.length, 3)
    assert.strictEqual(scenes[0].sceneIndex, 1)
    assert.strictEqual(scenes[1].sceneIndex, 2)
    assert.strictEqual(scenes[2].sceneIndex, 10)
    assert.strictEqual(scenes[0].mediaType, 'video')
  })

  await it('Section 4: Duplicate scene number detection — blocks with clear error', () => {
    const sceneDir = path.join(testRoot, 'dup-scenes')
    fs.mkdirSync(sceneDir, { recursive: true })
    fs.writeFileSync(path.join(sceneDir, 'Scene 1.mp4'), 'clip1')
    fs.writeFileSync(path.join(sceneDir, 'Scene 01.webm'), 'clip1-dup')

    assert.throws(
      () => resolveDirectFolderScenes(sceneDir),
      /Duplicate scene number 1 detected/
    )
  })

  await it('Section 5: Ambiguous / unnumbered files reported', () => {
    const sceneDir = path.join(testRoot, 'ambiguous-scenes')
    fs.mkdirSync(sceneDir, { recursive: true })
    fs.writeFileSync(path.join(sceneDir, 'Scene 1.mp4'), 'clip1')
    fs.writeFileSync(path.join(sceneDir, 'random_broll.mp4'), 'broll')

    assert.throws(
      () => resolveDirectFolderScenes(sceneDir),
      /Could not determine scene order for 1 file/
    )
  })

  await it('Section 6: Static images mixed with video sources accepted', () => {
    const sceneDir = path.join(testRoot, 'mixed-scenes')
    fs.mkdirSync(sceneDir, { recursive: true })
    fs.writeFileSync(path.join(sceneDir, 'Scene 1.mp4'), 'clip1')
    fs.writeFileSync(path.join(sceneDir, 'Scene 2.png'), 'image2')
    fs.writeFileSync(path.join(sceneDir, 'Scene 3.jpg'), 'image3')

    const scenes = resolveDirectFolderScenes(sceneDir)

    assert.strictEqual(scenes.length, 3)
    assert.strictEqual(scenes[0].mediaType, 'video')
    assert.strictEqual(scenes[1].mediaType, 'image')
    assert.strictEqual(scenes[2].mediaType, 'image')
  })

  await it('Section 7: Authoritative input resolution — direct folder takes precedence over empty project plan', () => {
    const sceneDir = path.join(testRoot, 'folder-prio')
    fs.mkdirSync(sceneDir, { recursive: true })
    fs.writeFileSync(path.join(sceneDir, 'Scene 1.mp4'), 'clip1')

    const res = resolveSimpleAssemblyInputs(testRoot, sceneDir)
    assert.strictEqual(res.source, 'direct-folder')
    assert.strictEqual(res.scenes.length, 1)
  })

  finish()
})()
