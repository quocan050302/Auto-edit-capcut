# 🌐 YouTube Foreign Market Researcher (Module Documentation)

## 1. Overview & Architecture

The **YouTube Foreign Market Researcher** (`YouTube Research`) is an isolated, high-level intelligence module in **Long-Form AI Video Factory**. It empowers creators and video strategists to discover rising niches, keyword trends, breakout videos, and content gaps across 8 international markets using public YouTube signals.

### Complete Isolation Guarantee
This module is strictly isolated from the core Video Production Pipeline (`validating` → `postflight`):
- **Independent Route**: `/youtube-research` with sub-views (`Discover`, `Keywords`, `Breakouts`, `Trend Radar`, `Competitors`, `Saved Research`).
- **Independent State**: Local UI state and persistence completely separated from active video project state.
- **Independent Storage**: Dedicated SQLite database at `data/youtube-research.db`. Video project JSON records are never modified by research runs.
- **Independent Process**: Python FastAPI sidecar running locally on `http://127.0.0.1:8765`, managed with health checks, auto-restart, and graceful shutdown by Electron main process.
- **Fail-safe Operation**: If the research sidecar or scraping fails, video creation, transcription, stock search, and Remotion rendering remain 100% operational.

---

## 2. Public YouTube Signals & Transparency Rules

The system relies strictly on publicly accessible data:
- Video metadata (view counts, title, description, tags, channel, duration, publication date).
- Channel baselines (latest 20–30 uploads of matching content format).
- Regional popularity signals (Official YouTube Data API v3 or public page scraping).
- Periodic snapshots (capturing view count deltas over time for observed velocity).

> [!IMPORTANT]
> **Data Transparency Compliance**: The module NEVER claims access to private YouTube Analytics or exact competitor audience geography.
> - Terminology used: `Estimated Market Fit`, `Regional Popularity Signal`, `US Market Signal`.
> - Prohibited terms: `Exact US View Percentage`, `Exact Audience Geography`.

---

## 3. Data Providers & Dual-Engine Fallback

The module operates in a **Free-First** mode:
1. **Public Scraper (Default & Free)**:
   - Uses `httpx` with exponential backoff and structured response parsers.
   - Requires **no API key** or third-party paid subscriptions.
   - Extracts view counts, channel metrics, and video duration across multi-language formats.
2. **Official YouTube Data API v3 (Optional)**:
   - Configurable in **Settings -> YouTube Research**.
   - Enables high-precision regionCode filtering, category trending, and batch metadata lookups.
   - Quota usage is monitored locally; automatically falls back to Scraper if quota is exceeded.
3. **YouTube Autocomplete Expander**:
   - Generates keyword permutations using alphabet expansion, intent modifiers (`why`, `how`, `truth`, `cost`, `problem`), and dynamic current year (`2026`).

---

## 4. Deterministic Scoring Models (Zero AI Hallucination)

All numerical scores are computed deterministically in `services/youtube-research/scoring/calculator.py`:

### Key Metrics
1. **Observed Velocity**:
   $$\text{Observed Velocity} = \frac{\Delta \text{Views}}{\Delta \text{Hours}}$$
   *(Only computed when valid historical snapshots exist; otherwise clearly labeled as Lifetime Average Views/Day).*
2. **Channel Baseline & Outlier Ratio**:
   $$\text{Outlier Ratio} = \frac{\text{Current Video Views}}{\max(\text{Median Recent Channel Views}, 1)}$$
3. **Small Channel Breakout**:
   Flagged when channel has $< 100\text{K}$ subscribers, video has $> 100\text{K}$ views, and $\text{Outlier} \ge 5\times$.
4. **Cross-Channel Validation**:
   Checks whether high-performing videos for a keyword stem from multiple distinct creator channels.
5. **Opportunity Score (0–100)**:
   $$\text{Opportunity} = 0.20 \times \text{Demand} + 0.20 \times \text{Velocity} + 0.20 \times \text{Outlier} + 0.10 \times \text{CrossChannel} + 0.10 \times \text{MarketFit} + 0.10 \times \text{Freshness} + 0.10 \times (100 - \text{Competition})$$
6. **Data Confidence**:
   Reflects sample size, channel diversity, and metadata completeness (`HIGH`, `MEDIUM`, `LOW`).

---

## 5. Optional Local AI (Ollama)

AI is strictly auxiliary and **never generates numbers or scores**:
- **Topic Clustering**: Labels semantic clusters of similar titles.
- **Content Ideation**: Suggests angles, title patterns, and content gaps based on actual public video titles.
- **Providers**: Supports local Ollama (`http://localhost:11434`, e.g. `llama3`, `mistral`), Gemini, OpenAI, or `Disabled`.

---

## 6. Project Handoff

Users can convert winning keyword research into a new video project draft via the **Create Video Project** modal:
- Requires **explicit user confirmation**.
- Copies keyword, angles, title patterns, and references into the project settings under `researchHandoff`.
- **Never** starts automated pipeline execution or renders automatically.
- **Never** downloads competitor video files or imports competitor videos as stock assets.

---

## 7. Windows Development & Service Lifecycle

### Running the App
```bash
# Starts Electron + React Dev Server + Auto-spawns Python Research Sidecar
npm run dev
```

### Dedicated Commands
- `npm test`: Runs all 8 test suites (including `youtube-research-regression.test.ts`).
- `npm run test:research`: Runs Python pytest suite in `services/youtube-research`.
- `npm run restart-research`: Restarts the Python research sidecar on port `8765`.
- `npm run stop-dev`: Terminates any orphaned background research processes on port `8765`.
