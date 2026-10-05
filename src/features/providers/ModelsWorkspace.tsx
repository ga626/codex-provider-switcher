import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  CircleDollarSign,
  Check,
  KeyRound,
  RefreshCcw,
  Route,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ModelCatalog, ProviderProfile } from '../../types'
import {
  codexCompatibility,
  modelSelectionRank,
  providerModelLabel,
} from './model-utils'
import { providerConnectionKind, providerEndpointHostname } from './provider-utils'
import { verificationPresentation } from './verification-copy'

type SwitchScenario = {
  id: string
  from: string
  to: string
  kind: string
  route: string
  auth: string
  billing: string
  officialFeatures: string
  result: string
  risk: 'low' | 'medium' | 'high'
}

const scenarioRows: SwitchScenario[] = [
  { id: 'relay-gpt-to-relay-gpt', from: '中转 A · GPT', to: '中转 B · GPT', kind: '只换服务商', route: '请求从 A 改到 B；同名模型也重新探针。', auth: '切换为 B 的 API key。', billing: '由中转站 B 计费。', officialFeatures: '不因模型叫 GPT 而获得 ChatGPT 订阅权益。', result: '配置与历史保留；需重新验证 B 的工具、额度和同名映射。', risk: 'low' },
  { id: 'relay-gpt-to-same-deepseek', from: '中转 A · GPT', to: '中转 A · DeepSeek', kind: '同站换模型', route: '地址不变，只改变模型 id。', auth: '继续使用 A 的 API key。', billing: '仍由中转站 A 计费。', officialFeatures: '语音、官方连接器和 ChatGPT 额度不继承。', result: '工具、Responses、上下文能力可能下降；选择前显示风险。', risk: 'medium' },
  { id: 'relay-gpt-to-other-deepseek', from: '中转 A · GPT', to: '中转 B · DeepSeek', kind: '服务商和模型都换', route: 'endpoint、上游和模型同时改变。', auth: '切换为 B 的 API key。', billing: '由中转站 B 计费。', officialFeatures: '不继承 ChatGPT 账号能力。', result: '两层风险叠加；路由质量和模型协议必须分开验收。', risk: 'high' },
  { id: 'relay-gpt-to-deepseek-api', from: '中转 · GPT', to: 'DeepSeek 官方 API', kind: '切到厂商官方', route: '请求直达 DeepSeek 官方 endpoint。', auth: '改用 DeepSeek 官方 key。', billing: '由 DeepSeek 官方账户计费。', officialFeatures: 'ChatGPT 语音、插件和工作区权益不跟随。', result: '本地配置保留；模型按部分适配显示，真实探针通过后再升级。', risk: 'medium' },
  { id: 'relay-deepseek-to-deepseek-api', from: '中转 · DeepSeek', to: 'DeepSeek 官方 API', kind: '同名模型换来源', route: '模型名可能相同，但上游从中转改为官方。', auth: '改用 DeepSeek 官方 key。', billing: '由 DeepSeek 官方账户计费。', officialFeatures: '不涉及 ChatGPT 官方权益。', result: '官方与中转版本、价格和内容策略可能不同，不能复用旧验证。', risk: 'medium' },
  { id: 'relay-gpt-to-openai-api', from: '中转 · GPT', to: 'OpenAI Platform API', kind: '切到官方 API', route: '请求改到 api.openai.com。', auth: '改用 OpenAI Platform API key。', billing: '由 OpenAI API 项目计费。', officialFeatures: '不使用 ChatGPT 订阅额度或网页端免费能力。', result: 'Codex 协议适配通常最高，但 Platform API 与 ChatGPT 登录仍是两套账户控制面。', risk: 'low' },
  { id: 'relay-gpt-to-chatgpt', from: '中转 · GPT', to: 'ChatGPT 官方账号', kind: '切到官方账号', route: '请求切回 ChatGPT 官方 Codex 后端。', auth: '使用 Codex 当前有效 OAuth；不把 token 当 API key。', billing: '按 ChatGPT 计划或工作区计量。', officialFeatures: '按账号计划、地区和工作区权限恢复；不是中转站解锁。', result: '请求不再经过中转；OAuth 过期时必须重新登录，不能恢复旧快照。', risk: 'medium' },
  { id: 'relay-deepseek-to-chatgpt', from: '中转 · DeepSeek', to: 'ChatGPT 官方账号', kind: '模型与认证全换', route: '请求从第三方 API 切回官方 Codex 后端。', auth: '从第三方 key 切到当前有效 OAuth。', billing: '由 ChatGPT 计划计量。', officialFeatures: '按账号实际权限恢复。', result: '旧 DeepSeek 会话不会变成 ChatGPT 会话；新会话重新建立模型上下文。', risk: 'medium' },
  { id: 'chatgpt-to-third-party', from: 'ChatGPT 官方账号', to: '任意第三方模型', kind: '保留身份，切换模型线路', route: '模型请求转到中转站或厂商官方 API。', auth: 'OAuth 原样保留；第三方 key 由当前 provider 的短时助手独立提供。', billing: '模型请求由第三方平台计费。', officialFeatures: '语音、官方连接器等仍需在正式 Codex 中逐项验收，不能只凭登录状态承诺。', result: 'MCP、插件、钩子和历史不变；界面明确显示官方身份与当前模型上游。', risk: 'medium' },
  { id: 'mixed-auth', from: '官方 OAuth + 第三方 key', to: '分离式混合模式', kind: '身份与推理分开', route: 'Codex 保留官方身份，Responses 模型请求按当前 provider 配置路由。', auth: '两套凭据互不覆盖：OAuth 由 Codex 管理，第三方 key 由 Signalman 加密保存并按 provider 临时提供。', billing: '第三方模型请求由当前 provider 计费；官方能力是否另有计量以正式客户端实测为准。', officialFeatures: '身份保留已可验证；Voice、Remote Control 和插件组合能力仍标记为待真机验收。', result: '这是首版可用合同，不把“OAuth 已保留”冒充“所有官方能力已解锁”。', risk: 'medium' },
]

const accountStates = [
  { id: 'not-connected', label: '未登录', tone: 'neutral', title: '尚未接入 ChatGPT 官方账号', detail: '只能使用已配置的中转站或官方 API key；官方账号能力不可用。', action: '切到官方模式前发起一次受控登录。' },
  { id: 'ready', label: 'OAuth 有效', tone: 'good', title: '官方账号当前可用', detail: '切回 ChatGPT 官方模式后，按账号计划、地区和工作区权限使用；不会解锁第三方请求。', action: '保留 live OAuth，不复制旧 auth.json 快照。' },
  { id: 'expired', label: 'OAuth 过期', tone: 'warning', title: '登录状态需要刷新', detail: '重启 Codex 不能自动修复失效凭据，也不能用 Platform API key 代替 OAuth。', action: '停止切换并要求重新完成官方登录。' },
  { id: 'mixed', label: '身份已分离', tone: 'warning', title: '官方身份保留，模型走第三方', detail: 'Signalman 不改 auth.json，第三方 key 只交给当前 provider；这仍不等于 Voice、Remote Control 或插件已通过组合验收。', action: '显示实际上游和计费归属，并在正式 Codex 中逐项验证官方能力。' },
] as const

function describeCurrentConnection(profile: ProviderProfile | undefined) {
  if (!profile) return { source: '未选择', auth: '未识别', billing: '未识别' }
  const identity = `${profile.id} ${profile.name}`.toLocaleLowerCase()
  const hostname = providerEndpointHostname(profile.baseUrl)
  if (providerConnectionKind(profile) === 'chatgpt-account') return { source: 'ChatGPT 官方 Codex 后端', auth: 'OAuth 官方账号', billing: 'ChatGPT 计划 / 工作区' }
  if (hostname === 'api.openai.com' || identity.includes('openai-platform')) return { source: 'OpenAI Platform API', auth: 'Platform API key', billing: 'OpenAI API 项目' }
  if (hostname === 'api.deepseek.com' || identity.includes('deepseek-official')) return { source: 'DeepSeek 官方 API', auth: 'DeepSeek API key', billing: 'DeepSeek 官方账户' }
  if (identity.includes('hybrid') || identity.includes('mixed')) return { source: '实验性双通道', auth: 'OAuth + 第三方 key', billing: '必须实测确认' }
  return { source: '第三方中转 / 兼容 API', auth: '服务商 API key', billing: '当前服务商账户' }
}

export function ModelsWorkspace({ selectedProfile, selectedModelCatalog, busy, selectModel, onRefreshModels, onToggleCodexSelection }: {
  selectedProfile: ProviderProfile | undefined
  selectedModelCatalog: ModelCatalog | undefined
  busy: string | null
  selectModel: (model: string) => Promise<void>
  onRefreshModels: () => void
  onToggleCodexSelection: (model: ModelCatalog['models'][number], enabled: boolean) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [showScenarios, setShowScenarios] = useState(false)
  const [scenarioId, setScenarioId] = useState(scenarioRows[0].id)
  const [accountStateId, setAccountStateId] = useState<(typeof accountStates)[number]['id']>('ready')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleModels = useMemo(() => Array.from(new Map((selectedModelCatalog?.models ?? []).map((model) => [model.id, model])).values())
    .filter((model) => !normalizedQuery || [model.id, ...model.aliases, ...model.tags].join(' ').toLocaleLowerCase().includes(normalizedQuery))
    .toSorted((left, right) => modelSelectionRank(left) - modelSelectionRank(right)), [normalizedQuery, selectedModelCatalog])
  const totalModels = selectedModelCatalog?.models.length ?? 0
  const connection = describeCurrentConnection(selectedProfile)
  const activeScenario = scenarioRows.find((scenario) => scenario.id === scenarioId) ?? scenarioRows[0]
  const activeAccountState = accountStates.find((state) => state.id === accountStateId) ?? accountStates[0]
  const joinedCount = visibleModels.filter((model) => model.codexEnabled ?? defaultCodexSelection(model, selectedProfile?.model)).length

  return (
    <div className="workspace-stack">
      <section className="surface-panel model-toolbar">
        <div><span>当前服务商</span><strong>{selectedProfile?.name ?? '未选择'}</strong><small>{selectedProfile?.model ? `当前模型：${providerModelLabel(selectedProfile.model)}` : '选择左侧服务商后刷新模型目录'}</small></div>
        <div className="model-toolbar-actions"><label className="model-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型、厂商或能力" /></label><button className="primary-button" type="button" onClick={onRefreshModels} disabled={!selectedProfile || busy !== null}><RefreshCcw size={16} />刷新模型目录</button></div>
      </section>

      <section className="connection-facts" aria-label="当前连接身份">
        <div><Route size={17} /><span><small>实际请求去向</small><strong>{connection.source}</strong></span></div>
        <div><KeyRound size={17} /><span><small>认证方式</small><strong>{connection.auth}</strong></span></div>
        <div><CircleDollarSign size={17} /><span><small>计费归属</small><strong>{connection.billing}</strong></span></div>
      </section>

      <section className="compatibility-summary" aria-label="Codex 模型适配说明">
        <div><ShieldCheck size={18} /><span><strong>点击模型即可设为当前服务商的默认模型</strong><small>“可接入”表示尚未实测，不代表不可用；实际请求结果会更新适配状态。</small></span></div>
        <button className="ghost-button compact-button" type="button" onClick={() => setShowScenarios((value) => !value)}>{showScenarios ? '收起切换模拟' : '查看 10 种切换模拟'}</button>
      </section>

      {showScenarios && <section className="surface-panel scenario-matrix" aria-label="切换影响模拟">
        <div className="section-heading-row"><div><span className="eyebrow">安全模拟</span><h3>切换后会发生什么</h3><p className="section-description">选择一个情况，分别看请求去向、认证、计费和官方能力。这里只模拟，不写真实配置。</p></div><span className="section-meta">10 种组合</span></div>
        <div className="scenario-layout">
          <div className="scenario-list" role="list" aria-label="切换情况">
            {scenarioRows.map((scenario) => <button className={scenario.id === activeScenario.id ? 'active' : ''} type="button" key={scenario.id} onClick={() => setScenarioId(scenario.id)}><span>{scenario.from}<ArrowRight size={13} />{scenario.to}</span><small>{scenario.kind}</small></button>)}
          </div>
          <article className={`scenario-detail ${activeScenario.risk}`} aria-live="polite">
            <div className="scenario-detail-title"><span className={`scenario-risk ${activeScenario.risk}`}>{activeScenario.risk === 'low' ? '低风险' : activeScenario.risk === 'medium' ? '需确认' : '高风险'}</span><strong>{activeScenario.kind}</strong></div>
            <dl>
              <div><dt>请求去向</dt><dd>{activeScenario.route}</dd></div>
              <div><dt>认证方式</dt><dd>{activeScenario.auth}</dd></div>
              <div><dt>计费归属</dt><dd>{activeScenario.billing}</dd></div>
              <div><dt>官方能力</dt><dd>{activeScenario.officialFeatures}</dd></div>
            </dl>
            <p><Sparkles size={15} />{activeScenario.result}</p>
          </article>
        </div>
        <div className="account-state-simulator" aria-label="OpenAI 官方账号状态模拟">
          <div><span className="eyebrow">官方账号状态</span><strong>登录状态与当前请求路线分开判断</strong></div>
          <div className="account-state-tabs" role="tablist" aria-label="选择账号状态">{accountStates.map((state) => <button className={state.id === activeAccountState.id ? 'active' : ''} type="button" role="tab" aria-selected={state.id === activeAccountState.id} key={state.id} onClick={() => setAccountStateId(state.id)}>{state.label}</button>)}</div>
          <article className={`account-state-detail ${activeAccountState.tone}`}><strong>{activeAccountState.title}</strong><p>{activeAccountState.detail}</p><small>系统动作：{activeAccountState.action}</small></article>
        </div>
        <p className="scenario-preserved"><CheckCircle2 size={15} />所有模拟遵守同一底线：MCP、plugins、hooks、projects、features、desktop、memories 和历史文件不属于 provider 切换写入范围。</p>
      </section>}

      <section className="surface-panel"><div className="model-table"><div className="model-table-head"><span>模型 {normalizedQuery ? `(${visibleModels.length}/${totalModels})` : `(${totalModels})`}</span><span>显示在 Codex <b className="model-joined-count">{joinedCount}/{visibleModels.length}</b></span></div>
        {visibleModels.length ? visibleModels.map((model) => {
          const compatibility = codexCompatibility(model, selectedProfile?.capabilityProfile?.protocol)
          const joined = model.codexEnabled ?? defaultCodexSelection(model, selectedProfile?.model)
          const selected = selectedProfile?.model.toLocaleLowerCase() === model.id.toLocaleLowerCase()
          const blocked = compatibility.level === 'unsupported'
          const select = () => { if (!blocked && !selected && !busy) void selectModel(model.id) }
          return <div className={`model-row model-selectable ${selected ? 'selected' : ''} ${compatibility.level} ${joined ? 'codex-joined' : ''} ${blocked ? 'model-blocked' : ''}`} key={model.id} role="button" tabIndex={blocked || busy !== null ? -1 : 0} aria-pressed={selected} aria-disabled={blocked || busy !== null} title={compatibility.detail} onClick={select} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select() } }}><span className="model-row-copy"><span className="model-title-line"><strong>{providerModelLabel(model.id)}</strong><em className={`compatibility-badge ${compatibility.level}`}>{compatibility.label}</em></span>{providerModelLabel(model.id) !== model.id && <small>模型标识：{model.id}</small>}{model.aliases.length > 0 && <small>别名：{model.aliases.join(', ')}</small>}{selected && model.verifiedForResponses !== 'unknown' && <small>{verificationPresentation({ verified: model.verifiedForResponses === 'verified', verificationStatus: model.lastVerificationStatus ?? (model.verifiedForResponses === 'verified' ? 'verified' : model.verifiedForResponses === 'timed_out_unconfirmed' ? 'timed_out_unconfirmed' : 'provider_error'), lastVerifiedAt: model.lastVerificationAt, lastVerificationDetail: model.lastVerificationDetail }).summary}</small>}</span><label className={`model-join-toggle ${joined ? 'active' : ''}`} title={selected ? '当前默认模型必须保留在列表中' : joined ? '已显示在 Codex 模型列表' : '显示在 Codex 模型列表'} onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={joined} disabled={busy !== null || selected || blocked} onChange={(event) => void onToggleCodexSelection(model, event.currentTarget.checked)} /><span className="model-join-box" aria-hidden="true">{joined && <Check size={11} strokeWidth={2.5} />}</span><span>显示</span></label></div>
        }) : <div className="empty-state"><Boxes size={28} /><strong>{normalizedQuery ? '没有匹配的模型' : '还没有可展示的模型'}</strong><span>{normalizedQuery ? '尝试更换关键词。' : selectedModelCatalog?.statusDetail ?? '刷新后展示服务商实际返回的模型。'}</span></div>}
      </div></section>
    </div>
  )
}

function defaultCodexSelection(model: ModelCatalog['models'][number], currentModel?: string) {
  return model.id === currentModel || model.tags.includes('codex') || model.verifiedForResponses === 'verified'
}
