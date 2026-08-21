import { mkdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outputPath = path.join(root, 'project_status/ui-performance-baseline-2026-08-21.json')
const ITERATIONS = 80
const QUERY = 'gpt-5.6'

function makeModels(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: index % 10 === 0 ? `gpt-5.6-${index}` : `provider-model-${index}`,
    aliases: [`model-${index}`, index % 3 === 0 ? '5.6' : 'general'],
    tags: index % 5 === 0 ? ['codex', '推理'] : ['codex'],
    updatedAt: index,
  }))
}

function makeActivity(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `activity-${index}`,
    time: `2026-08-${String((index % 28) + 1).padStart(2, '0')} 12:${String(index % 60).padStart(2, '0')}`,
    title: `脱敏操作 ${index}`,
    detail: 'fixture-only activity record',
  }))
}

function filterModels(models, query) {
  const normalized = query.toLowerCase()
  return models
    .filter((model) => [model.id, ...model.aliases, ...model.tags].some((value) => value.toLowerCase().includes(normalized)))
    .slice(0, 8)
}

function sortActivities(activities) {
  return [...activities].sort((left, right) => right.time.localeCompare(left.time))
}

function refreshMap(models, activities) {
  return {
    models: models.map((model) => ({ id: model.id, label: model.id })),
    activity: activities.map((item) => ({ id: item.id, title: item.title, time: item.time })),
  }
}

function measure(label, operation) {
  for (let index = 0; index < 8; index += 1) operation()
  const started = performance.now()
  for (let index = 0; index < ITERATIONS; index += 1) operation()
  return { label, averageMs: Number(((performance.now() - started) / ITERATIONS).toFixed(3)) }
}

const fixtures = [
  { id: 'regular', models: 40, activity: 30 },
  { id: 'large', models: 300, activity: 200 },
  { id: 'stress', models: 1500, activity: 1000 },
]

const results = fixtures.map((fixture) => {
  const models = makeModels(fixture.models)
  const activity = makeActivity(fixture.activity)
  return {
    ...fixture,
    measurements: [
      measure('model-filter', () => filterModels(models, QUERY)),
      measure('activity-sort', () => sortActivities(activity)),
      measure('state-refresh-map', () => refreshMap(models, activity)),
    ],
  }
})

const report = {
  generatedAt: new Date().toISOString(),
  source: 'scripts/perf/ui-fixture-benchmark.mjs',
  isolation: '脱敏、内存 fixture；不读取本机配置、密钥或网络。',
  iterations: ITERATIONS,
  interactionBudgetMs: 16,
  results,
  interpretation: '本基线只测量当前列表运算，不冒充 React 浏览器渲染；若平均值超过 16ms，再针对对应热点引入 memo 或虚拟列表。',
}

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
