import { Activity, CircleHelp, FlaskConical, ReceiptText, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { deleteCostCalibration, saveCostCalibration } from '../../adapter'
import type { AppState, CostCalibration, ProviderProfile, ProviderStability, ResponseProbeObservation } from '../../types'
import type { OperationId } from '../../operations'
import { FieldHint } from '../../shared/components'

function EvidenceHint({ grade, text }: { grade: string; text: string }) {
  return <span className={`field-hint evidence-hint evidence-${grade}`}><button type="button" aria-label={`查看证据等级 ${grade}`}>{grade}</button><span role="tooltip">{text}</span></span>
}

const BENCHMARK_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.4, cacheWriteUsdPerMillion: 5, outputUsdPerMillion: 20 },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, cacheWriteUsdPerMillion: 2.5, outputUsdPerMillion: 12 },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, cacheWriteUsdPerMillion: 0.25, outputUsdPerMillion: 1.2 },
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
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2n
}
function divideScaled(numerator: string, denominator: string) {
  const top = decimalToScaled(numerator)
  const bottom = decimalToScaled(denominator)
  return bottom > 0n ? (top * 1_000_000_000n) / bottom : null
}
function formatCny(value: string, maximumFractionDigits = 2) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '—'
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits }).format(parsed)
}
function formatUsd(value: number) {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}
function benchmarkModelLabel(model: string) {
  return BENCHMARK_MODELS.find((item) => item.id === model)?.label ?? model
}
function estimateOfficialCny(probe: ResponseProbeObservation | undefined, modelId: string) {
  const model = BENCHMARK_MODELS.find((item) => item.id === modelId)
  const usage = probe?.usage
  if (!model || !usage) return null
  const totalInput = Number(usage.inputTokens ?? 0)
  const output = Number(usage.outputTokens ?? 0) / 1_000_000
  const cached = Number(usage.cachedTokens ?? 0) / 1_000_000
  const cacheWrite = Number(usage.cacheWriteTokens ?? 0) / 1_000_000
  const uncachedInput = Math.max(0, totalInput - Number(usage.cachedTokens ?? 0) - Number(usage.cacheWriteTokens ?? 0)) / 1_000_000
  if (![uncachedInput, output, cached, cacheWrite].every(Number.isFinite)) return null
  return BigInt(Math.round((uncachedInput * model.inputUsdPerMillion + cached * model.cachedInputUsdPerMillion + cacheWrite * model.cacheWriteUsdPerMillion + output * model.outputUsdPerMillion) * OFFICIAL_USD_TO_CNY * 1_000_000_000))
}
function stabilityFor(items: ProviderStability[] | undefined, providerId: string) {
  return items?.find((item) => item.providerId === providerId)
}
function purchasePowerFor(sample: CostCalibration) {
  if (!sample.creditUnitLabel.includes('美元') && !sample.creditUnitLabel.toLowerCase().includes('usd')) return null
  const paid = Number(sample.paidCny)
  const credit = Number(sample.consumableCredit)
  return paid > 0 && credit > 0 ? credit / paid : null
}
function ledgerCnyFor(sample: CostCalibration) {
  const paid = Number(sample.paidCny)
  const credit = Number(sample.consumableCredit)
  const debit = Number(sample.debitCredit)
  return paid > 0 && credit > 0 && debit >= 0 ? debit * paid / credit : null
}
function evidenceGrade(sample: CostCalibration, power: number | null) {
  if (!power) return 'C'
  return sample.costSource && sample.costSource.startsWith('response_') ? 'A' : 'B'
}

export function LabWorkspace({ state, selectedProfile, busy, runAction, onRunCostTest, onOpenGuide }: {
  state: AppState
  selectedProfile: ProviderProfile | undefined
  busy: string | null
  runAction: (label: OperationId, action: () => Promise<AppState>) => Promise<void>
  onRunCostTest: (profileId: string, benchmarkModel: string) => Promise<void>
  onOpenGuide: () => void
}) {
  const [labProviderId, setLabProviderId] = useState(selectedProfile?.id ?? state.currentProfileId)
  const [fundingMode, setFundingMode] = useState<CostCalibration['fundingMode']>('prepaid')
  const [paidCny, setPaidCny] = useState('')
  const [consumableCredit, setConsumableCredit] = useState('')
  const [debitCredit, setDebitCredit] = useState('')
  const [debitConfirmed, setDebitConfirmed] = useState(false)
  const [testCompletedForEntry, setTestCompletedForEntry] = useState(false)
  const [creditUnit, setCreditUnit] = useState<'usd' | 'cny' | 'platform'>('usd')
  const [historyProviderId, setHistoryProviderId] = useState<string | null>(null)
  const profile = state.profiles.find((item) => item.id === labProviderId) ?? selectedProfile ?? state.profiles.find((item) => item.active)
  const [benchmarkModel, setBenchmarkModel] = useState('gpt-5.6-terra')
  const latestProbe = (state.responseProbes ?? []).find((item) => item.providerId === profile?.id && item.model === benchmarkModel && item.probeVersion === 'cost-calibration-v2')
  const completedCalibrations = (state.costCalibrations ?? []).filter((item) => item.state === 'completed' && item.debitConfirmed && item.resultCny !== '0')
  const comparableRecords = completedCalibrations.filter((item) => item.model === benchmarkModel && item.probeVersion === 'cost-calibration-v2')
  const ranking = Array.from(new Map(state.profiles.map((item) => [item.id, item])).values()).flatMap((provider) => {
    const samples = comparableRecords.filter((item) => item.providerId === provider.id)
    if (samples.length === 0) return []
    const median = medianScaled(samples.map((item) => decimalToScaled(item.resultCny)))
    const officialCosts = samples.map((sample) => sample.officialCny ? decimalToScaled(sample.officialCny) : estimateOfficialCny((state.responseProbes ?? []).find((probe) => probe.id === sample.probeId), benchmarkModel)).filter((cost): cost is bigint => cost !== null && cost > 0n)
    const effectiveRates = samples.map((sample) => divideScaled(sample.paidCny, sample.consumableCredit)).filter((rate): rate is bigint => rate !== null)
    const unitLabels = new Set(samples.map((sample) => sample.creditUnitLabel))
    const purchasePowers = samples.map(purchasePowerFor).filter((value): value is number => value !== null)
    const latest = samples[0]
    return [{ provider, samples, median, effectiveRate: effectiveRates.length > 0 ? medianScaled(effectiveRates) : null, creditUnitLabel: unitLabels.size === 1 ? samples[0]?.creditUnitLabel : '单位不一致', officialMedian: officialCosts.length > 0 ? medianScaled(officialCosts) : null, purchasePower: purchasePowers.length > 0 ? purchasePowers[purchasePowers.length - 1] : null, evidence: evidenceGrade(latest, purchasePowers.length > 0 ? purchasePowers[purchasePowers.length - 1] : null), stability: stabilityFor(state.providerStability, provider.id), latest }]
  }).toSorted((left, right) => left.median < right.median ? -1 : left.median > right.median ? 1 : 0)
  const scoredRows = ranking.filter((item) => item.purchasePower !== null && (item.stability?.sampleCount ?? 0) >= 10)
  const powers = scoredRows.map((item) => item.purchasePower as number)
  const minPower = powers.length ? Math.min(...powers) : 0
  const maxPower = powers.length ? Math.max(...powers) : 0
  const scoreFor = (item: typeof ranking[number]) => {
    if (!item.purchasePower || scoredRows.length < 2 || !item.stability || item.stability.sampleCount < 10) return null
    const pricePart = maxPower === minPower ? 70 : ((item.purchasePower - minPower) / (maxPower - minPower)) * 70
    const stabilityPart = (item.stability.successCount / Math.max(1, item.stability.sampleCount)) * 30
    return Math.max(1, Math.min(100, Math.round(pricePart + stabilityPart)))
  }
  const costSourceLabel: Record<NonNullable<CostCalibration['costSource']>, string> = { response_inline: '响应费用', response_usage: '用量费用', response_header: '响应头费用', billing_log_manual: '平台日志', balance_difference: '余额差额' }

  useEffect(() => {
    setDebitConfirmed(false)
    setTestCompletedForEntry(false)
  }, [profile?.id, benchmarkModel])
  useEffect(() => { setDebitConfirmed(false) }, [debitCredit])
  async function runFixedTest() {
    if (!profile) return
    setTestCompletedForEntry(false)
    await onRunCostTest(profile.id, benchmarkModel)
    setTestCompletedForEntry(true)
  }
  async function saveCalibration() {
    if (!profile) return
    const officialCost = estimateOfficialCny(latestProbe, benchmarkModel)
    await runAction('save-cost-calibration', () => saveCostCalibration({ providerId: profile.id, providerName: profile.name, fundingMode, paidCny, consumableCredit, debitCredit, debitConfirmed, creditUnitLabel: creditUnit === 'usd' ? '美元额度（USD）' : creditUnit === 'cny' ? '人民币余额（CNY）' : '平台额度', model: benchmarkModel || '未设置模型', probeVersion: 'cost-calibration-v2', costSource: 'billing_log_manual', probeId: latestProbe?.id, sampleKind: 'cold', officialCny: officialCost ? scaledToDecimal(officialCost) : undefined }))
    setDebitCredit('')
    setTestCompletedForEntry(false)
  }
  async function removeCalibration(calibration: CostCalibration) {
    if (!window.confirm(`删除 ${calibration.providerName} 在 ${calibration.updatedAt} 保存的这条费用记录？此操作不可恢复。`)) return
    await runAction('delete-cost-calibration', () => deleteCostCalibration(calibration.id))
  }

  return <div className="workspace-stack lab-workspace">
    <section className="lab-intro"><FlaskConical size={22} aria-hidden="true" /><div><h3>性价比中心</h3><p>用真实账单、官方价格和日常使用稳定性，回答哪个平台更值得用。</p></div><button className="icon-button workspace-guide-button" type="button" onClick={onOpenGuide} aria-label="查看实验室使用说明" title="查看实验室使用说明" data-guide-target="lab.page-help"><CircleHelp size={16} /></button></section>
    <section className="surface-panel lab-ranking" aria-labelledby="lab-ranking-title" data-guide-target="lab.ranking"><div className="section-heading-row"><div><h3 id="lab-ranking-title">服务商对比</h3><p className="section-description">官方购买力回答“每花 ¥1 能买到多少官方价值”；稳定性来自 Codex 已发生的真实使用，不额外发送请求。</p></div><details className="inline-help"><summary><ShieldCheck size={14} />证据等级</summary><p><strong>A</strong>：价格和扣费都有自动证据；<strong>B</strong>：token 自动读取，扣费人工核对；<strong>C</strong>：只有人工数据或估算，不能正式排名。</p></details></div>
      <div className="lab-benchmark-control" data-guide-target="lab.model"><label><span className="field-label">固定测试模型 <FieldHint text="排名只比较同一模型下、同一固定测试请求的结果；切换模型后会显示该模型自己的排名。" /></span><select value={benchmarkModel} onChange={(event) => { setBenchmarkModel(event.target.value); setDebitCredit('') }}>{BENCHMARK_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label></div>
      {ranking.length === 0 ? <p className="lab-empty">先运行固定测试并保存一条真实账单记录。保存后，这里会显示人民币换算；只有额度单位、token 和稳定性资料齐全的平台才进入正式评分。</p> : <div className="lab-ranking-list" role="table" aria-label="性价比排名">
        <div className="lab-ranking-head ranking-grid" role="row"><span className="ranking-cell ranking-cell--provider">服务商</span><span className="ranking-cell ranking-cell--official">官方购买力 <FieldHint text="每花 ¥1，能买到多少官方标价的同模型用量。A：价格和扣费都有自动证据；B：token 自动读取、扣费人工核对；C：只有人工数据或估算。" /></span><span className="ranking-cell ranking-cell--cost">账单换算</span><span className="ranking-cell ranking-cell--rate">稳定性 <FieldHint text="最近 30 天 Codex 真实 session 的完成率。没有可识别记录时显示“暂无”，不会额外发送测试。" /></span><span className="ranking-cell ranking-cell--score">性价比分 <FieldHint text="价格表现占 70%，真实使用稳定性占 30%。显示“待积累”表示样本还不足 10 次，不代表平台更贵或更差。" /></span><span className="ranking-cell ranking-cell--manage">管理</span></div>
        {ranking.map((item) => { const providerHistoryOpen = historyProviderId === item.provider.id; const stability = item.stability; const score = scoreFor(item); const ledger = item.latest ? ledgerCnyFor(item.latest) : null; const rateLabel = item.creditUnitLabel === '美元额度（USD）' ? '$1 额度' : item.creditUnitLabel === '人民币余额（CNY）' ? '¥1 余额' : '1 平台额度'; const evidenceText = item.evidence === 'A' ? '证据 A：价格和扣费都有自动证据' : item.evidence === 'B' ? '证据 B：token 自动读取，扣费人工核对' : '证据 C：只有人工数据或估算'; return <div className="lab-ranking-group" key={item.provider.id}><div className="lab-ranking-row ranking-grid" role="row"><div className="ranking-cell ranking-cell--provider"><strong>{item.provider.name}</strong><small>{benchmarkModelLabel(benchmarkModel)} · {item.samples.length} 条账单记录</small></div><div className="ranking-cell ranking-cell--official ranking-official">{item.purchasePower ? <><strong className="purchase-power-line"><span>{formatUsd(item.purchasePower)} / ¥1</span><EvidenceHint grade={item.evidence} text={evidenceText} /></strong><small>每花 ¥1 的官方价值</small></> : <><strong>无法计算</strong><small>缺少美元额度或价格资料</small></>}</div><div className="ranking-cell ranking-cell--cost ranking-cost">{ledger !== null ? <><strong>{formatCny(ledger.toString())}</strong><small>本次 {item.latest?.debitCredit} {rateLabel}</small></> : <><strong>待核对</strong><small>需要平台真实扣费</small></>}</div><div className="ranking-cell ranking-cell--rate ranking-rate">{stability && stability.sampleCount > 0 ? <><strong>{Math.round(stability.successCount / stability.sampleCount * 1000) / 10}%</strong><small>{stability.sampleCount} 次真实使用 · 超时 {stability.timeoutCount} 次</small></> : <><strong>暂无</strong><small>还没有可识别的日常 session</small></>}</div><div className={`ranking-cell ranking-cell--score ranking-score${score === null ? ' is-pending' : ''}`}><strong>{score === null ? '待积累' : `${score} 分`}</strong></div><button className="ghost-button ranking-cell ranking-cell--manage ranking-manage" type="button" onClick={() => setHistoryProviderId(providerHistoryOpen ? null : item.provider.id)}>{providerHistoryOpen ? '收起' : '详情'}</button></div>{providerHistoryOpen && <div className="lab-history-list"><strong><ReceiptText size={14} /> 这组数据怎么来的</strong><p>额度折算：实际支付 ÷ 实际到账。平台账单的每一笔扣费都用这个比例换成人民币；不会把不同请求的 token 硬凑成同一个数字。</p>{item.samples.map((sample) => { const samplePower = purchasePowerFor(sample); const sampleLedger = ledgerCnyFor(sample); return <div className="lab-history-row" key={sample.id}><span>{sample.updatedAt} · {costSourceLabel[sample.costSource ?? 'billing_log_manual']} · {sample.creditUnitLabel}</span><strong>{sampleLedger === null ? '待核对' : formatCny(sampleLedger.toString())}{samplePower ? ` · ${formatUsd(samplePower)} / ¥1` : ''}</strong><button className="danger-text-button" type="button" disabled={busy !== null} onClick={() => void removeCalibration(sample)}><Trash2 size={14} />删除</button></div> })}</div>}</div> })}
      </div>}
    </section>
    <section className="surface-panel lab-record-cost"><div className="section-heading-row"><div><h3>新增测试样本</h3></div><details className="inline-help"><summary>费用如何计算</summary><p>实测成本 = 实际支付 × 本次扣减 ÷ 实际到账；实际汇率 = 实际支付 ÷ 实际到账。额度和扣减必须使用同一单位。</p></details></div>
      <div className="lab-selected-provider" data-guide-target="lab.provider"><label>服务商<select value={profile?.id ?? ''} onChange={(event) => { setLabProviderId(event.target.value); setDebitCredit('') }}>{state.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span>固定模型：{benchmarkModelLabel(benchmarkModel || '未选择模型')}</span></div>
      <div className={`lab-probe-status ${latestProbe ? latestProbe.status : 'idle'}`} data-guide-target="lab.probe"><div><strong>{latestProbe?.costCandidate ? '需要从平台日志补充真实扣额' : latestProbe ? '已完成固定测试' : '尚未运行测试'}</strong><span>{latestProbe?.costCandidate ? '服务端返回了费用提示，但未证明它等于平台真实扣额。请按请求编号到平台日志核对后填写。' : latestProbe ? latestProbe.detail : '先运行固定测试。完成后再填写平台账单中的真实扣额并保存。'}</span></div></div>
      <div className="lab-form" data-guide-target="lab.cost-fields"><label><span className="field-label">计费方式 <FieldHint text="充值：按实际付款换得平台余额。订阅固定：填写本账期的实际付款和可用总额度。" /></span><select aria-label="计费方式" value={fundingMode} onChange={(event) => setFundingMode(event.target.value as CostCalibration['fundingMode'])}><option value="prepaid">充值</option><option value="subscription">订阅固定</option></select></label><label><span className="field-label">额度单位 <FieldHint text="按平台余额页面显示的单位选择：美元、人民币或平台自定义点数。到账额度与本次扣减必须使用同一种单位。" /></span><select aria-label="额度单位" value={creditUnit} onChange={(event) => setCreditUnit(event.target.value as 'usd' | 'cny' | 'platform')}><option value="usd">美元额度（USD）</option><option value="cny">人民币余额（CNY）</option><option value="platform">平台额度/点数</option></select></label><label><span className="field-label">实际支付（人民币） <FieldHint text="购买这笔平台额度实际支付的人民币金额。" /></span><input aria-label="实际支付人民币" type="text" inputMode="decimal" value={paidCny} onChange={(event) => setPaidCny(event.target.value)} placeholder="例如 70" /></label><label><span className="field-label">实际到账额度 <FieldHint text="付款后可用于调用的总额度，含赠送和折扣，按平台后台余额填写。" /></span><input aria-label="实际到账额度" type="text" inputMode="decimal" value={consumableCredit} onChange={(event) => setConsumableCredit(event.target.value)} placeholder={fundingMode === 'subscription' ? '本账期可用总额度' : '例如 10'} /></label><label><span className="field-label">本次真实扣减 <FieldHint text="固定测试被平台扣掉的额度。系统能读到时会自动填入；否则从平台使用日志复制。" /></span><input aria-label="本次真实扣减" type="text" inputMode="decimal" value={debitCredit} onChange={(event) => setDebitCredit(event.target.value)} placeholder="自动读取，或从平台日志复制" /></label></div>
      <label className="lab-confirm-debit"><input aria-label="已核对平台真实扣减" type="checkbox" checked={debitConfirmed} onChange={(event) => setDebitConfirmed(event.target.checked)} /><span>我已确认：填写的是平台使用日志的真实扣额，且和到账额度使用同一单位。</span></label>
      <div className="lab-module-actions" data-guide-target="lab.save">
        {!testCompletedForEntry ? <button className="primary-button" type="button" disabled={!profile || !benchmarkModel || busy !== null} onClick={() => void runFixedTest()}><Activity size={15} />运行固定测试</button> : <button className="primary-button" type="button" disabled={!profile || !benchmarkModel || busy !== null || !paidCny || !consumableCredit || !debitCredit || !debitConfirmed} onClick={() => void saveCalibration()}><Save size={15} />计算并保存</button>}
        <span>{testCompletedForEntry ? '已完成测试。确认本次真实扣额后保存；保存后才能开始下一次测试。' : '先运行固定测试；完成后才能保存本次人民币成本。'}</span>
      </div>
    </section>
  </div>
}
