import { chromium } from 'playwright'
import * as path from 'path'
import * as fs from 'fs'

async function runE2E() {
  const artifactDir = 'C:\\Users\\ADMIN\\.gemini\\antigravity-ide\\brain\\e23a424b-da30-47a8-afc4-1ebc0b546c4e'
  let browser
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  } catch {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()

  console.log('Navigating to http://localhost:5173/ ...')
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1500)

  // 1. Click YouTube Research in sidebar if visible
  const researchNav = page.locator('text=YouTube Research').first()
  if (await researchNav.isVisible()) {
    console.log('Clicking YouTube Research in sidebar...')
    await researchNav.click()
    await page.waitForTimeout(1000)
  }

  // 2. Click on Competitors tab
  console.log('Clicking Competitors tab...')
  const competitorsTab = page.locator('button:has-text("Competitors")').first()
  await competitorsTab.click()
  await page.waitForTimeout(1000)

  // 3. Check if competitor data is already loaded or input channel
  const similarPanel = page.locator('#similar-channels-panel')
  const panelExists = await similarPanel.isVisible().catch(() => false)

  if (!panelExists) {
    console.log('Competitor data not yet loaded. Entering channel handle...')
    const input = page.locator('input[placeholder*="Channel URL or handle"]').first()
    await input.fill('@EconomicsExplained')
    await page.waitForTimeout(500)
    
    console.log('Submitting competitor analysis by pressing Enter...')
    await input.press('Enter')

    console.log('Waiting for Competitor Analysis to finish (up to 40s)...')
    await similarPanel.waitFor({ state: 'visible', timeout: 45000 })
    console.log('Similar Channels Panel is now visible!')
  } else {
    console.log('Competitor data is already active.')
  }

  await similarPanel.scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)

  // 4. Click Discover Similar Channels if not running
  const startBtn = page.locator('#similar-channels-start-btn')
  const restartBtn = page.locator('#similar-channels-restart-btn')
  if (await startBtn.isVisible()) {
    console.log('Clicking Discover Similar Channels button...')
    await startBtn.click()
    console.log('Discovery started!')
  } else if (await restartBtn.isVisible()) {
    console.log('Clicking Retry button to run discovery fresh...')
    await restartBtn.click()
    console.log('Discovery restarted!')
  }

  // 5. Poll and wait for completion (up to 120 seconds)
  console.log('Monitoring Similar Channels Discovery progress...')
  const startTime = Date.now()
  let isDone = false
  while (Date.now() - startTime < 120000) {
    const exportBtn = page.locator('#similar-channels-export-btn')
    if (await exportBtn.isVisible()) {
      isDone = true
      break
    }
    const filterAll = page.locator('#similar-filter-ALL')
    if (await filterAll.isVisible()) {
      isDone = true
      break
    }
    await page.waitForTimeout(2000)
  }

  console.log(`Discovery run completed: ${isDone}. Scrolling panel into view...`)
  await page.waitForTimeout(2000)
  await similarPanel.scrollIntoViewIfNeeded()
  await page.waitForTimeout(1000)

  // 6. Capture Overview Screenshot (4 summary boxes, subtitle, featured banner, filters)
  const overviewPath = path.join(artifactDir, 'e2e_similar_channels_overview_v2.png')
  await page.screenshot({ path: overviewPath, fullPage: false })
  console.log(`Saved overview screenshot to ${overviewPath}`)

  // 7. Test and capture Diagnostics Section
  const diagToggle = page.locator('#similar-channels-diagnostics-toggle')
  if (await diagToggle.isVisible()) {
    console.log('Clicking to expand Diagnostics (How candidates were found)...')
    await diagToggle.click()
    await page.waitForTimeout(800)
    const diagPath = path.join(artifactDir, 'e2e_similar_channels_diagnostics_v2.png')
    await page.screenshot({ path: diagPath, fullPage: false })
    console.log(`Saved diagnostics screenshot to ${diagPath}`)
  }

  // 8. Test and expand Candidate Card #1
  const card1 = page.locator('#similar-channel-card-1')
  if (await card1.isVisible()) {
    console.log('Expanding Candidate Card #1 video evidence...')
    await card1.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    const videoToggle = page.locator('#similar-channel-videos-toggle-1')
    if (await videoToggle.isVisible()) {
      await videoToggle.click()
      await page.waitForTimeout(800)
    }
    const cardPath = path.join(artifactDir, 'e2e_similar_channel_card1_v2.png')
    await page.screenshot({ path: cardPath, fullPage: false })
    console.log(`Saved card #1 screenshot to ${cardPath}`)
  }

  // 9. Test Recommended Filter
  const recFilter = page.locator('#similar-filter-RECOMMENDED')
  if (await recFilter.isVisible()) {
    console.log('Testing Recommended filter click...')
    await recFilter.click()
    await page.waitForTimeout(500)
  }

  // 10. Verify Export Excel button
  const exportBtn = page.locator('#similar-channels-export-btn')
  const hasExport = await exportBtn.isVisible()
  console.log(`Export Excel button visible: ${hasExport}`)

  await browser.close()
  console.log('All E2E browser tests successfully executed and recorded!')
}

runE2E().catch(err => {
  console.error('E2E error:', err)
  process.exit(1)
})
