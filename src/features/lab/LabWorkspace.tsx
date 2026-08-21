import { Activity, CircleHelp, FlaskConical, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { deleteCostCalibration, saveCostCalibration } from '../../adapter'
import type { AppState, CostCalibration, ProviderProfile, ResponseProbeObservation } from '../../types'
import type { OperationId } from '../../operations'
import { FieldHint } from '../../shared/components'

const BENCHMARK_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, cacheWriteUsdPerMillion: 6.25, outputUsdPerMillion: 30 },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, cacheWriteUsdPerMillion: 2.5, outputUsdPerMillion: 12 },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, cacheWriteUsdPerMillion: 0.25, outputUsdPerMillion: 1.2 },
  { id: 'gpt-5.5', label: 'GPT-5.5', inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, cacheWriteUsdPerMillion: 0, outputUsdPerMillion: 30 },
] as const
const OFFICIAL_USD_TO_CNY = 6.74545

function decimalToScaled(value: string) {
  const normalized = value.trim().replace(',', '.')
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return 0n
  const [whole, fraction = ''] = normalized.split('.')
  return BigInt(whole) * 1_000_000_000n + BigInt((fraction + '000000000').slice(0, 9))
}
function scaledToDecimal(value: bigint) {
  const whole = value / 1_000_000_000n
  const fraction = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}
function medianScaled(values: bigint[]) {
  if (values.length === 0) return 0n
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}
function formatCny(value: string, maximumFractionDigits = 2) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '—'
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits }).format(parsed)
}
function benchmarkModelLabel(model: string) {
  return BENCHMARK_MODELS.find((item) => item.id === model)?.label ?? model
}
function estimateOfficialCny(probe: ResponseProbeObservation | undefined, modelId: string) {
  const model = BENCHMARK_MODELS.find((item) => item.id === modelId)
  const usage = probe?.usage
  if (!model || !usage) return null
  const input = Number(usage.inputTokens ?? 0) / 1_000_000
  const output = Number(usage.outputTokens ?? 0) / 1_000_000
  const cached = Number(usage.cachedTokens ?? 0) / 1_000_000
  if (![input, output, cached].every(Number.isFinite)) return null
  return BigInt(Math.round((input * model.inputUsdPerMillion + cached * model.cachedInputUsdPerMillion + output * model.outputUsdPerMillion) * OFFICIAL_USD_TO_CNY * 1_000_000_000))
}

export function LabWorkspace({ state, selectedProfile, busy, runAction, onRunCostTest, onOpenGuide }: {
  state: AppState
  selectedProfile: ProviderProfile | undefined
  busy: string | null
  runAction: (label: OperationId, action: () => Promise<AppState>) => Promise<void>
  onRunCostTest: (profileId: string, benchmarkModel: string) => void
  onOpenGuide: () => void
}) {
  const [labProviderId, setLabProviderId] = useState(selectedProfile?.id ?? state.currentProfileId)
  const [fundingMode, setFundingMode] = useState<CostCalibration['fundingMode']>('prepaid')
  const [paidCny, setPaidCny] = useState('')
  const [consumableCredit, setConsumableCredit] = useState('')
  const [debitCredit, setDebitCredit] = useState('')
  const [historyProviderId, setHistoryProviderId] = useState<string | null>(null)
  const profile = state.profiles.find((item) => item.id === labProviderId) ?? selectedProfile ?? state.profiles.find((item) => item.active)
  const [benchmarkModel, setBenchmarkModel] = useState('gpt-5.6-terra')
  const latestProbe = (state.responseProbes ?? []).find((item) => item.providerId === profile?.id && item.model === benchmarkModel && item.probeVersion === 'cost-calibration-v2')
  const completedCalibrations = (state.costCalibrations ?? []).filter((item) => item.state === 'completed' && item.resultCny !== '0')
  const comparableRecords = completedCalibrations.filter((item) => item.model === benchmarkModel && item.probeVersion === 'cost-calibration-v2')
  const ranking = Array.from(new Map(state.profiles.map((item) => [item.id, item])).values()).flatMap((provider) => {
    const samples = comparableRecords.filter((item) => item.providerId === provider.id)
    if (samples.length === 0) return []
    const median = medianScaled(samples.map((item) => decimalToScaled(item.resultCny)))
    const officialCosts = samples.map((sample) => estimateOfficialCny((state.responseProbes ?? []).find((probe) => probe.id === sample.probeId), benchmarkModel)).filter((cost): cost is bigint => cost !== null)
    return [{ provider, samples, median, officialMedian: officialCosts.length > 0 ? medianScaled(officialCosts) : null }]
  }).toSorted((left, right) => left.median < right.median ? -1 : left.median > right.median ? 1 : 0)
  const lowestCost = ranking[0]?.median ?? null
  const displayMultiplier = lowestCost && Number(scaledToDecimal(lowestCost)) * 1000 < 0.01 ? 10_000 : 1_000
  const scoreFor = (median: bigint) => !lowestCost || ranking.length < 2 || median <= 0n ? null : Math.max(1, Math.min(100, Number((lowestCost * 100n) / median)))
  const costSourceLabel: Record<NonNullable<CostCalibration['costSource']>, string> = { response_inline: '响应费用', response_usage: '用量费用', response_header: '响应头费用', billing_log_manual: '平台日志', balance_difference: '余额差额' }

  useEffect(() => {
    if (latestProbe?.status === 'final_cost_inline' && latestProbe.costCandidate) setDebitCredit(latestProbe.costCandidate)
  }, [latestProbe?.costCandidate, latestProbe?.status])
  async function saveCalibration() {
    if (!profile) return
    await runAction('save-cost-calibration', () => saveCostCalibration({ providerId: profile.id, providerName: profile.name, fundingMode, paidCny, consumableCredit, debitCredit, creditUnitLabel: '同一平台额度', model: benchmarkModel || '未设置模型', probeVersion: 'cost-calibration-v2', costSource: latestProbe?.costCandidate ? latestProbe.costSource ?? 'response_inline' : 'billing_log_manual', probeId: latestProbe?.id, sampleKind: 'cold' }))
    setDebitCredit('')
  }
  async function removeCalibration(calibration: CostCalibration) {
    if (!window.confirm(`删除 ${calibration.providerName} 在 ${calibration.updatedAt} 保存的这条费用记录？此操作不可恢复。`)) return
    await runAction('delete-cost-calibration', () => deleteCostCalibration(calibration.id))
  }

  return <div className="workspace-stack lab-workspace">
    <section className="lab-intro"><FlaskConical size={22} aria-hidden="true" /><div><h3>性价比中心</h3><p>用同一条固定测试的人民币成本，比较服务商。</p></div><button className="icon-button workspace-guide-button" type="button" onClick={onOpenGuide} aria-label="查看实验室使用说明" title="查看实验室使用说明" data-guide-target="lab.page-help"><CircleHelp size={16} /></button></section>
    <section className="surface-panel lab-ranking" aria-labelledby="lab-ranking-title" data-guide-target="lab.ranking"><div className="section-heading-row"><div><h3 id="lab-ranking-title">{ranking.length >= 2 ? '服务商对比' : '本次成本结果'}</h3><p className="section-description">{ranking.length >= 2 ? '只比较同一个固定测试模型。多次记录时取中位数；样本少于 3 次会明确提示，但不会阻止比较。' : '保存一条样本后立即显示结果。再添加一个服务商，即可查看横向对比。'}</p></div></div>
      <div className="lab-benchmark-control" data-guide-target="lab.model"><label><span className="field-label">固定测试模型 <FieldHint text="排名只比较同一模型下、同一固定测试请求的结果；切换模型后会显示该模型自己的排名。" /></span><select value={benchmarkModel} onChange={(event) => { setBenchmarkModel(event.target.value); setDebitCredit('') }}>{BENCHMARK_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label></div>
      {ranking.length === 0 ? <p className="lab-empty">先运行固定测试并保存第一条费用样本。保存后，这里会马上显示本次人民币成本。</p> : <div className="lab-ranking-list" role="table" aria-label="性价比排名">
        {ranking.length >= 2 && <div className="lab-ranking-head ranking-grid" role="row"><span className="ranking-cell ranking-cell--position">排名</span><span className="ranking-cell ranking-cell--provider">服务商</span><span className="ranking-cell ranking-cell--cost">估算成本 <FieldHint text={`按“每 ${displayMultiplier.toLocaleString()} 次”固定测试估算的人民币成本。`} /></span><span className="ranking-cell ranking-cell--official">官方对照 <FieldHint text={`这是该服务商成本占同一测试按官方 API 标准价格估算成本的百分比；1% 表示约为官方成本的 1/100。固定参考汇率：1 USD = ¥${OFFICIAL_USD_TO_CNY}。`} /></span><span className="ranking-cell ranking-cell--score">评分 <FieldHint text="本表中成本最低的服务商为 100 分；其余服务商按成本比例折算，分数越高代表本次比较越划算。" /></span><span className="ranking-cell ranking-cell--samples">样本 <FieldHint text="参与中位数计算的已保存冷启动样本数量。" /></span><span className="ranking-cell ranking-cell--manage">管理</span></div>}
        {ranking.map((item, index) => { const medianCny = scaledToDecimal(item.median); const officialRatio = item.officialMedian && item.officialMedian > 0n ? Number((item.median * 1000n) / item.officialMedian) / 10 : null; const providerHistoryOpen = historyProviderId === item.provider.id; return <div className="lab-ranking-group" key={item.provider.id}><div className="lab-ranking-row ranking-grid" role="row"><span className="ranking-cell ranking-cell--position ranking-position">{ranking.length >= 2 ? index + 1 : <Activity size={14} />}</span><div className="ranking-cell ranking-cell--provider"><strong>{item.provider.name}</strong><small>{benchmarkModelLabel(benchmarkModel)} · 最近 {item.samples[0]?.updatedAt}</small></div><div className="ranking-cell ranking-cell--cost ranking-cost"><strong>{formatCny((Number(medianCny) * displayMultiplier).toString())}</strong><small>单次 {formatCny(medianCny, 8)}</small></div><div className="ranking-cell ranking-cell--official ranking-official">{officialRatio === null ? <span>—</span> : <strong>{officialRatio}%</strong>}</div><div className="ranking-cell ranking-cell--score ranking-score"><strong>{ranking.length >= 2 ? `${scoreFor(item.median) ?? '—'}${scoreFor(item.median) ? ' 分' : ''}` : '初步结果'}</strong><span>{item.samples.length >= 3 ? '推荐样本数已满足' : `已测 ${item.samples.length}/3 次`}</span></div><span className="ranking-cell ranking-cell--samples ranking-samples">{item.samples.length} 次</span><button className="ghost-button ranking-cell ranking-cell--manage ranking-manage" type="button" onClick={() => setHistoryProviderId(providerHistoryOpen ? null : item.provider.id)}>{providerHistoryOpen ? '收起' : '管理'}</button></div>{providerHistoryOpen && <div className="lab-history-list"><strong>本服务商的原始样本</strong>{item.samples.map((sample) => <div className="lab-history-row" key={sample.id}><span>{sample.updatedAt} · {costSourceLabel[sample.costSource ?? 'billing_log_manual']}</span><strong>单次 {formatCny(sample.resultCny, 8)}</strong><button className="danger-text-button" type="button" disabled={busy !== null} onClick={() => void removeCalibration(sample)}><Trash2 size={14} />删除</button></div>)}</div>}</div> })}
      </div>}
    </section>
    <section className="surface-panel lab-record-cost"><div className="section-heading-row"><div><h3>新增测试样本</h3><p className="section-description">充值金额填写人民币。平台实际额度和测试额度只要来自同一个平台余额体系即可，不需要换算成美元，也不需要和其他服务商统一。人民币成本 = 充值金额 × 测试额度 ÷ 平台实际额度。</p></div></div>
      <div className="lab-selected-provider" data-guide-target="lab.provider"><label>服务商<select value={profile?.id ?? ''} onChange={(event) => { setLabProviderId(event.target.value); setDebitCredit('') }}>{state.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span>固定模型：{benchmarkModelLabel(benchmarkModel || '未选择模型')}</span></div>
      <div className={`lab-probe-status ${latestProbe ? latestProbe.status : 'idle'}`} data-guide-target="lab.probe"><div><strong>{latestProbe?.status === 'final_cost_inline' ? '已读取测试额度' : latestProbe ? '需要从平台日志补充测试额度' : '尚未运行测试'}</strong><span>{latestProbe?.status === 'final_cost_inline' ? `已通过${latestProbe.costSource === 'response_header' ? '响应头' : latestProbe.costSource === 'response_usage' ? '用量字段' : '响应字段'}读取费用。请确认它与平台余额单位一致。` : latestProbe ? latestProbe.detail : '运行后会发出一条极短请求，不会切换服务商或改写 Codex 配置。'}</span></div><button className="primary-button" type="button" disabled={!profile || busy !== null} onClick={() => profile && onRunCostTest(profile.id, benchmarkModel)}><Activity size={15} />运行固定测试</button></div>
      <div className="lab-form" data-guide-target="lab.cost-fields"><label><span className="field-label">计费方式 <FieldHint text="充值：按实际付款换得平台余额。订阅固定：填写本账期的实际付款和可用总额度。" /></span><select aria-label="计费方式" value={fundingMode} onChange={(event) => setFundingMode(event.target.value as CostCalibration['fundingMode'])}><option value="prepaid">充值</option><option value="subscription">订阅固定</option></select></label><label><span className="field-label">充值金额 <FieldHint text="购买这笔平台额度实际支付的人民币金额。" /></span><input aria-label="充值金额" type="text" inputMode="decimal" value={paidCny} onChange={(event) => setPaidCny(event.target.value)} placeholder="例如 10" /></label><label><span className="field-label">平台实际额度 <FieldHint text="付款后可用于调用的总额度，含赠送和折扣，按平台后台余额填写。" /></span><input aria-label="平台实际额度" type="text" inputMode="decimal" value={consumableCredit} onChange={(event) => setConsumableCredit(event.target.value)} placeholder={fundingMode === 'subscription' ? '本账期可用总额度' : '充值后到账总额'} /></label><label><span className="field-label">测试额度 <FieldHint text="固定测试被平台扣掉的额度。系统能读到时会自动填入；否则从平台使用日志复制。" /></span><input aria-label="测试额度" type="text" inputMode="decimal" value={debitCredit} onChange={(event) => setDebitCredit(event.target.value)} placeholder="运行测试后自动填写，或从日志复制" /></label></div>
      <div className="lab-module-actions" data-guide-target="lab.save"><button className="primary-button" type="button" disabled={!profile || !benchmarkModel || busy !== null || !paidCny || !consumableCredit || !debitCredit} onClick={() => void saveCalibration()}><Save size={15} />计算并保存</button><span>官方对照按标准短上下文价与固定参考汇率 1 USD = ¥{OFFICIAL_USD_TO_CNY} 自动估算。</span></div>
    </section>
  </div>
}
