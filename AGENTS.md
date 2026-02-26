# MA Calculator - Agent Knowledge Base

## Overview

A-share stock Moving Average (MA) real-time calculator. Pure frontend app — no build tools, no bundler, no package manager. Serves static files directly via browser.

**Tech stack**: HTML + Vue 3 (CDN) + Tailwind CSS (CDN) + Font Awesome (CDN) + vanilla JavaScript

## Project Structure

```
ma-calculator/
├── index.html           # Single-page app entry (Vue 3 template, Tailwind classes)
├── js/
│   ├── app.js           # Vue 3 app (Composition API, setup()) — main logic
│   └── api-adapters.js  # Stock API adapters (AllTick, iTick) — adapter pattern
├── key.js               # API keys (GITIGNORED — never commit)
├── css/                 # Empty (all styling via Tailwind CDN)
├── .gitignore           # Only ignores key.js
└── AGENTS.md
```

## Build / Run / Test

**There are NO build, lint, or test commands.** This is a zero-tooling static site.

| Task | Command |
|------|---------|
| Run locally | Open `index.html` in browser, or use `npx serve .` / `python -m http.server` |
| Deploy | Static file hosting (GitHub Pages, Netlify, etc.) |
| Lint | None configured |
| Test | None configured |
| Build | None — no compilation step |

## Critical: Secrets

- `key.js` contains API keys and is in `.gitignore` — **NEVER commit this file**
- API keys are for: AllTick, Infoway, Tushare, iTick
- `key.js` format:
  ```js
  const API_KEYS = {
    alltick: "...",
    itick: "..."
  };
  ```

## Architecture

### Data Flow

```
User input (stock code / name)
  → searchStockCodeByName() [Tencent Finance API, via CORS proxy]
  → AdapterFactory.create(provider)
  → adapter.fetchStockName() [optional, failure non-blocking]
  → adapter.fetchStockData() [K-line data]
  → Auto-fill MA5/MA10/MA20 inputs
  → calculateMA5/10/20()
  → Display results
```

### API Adapter Pattern

```
BaseAdapter (abstract)
  ├── AllTickAdapter  — requires CORS proxy (corsproxy.io)
  └── ITickAdapter    — supports browser direct CORS
```

- Factory: `AdapterFactory.create(providerName)` returns adapter instance
- Each adapter implements: `fetchStockName(code, apiKey)` + `fetchStockData(code, apiKey)`
- Exchange detection: code starting with `6` → SH, otherwise → SZ

### MA Calculation Formula

```
MA_N_tomorrow = (MA_N_today * N - price_N_days_ago + tomorrow_price) / N
```

Where N = 5, 10, or 20.

## Code Style Guidelines

### JavaScript

- **ES6+ features**: `const/let`, arrow functions, async/await, template literals, destructuring
- **No modules**: All files use global scope via `<script>` tags (no import/export)
- **Vue 3 Composition API**: `setup()` with `ref()`, `reactive()`, `computed()`, `watch()`, `onMounted()`
- **Class-based adapters**: `BaseAdapter` → subclasses, with `AdapterFactory` factory pattern
- **No TypeScript**

### Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Functions | camelCase | `fetchStockData`, `calculateMA5`, `decodeUnicode` |
| Classes | PascalCase | `AllTickAdapter`, `BaseAdapter`, `AdapterFactory` |
| Constants | UPPER_SNAKE | `CORS_PROXY`, `API_URLS`, `API_KEYS` |
| Vue refs | camelCase | `stockCode`, `loading`, `dataFetched` |
| CSS | Tailwind utility classes only | `bg-white rounded-lg shadow-md p-5 mb-6` |

### Error Handling

- API calls wrapped in `try/catch`
- User-facing errors set `error.value = "message"` (displayed in template)
- Non-critical failures (e.g. name lookup) silently caught — `return null`
- `fetchWithTimeout()` wraps fetch with AbortController (15s default)
- Console errors logged with `console.error()`

### HTML / Template

- Language: `zh-CN`
- Vue directives: `v-model`, `v-if`, `v-show`, `@click`, `@keyup.enter`, `:class`, `:disabled`
- All styling via Tailwind utility classes — no custom CSS files
- Card layout pattern: `bg-white rounded-lg shadow-md p-5 mb-6`
- Color scheme: green (primary), blue (MA5), green (MA10), purple (MA20), red (warnings)

### Formatting

- **Indentation**: 4 spaces (JS), 4 spaces (HTML)
- **Quotes**: Single quotes in JS, double quotes in HTML attributes
- **Semicolons**: Yes (required in all JS)
- **Trailing commas**: No
- **Line length**: No strict limit, but keep readable

### Comments

- Chinese comments for domain logic (stock market terms)
- English comments for technical patterns (CORS, API, adapter)
- `//` for inline, no JSDoc

## Conventions When Modifying

1. **No build step** — changes are live immediately, just refresh browser
2. **No package.json** — do NOT add npm dependencies; use CDN links in `<script>`/`<link>`
3. **Global scope** — all JS files share global namespace; load order matters (`api-adapters.js` before `app.js`)
4. **CORS awareness** — AllTick requires proxy (`corsproxy.io`); iTick supports direct browser calls
5. **localStorage** — user config (provider + API keys) persisted under key `ma-calculator-api-config`
6. **Mobile-first** — `max-w-xl mx-auto` container, responsive by default via Tailwind

## Adding a New API Provider

1. Create a new class extending `BaseAdapter` in `api-adapters.js`
2. Implement `fetchStockName(code, apiKey)` and `fetchStockData(code, apiKey)`
3. Register in `AdapterFactory.create()` adapters map
4. Add `<option>` in `index.html` select dropdown
5. Add URL to `API_URLS` in `app.js`
6. Add key to `key.js` (gitignored)

## Git Workflow

- Single `master` branch
- Remote: GitHub (`PeyFon/ma-calculator`, private)
- `.gitignore`: only `key.js`
- **NEVER commit `key.js`** — contains real API keys

## 代码修改注意事项

修改股票代码判断逻辑时，特别注意以下边界情况：

```javascript
// 股票代码前缀与交易所对应关系
// 6xxxxx → 上交所 (SH)
// 000xxx → 上证指数 (如000001, 000300)
// 002xxx → 深交所 (SZ)
// 300xxx → 深交所创业板 (SZ)
// 399xxx → 深证指数 (如399001, 399006)
// [A-Z]+ → 港股指数 (如HSTECH, HSI)
// 0xxxx  → 港股股票 (如00700)
```

### 每次修改后必须手动验证

修改代码后，必须在浏览器中手动测试以下用例：

| 名称 | 代码 | 市场 | 验证重点 |
|------|------|------|----------|
| 恒生科技指数 | HSTECH | 港股 | 字母指数代码 |
| 恒生指数 | HSI | 港股 | 字母指数代码 |
| 腾讯控股 | 00700 | 港股 | 5位数字港股代码(0开头) |
| 阿里巴巴 | 09988 | 港股 | 5位数字港股代码(非0开头) |
| 上证指数 | 000001 | A股 | 上证指数代码 |
| 深证成指 | 399001 | A股 | 深证指数代码 |
| 创业板指 | 399006 | A股 | 深证指数代码(399xxx) |
| 沪深300 | 000300 | A股 | 上证指数(000xxx) |
| 科创50 | 000688 | A股 | 科创板指数(000xxx) |
| 万华化学 | 600309 | A股 | 上交所股票(6xxxxx) |
| 天赐材料 | 002709 | A股 | 深交所股票(002xxx) |
| 宁德时代 | 300750 | A股 | 创业板股票(300xxx) |
