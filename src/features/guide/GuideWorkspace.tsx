import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AppState } from '../../types'
import { ModalDialog } from '../../shared/components'

export type GuideViewId = 'providers' | 'models' | 'switch-check' | 'protection' | 'timeline' | 'lab'
export type GuideChapterId = 'initialization' | 'providers' | 'protection' | 'timeline' | 'lab' | 'overview'
export type GuideProgress = Record<GuideChapterId, { lastStep: number; completedAt?: string; dismissedAt?: string }>

export const GUIDE_PROGRESS_KEY = 'signalman-ai-guide-progress-v1'

export const guideChapterForView = (view: GuideViewId): GuideChapterId => {
  if (view === 'protection') return 'protection'
  if (view === 'timeline') return 'timeline'
  if (view === 'lab') return 'lab'
  return 'providers'
}

function emptyGuideProgress(): GuideProgress {
  return {
    initialization: { lastStep: 0 },
    providers: { lastStep: 0 },
    protection: { lastStep: 0 },
    timeline: { lastStep: 0 },
    lab: { lastStep: 0 },
    overview: { lastStep: 0 },
  }
}

export function readGuideProgress(): GuideProgress {
  try {
    const stored = window.localStorage.getItem(GUIDE_PROGRESS_KEY)
    if (!stored) return emptyGuideProgress()
    const parsed = JSON.parse(stored) as Partial<GuideProgress>
    const fallback = emptyGuideProgress()
    return Object.fromEntries(Object.keys(fallback).map((id) => [id, { ...fallback[id as GuideChapterId], ...parsed[id as GuideChapterId] }])) as GuideProgress
  } catch {
    return emptyGuideProgress()
  }
}

type GuideStep = { id: string; title: string; detail: string; target: string; view?: GuideViewId }
type GuideChapter = { title: string; summary: string; steps: GuideStep[] }

export const GUIDE_CHAPTERS: Record<GuideChapterId, GuideChapter> = {
  initialization: {
    title: '初始化配置', summary: '准备连接环境并跑通第一个服务商。', steps: [
      { id: 'environment', title: '先准备连接环境', detail: '新电脑的 Codex 配置可能不同。先创建恢复点，再只统一 Signalman 管理的连接字段；项目、MCP、插件和历史记录不会被改动。', target: 'providers.environment', view: 'providers' },
      { id: 'add', title: '新增服务商', detail: '点击加号新增一条连接；已有服务商直接从列表选择，不需要重复添加。', target: 'providers.add', view: 'providers' },
      { id: 'name', title: '填写服务商名称', detail: '给这条连接起一个容易认出的名字，例如“公司中转站”。', target: 'providers.name', view: 'providers' },
      { id: 'endpoint', title: '填写接口地址', detail: '粘贴服务商提供的 API 基地址。Codex 连接失败时，可尝试在末尾补上 /v1。', target: 'providers.endpoint', view: 'providers' },
      { id: 'key', title: '填写访问密钥', detail: '密钥默认隐藏；点击眼睛只会在本机临时显示，反馈内容不会包含密钥。', target: 'providers.key', view: 'providers' },
      { id: 'model', title: '选择默认模型', detail: '填好名称、接口和密钥后就能点击刷新图标。目录先显示在表单里，不会保存配置；展开后可搜索和滚动选择。', target: 'providers.model', view: 'providers' },
      { id: 'save', title: '保存配置', detail: '保存后，右侧检查会读取这条新配置。未保存的修改不能直接拿去测试或切换。', target: 'providers.save', view: 'providers' },
      { id: 'availability', title: '运行可用性测试', detail: '这里会实际请求当前服务商，并分别显示超时、限流、鉴权或协议问题；它不会切换 Codex 配置。', target: 'providers.availability', view: 'providers' },
      { id: 'switch', title: '检查并切换', detail: '最后执行检查并切换。安全阻止不能绕过；使用风险会明确说明，并在确认前让你选择是否继续。', target: 'providers.switch', view: 'providers' },
    ],
  },
  providers: {
    title: '服务商', summary: '管理已有连接、模型、测试和切换。', steps: [
      { id: 'list', title: '服务商列表', detail: '点击条目开始编辑；可用拖动手柄或键盘调整显示顺序。', target: 'providers.list', view: 'providers' },
      { id: 'add', title: '新增一条连接', detail: '加号会打开一条空白配置，不会覆盖现有服务商。', target: 'providers.add', view: 'providers' },
      { id: 'form', title: '基础配置', detail: '名称、接口、默认模型和访问密钥在这里填写；备注只用于本机识别。', target: 'providers.form', view: 'providers' },
      { id: 'model', title: '模型选择与刷新', detail: '未保存时，刷新会使用当前填写的接口和密钥，不写入本机目录；已保存时，刷新对应服务商的模型目录。模型框支持搜索和滚动选择。', target: 'providers.model', view: 'providers' },
      { id: 'save', title: '保存与管理', detail: '保存后才会更新检查结果。这里还可以复制配置、设为默认或删除不再需要的服务商。', target: 'providers.actions', view: 'providers' },
      { id: 'availability', title: '可用性测试', detail: '测试会请求当前服务商，不会改写 Codex 配置。结果会区分限流、鉴权、超时和响应格式。', target: 'providers.availability', view: 'providers' },
      { id: 'switch', title: '检查并切换', detail: '切换前会重新核对当前配置并创建恢复点。安全检查和使用风险是两种不同状态。', target: 'providers.switch', view: 'providers' },
      { id: 'feedback', title: '报告兼容问题', detail: '服务商异常且需要维护者适配时会出现此按钮。提交内容不含密钥、配置正文、文件路径或响应原文。', target: 'providers.feedback', view: 'providers' },
    ],
  },
  protection: {
    title: '安全与恢复', summary: '查看保护范围、备份和恢复入口。', steps: [
      { id: 'baseline', title: '首次启动基线', detail: '这是首次写入前的恢复点，会永久保留，用于确认原始状态。', target: 'protection.baseline', view: 'protection' },
      { id: 'environment', title: '重新准备连接环境', detail: '当连接设置需要重新扫描时使用。它会创建恢复点，只处理 Signalman 管理的连接字段。', target: 'protection.reprepare', view: 'protection' },
      { id: 'scope', title: '保护范围', detail: '这里明确区分本工具管理的服务商、模型和接口地址，以及始终保持不变的 MCP、插件和项目设置。', target: 'protection.scope', view: 'protection' },
      { id: 'backup', title: '立即备份当前状态', detail: '手动备份适合保存一个已验证可用的状态。达到数量上限时会先提示你将替换最早的一条。', target: 'protection.manual-backup', view: 'protection' },
      { id: 'groups', title: '恢复点分类', detail: '首次基线、自动保护和手动保存分别说明来源和保留方式。', target: 'protection.groups', view: 'protection' },
      { id: 'restore', title: '安全恢复', detail: '恢复前需要输入“恢复”确认。它只回退 Signalman 写入的字段，不覆盖你的 MCP、插件和项目设置。', target: 'protection.restore', view: 'protection' },
    ],
  },
  timeline: {
    title: '活动记录', summary: '查看最近的保存、检查、切换和恢复动作。', steps: [
      { id: 'activity', title: '活动记录', detail: '每条记录显示发生时间、动作结果和必要说明，方便你确认最近一次操作做了什么。', target: 'timeline.list', view: 'timeline' },
      { id: 'tone', title: '状态颜色', detail: '绿色表示完成，黄色表示需要留意，红色表示失败或阻止；请优先查看最靠前的一条。', target: 'timeline.item', view: 'timeline' },
      { id: 'read-only', title: '只读排查入口', detail: '这里不会修改配置。遇到问题时先核对最近一条记录，再回到对应工作区处理。', target: 'timeline.list', view: 'timeline' },
    ],
  },
  lab: {
    title: '实验室', summary: '用同一固定测试记录费用并比较性价比。', steps: [
      { id: 'model', title: '固定测试模型', detail: '排名只比较同一模型和同一固定测试请求；切换模型后会显示它自己的结果。', target: 'lab.model', view: 'lab' },
      { id: 'ranking', title: '成本结果与排名', detail: '保存一条样本就会显示本次成本；有两个服务商后才会出现横向排名。', target: 'lab.ranking', view: 'lab' },
      { id: 'official', title: '官方对照与评分', detail: '官方对照表示本次成本占官方估算成本的百分比；评分以本表最低成本为 100 分。', target: 'lab.ranking', view: 'lab' },
      { id: 'samples', title: '管理原始样本', detail: '展开某个服务商可查看原始样本并删除错误记录。多次样本会取中位数，建议测 3 次但不强制。', target: 'lab.ranking', view: 'lab' },
      { id: 'provider', title: '选择要测试的服务商', detail: '先选择服务商，再确认固定模型。测试不会切换 Codex 配置。', target: 'lab.provider', view: 'lab' },
      { id: 'probe', title: '运行固定测试', detail: '系统会发送一条极短请求；如果响应里有可用费用信息，会自动填入测试额度。', target: 'lab.probe', view: 'lab' },
      { id: 'cost', title: '填写费用字段', detail: '充值金额填写人民币；平台实际额度和测试额度只需来自同一个平台余额体系，不需要与其他服务商统一单位。', target: 'lab.cost-fields', view: 'lab' },
      { id: 'save', title: '计算并保存', detail: '人民币成本按充值金额乘以测试额度再除以平台实际额度计算。保存后会立即更新上方结果。', target: 'lab.save', view: 'lab' },
    ],
  },
  overview: {
    title: '整体功能', summary: '认识工作区、状态栏、设置、更新和反馈入口。', steps: [
      { id: 'navigation', title: '主工作区', detail: '顶部在服务商、安全与恢复、活动记录和实验室之间切换；模型目录和切换前检查属于服务商上下文。', target: 'overview.navigation' },
      { id: 'current', title: '当前正在使用', detail: '这里显示当前 Codex 配置识别到的服务商和模型，不代表其他服务商已经被删除。', target: 'overview.current' },
      { id: 'help', title: '使用说明目录', detail: '任何时候都可以从问号或状态栏打开目录，选择需要重看的章节。', target: 'overview.help' },
      { id: 'settings', title: '应用设置', detail: '设置中包含开机启动、备份数量和检查更新；不会把你的本机资料上传到外部。', target: 'overview.settings' },
      { id: 'status', title: '状态栏', detail: '状态栏显示当前操作、连接环境状态和本机资料边界。', target: 'overview.statusbar-help' },
    ],
  },
}

export function GuideHubDialog({ progress, onClose, onStart }: { progress: GuideProgress; onClose: () => void; onStart: (chapter: GuideChapterId) => void }) {
  const chapterIds = Object.keys(GUIDE_CHAPTERS) as GuideChapterId[]
  return <ModalDialog className="guide-hub-dialog" labelledBy="guide-hub-title" onClose={onClose}>
    <div className="section-heading-row">
      <div><span className="eyebrow">使用说明</span><h2 id="guide-hub-title">选择要了解的功能</h2></div>
      <button className="icon-button" type="button" onClick={onClose} aria-label="关闭使用说明" data-dialog-initial-focus><X size={16} /></button>
    </div>
    <p className="guide-hub-intro">初始化配置会在首次准备完成后自动打开。其他说明可按当前需要随时重看。</p>
    <div className="guide-chapter-list">
      {chapterIds.map((id) => {
        const chapter = GUIDE_CHAPTERS[id]
        const state = progress[id]
        const status = state.completedAt ? '已看过' : state.dismissedAt ? `继续第 ${Math.min(state.lastStep + 1, chapter.steps.length)} 步` : '未开始'
        return <section className="guide-chapter-card" key={id}>
          <div><strong>{chapter.title}</strong><span>{chapter.summary}</span><small>{chapter.steps.length} 步 · {status}</small></div>
          <button className="ghost-button" type="button" onClick={() => onStart(id)}>{state.completedAt ? '重新查看' : state.dismissedAt ? '继续' : '开始'}</button>
        </section>
      })}
    </div>
  </ModalDialog>
}

type TourRect = { top: number; left: number; right: number; bottom: number; width: number; height: number }

export function ProductGuideTour({ chapter, environment, progress, onClose, onOpenView, onProgress, onContinueProviders }: {
  chapter: GuideChapterId
  environment: AppState['connectionEnvironment']
  progress: GuideProgress[GuideChapterId]
  onClose: () => void
  onOpenView: (view: GuideViewId) => void
  onProgress: (next: Partial<GuideProgress[GuideChapterId]>) => void
  onContinueProviders: () => void
}) {
  const chapterDefinition = GUIDE_CHAPTERS[chapter]
  const steps = chapter === 'initialization' && environment.status === 'ready' ? chapterDefinition.steps.slice(1) : chapterDefinition.steps
  const [step, setStep] = useState(() => Math.min(progress.lastStep, Math.max(0, steps.length - 1)))
  const [rect, setRect] = useState<TourRect | null>(null)
  const [targetMissing, setTargetMissing] = useState(false)
  const [cardPosition, setCardPosition] = useState<{ top: number; left: number } | null>(null)
  const cardRef = useRef<HTMLElement | null>(null)
  const current = steps[Math.min(step, steps.length - 1)]

  useEffect(() => {
    setStep(Math.min(progress.lastStep, Math.max(0, steps.length - 1)))
  }, [chapter, progress.lastStep, steps.length])

  useLayoutEffect(() => {
    if (current.view) onOpenView(current.view)
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let missingTimer: number | undefined
    let observer: ResizeObserver | undefined
    const measure = () => {
      const element = document.querySelector<HTMLElement>(`[data-guide-target="${current.target}"]`)
      if (!element || element.offsetParent === null) {
        setRect(null)
        if (missingTimer === undefined) missingTimer = window.setTimeout(() => setTargetMissing(true), 450)
        return
      }
      if (missingTimer !== undefined) window.clearTimeout(missingTimer)
      missingTimer = undefined
      setTargetMissing(false)
      const bounds = element.getBoundingClientRect()
      if (bounds.top < 18 || bounds.bottom > window.innerHeight - 18) element.scrollIntoView({ block: 'nearest', behavior: media.matches ? 'auto' : 'smooth' })
      const read = () => {
        const next = element.getBoundingClientRect()
        setRect({ top: next.top, left: next.left, right: next.right, bottom: next.bottom, width: next.width, height: next.height })
      }
      read()
      observer?.disconnect()
      observer = new ResizeObserver(read)
      observer.observe(element)
    }
    const schedule = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(measure) }
    frame = window.requestAnimationFrame(measure)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      window.cancelAnimationFrame(frame)
      if (missingTimer !== undefined) window.clearTimeout(missingTimer)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [current.target, current.view, onOpenView])

  useLayoutEffect(() => {
    const update = () => {
      const card = cardRef.current
      if (!card) return
      const margin = 18
      const cardWidth = card.offsetWidth
      const cardHeight = card.offsetHeight
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      if (!rect) {
        setCardPosition({ top: Math.max(margin, (viewportHeight - cardHeight) / 2), left: Math.max(margin, (viewportWidth - cardWidth) / 2) })
        return
      }
      const below = rect.bottom + 16
      const above = rect.top - cardHeight - 16
      const top = below + cardHeight <= viewportHeight - margin ? below : above >= margin ? above : Math.min(viewportHeight - cardHeight - margin, Math.max(margin, below))
      const left = Math.min(viewportWidth - cardWidth - margin, Math.max(margin, rect.left))
      setCardPosition({ top: Math.max(margin, top), left: Math.max(margin, left) })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [rect, step, targetMissing, chapter])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onProgress({ lastStep: step, dismissedAt: new Date().toISOString() }); onClose() } }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, onProgress, step])

  useLayoutEffect(() => { cardRef.current?.focus() }, [chapter, step])

  const advance = () => {
    if (step < steps.length - 1) {
      const next = step + 1
      setStep(next)
      onProgress({ lastStep: next, dismissedAt: undefined })
      return
    }
    onProgress({ lastStep: 0, completedAt: new Date().toISOString(), dismissedAt: undefined })
    onClose()
  }
  const dismiss = () => { onProgress({ lastStep: step, dismissedAt: new Date().toISOString() }); onClose() }

  return <div className="tour-layer" role="presentation">
    <div className="tour-scrim" aria-hidden="true" />
    {rect && <div className="tour-spotlight" style={{ top: rect.top - 8, left: rect.left - 8, width: rect.width + 16, height: rect.height + 16 }} />}
    <section ref={cardRef} tabIndex={-1} className={`tour-card ${cardPosition || targetMissing ? '' : 'is-unpositioned'}`} style={cardPosition ? { top: cardPosition.top, left: cardPosition.left } : undefined} role="dialog" aria-modal="true" aria-labelledby="product-guide-title">
      <div className="getting-started-progress" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }} aria-label={`第 ${step + 1} 步，共 ${steps.length} 步`}>{steps.map((item, index) => <span key={item.id} className={index <= step ? 'active' : ''} />)}</div>
      <div className="tour-card-heading"><span className="tour-step-index">{step + 1}</span><div><span className="eyebrow">{chapterDefinition.title} · {step + 1}/{steps.length}</span><h2 id="product-guide-title">{current.title}</h2></div><button className="icon-button" type="button" onClick={dismiss} aria-label="关闭使用说明"><X size={16} /></button></div>
      <p>{current.detail}</p>
      {targetMissing && <p className="guide-status guide-status-warning">当前状态下没有这个控件。你可以跳过此步，或稍后从使用说明目录重新打开。</p>}
      <div className="command-row guide-tour-actions">
        <button className="ghost-button" type="button" onClick={dismiss}>稍后再说</button>
        {step > 0 && <button className="ghost-button" type="button" onClick={() => { const previous = step - 1; setStep(previous); onProgress({ lastStep: previous }) }}>上一步</button>}
        {chapter === 'initialization' && step === steps.length - 1 && <button className="ghost-button" type="button" onClick={() => { onProgress({ lastStep: 0, completedAt: new Date().toISOString() }); onContinueProviders() }}>继续了解服务商</button>}
        <button className="primary-button" type="button" onClick={advance}>{step < steps.length - 1 ? '下一步' : '完成并开始使用'}</button>
      </div>
    </section>
  </div>
}
