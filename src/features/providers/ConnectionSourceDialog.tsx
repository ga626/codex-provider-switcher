import { Building2, ChevronRight, KeyRound, LogIn, X } from 'lucide-react'
import { ModalDialog } from '../../shared/components'

export type NewConnectionKind = 'chatgpt-account' | 'official-api' | 'relay'

const sources: Array<{
  id: NewConnectionKind
  title: string
  description: string
  icon: typeof LogIn
}> = [
  {
    id: 'chatgpt-account',
    title: 'ChatGPT 官方账号',
    description: '用 ChatGPT 账号连接 Codex，不需要填写 API Key。',
    icon: LogIn,
  },
  {
    id: 'official-api',
    title: '厂商官方 API',
    description: '直接使用 DeepSeek、OpenAI、MiMo 等厂商的 API。',
    icon: Building2,
  },
  {
    id: 'relay',
    title: '中转站',
    description: '连接兼容 OpenAI 接口的中转服务或自定义地址。',
    icon: KeyRound,
  },
]

export function ConnectionSourceDialog({ busy, onClose, onSelect }: {
  busy: boolean
  onClose: () => void
  onSelect: (kind: NewConnectionKind) => void
}) {
  return <ModalDialog className="connection-source-dialog" labelledBy="connection-source-title" onClose={onClose}>
    <div className="section-heading-row">
      <div><h2 id="connection-source-title">选择连接方式</h2></div>
      <button className="icon-button" type="button" onClick={onClose} aria-label="关闭新增连接"><X size={16} /></button>
    </div>
    <p className="connection-source-lead">选择后，只会显示这种连接需要填写的内容。</p>
    <div className="connection-source-list">
      {sources.map(({ id, title, description, icon: Icon }) => <button
        key={id}
        className={`connection-source-card ${id === 'chatgpt-account' ? 'recommended' : ''}`}
        type="button"
        disabled={busy}
        onClick={() => onSelect(id)}
        data-dialog-initial-focus={id === 'chatgpt-account' ? true : undefined}
      >
        <span className="connection-source-icon"><Icon size={20} /></span>
        <span className="connection-source-copy"><span><strong>{title}</strong>{id === 'chatgpt-account' && <em>推荐</em>}</span><small>{description}</small></span>
        <ChevronRight className="connection-source-arrow" size={18} />
      </button>)}
    </div>
  </ModalDialog>
}
