import scenarioManifest from './scenario-manifest.json'

export type DailyQaScenarioId = 'daily-baseline' | 'daily-density' | 'daily-operation-flow'
export type QaScenarioId = 'first-run-review' | DailyQaScenarioId | 'controlled-live-validation'

export type QaScenario = {
  id: QaScenarioId
  index: '01' | '02' | '03'
  title: string
  description: string
  dataBoundary: string
  checks: string
  action: string
  impactPaths: string[]
  automation: Array<'scenario-contract' | 'preview-ui' | 'initialization-native' | 'initialization-stream' | 'first-run-progress'>
  status: 'active'
  lastReviewed: string
}

// The manifest is the single source for QA states, automation and affected paths.
export const QA_SCENARIOS = scenarioManifest as QaScenario[]
export const scenarioById = Object.fromEntries(QA_SCENARIOS.map((scenario) => [scenario.id, scenario])) as Record<QaScenarioId, QaScenario>
