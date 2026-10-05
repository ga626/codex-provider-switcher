import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

type Summary = { result: string; runId?: string; sourceRevision?: string; sourceFingerprint?: string; fixtureFingerprint?: string; finishedAt?: string; checks?: Array<{ name: string; result: string }>; skipped?: string[] }
const resultLabel: Record<string, string> = { passed: '通过', failed: '失败', running: '运行中或已中断，请查看记录', 'not-run': '未运行', legacy: '旧回执，无法对应当前代码' }
export function QaEvidencePanel({ scenario, mode, view }: { scenario: string; mode: string; view: string }) {
  const [summary, setSummary] = useState<Summary>({ result: 'not-run' })
  const [message, setMessage] = useState('')
  async function refresh() {
    try {
      if ('__TAURI_INTERNALS__' in window) setSummary(await invoke<Summary>('qa_check_summary'))
      else { const r = await fetch('/__qa/summary'); if (!r.ok || !r.headers.get('content-type')?.includes('json')) throw Error(); setSummary(await r.json()) }
      setMessage('')
    } catch { setMessage('暂时无法读取检查记录；不是检查通过。') }
  }
  useEffect(() => { void refresh() }, [])
  function record() {
    // 白名单信息，不采集DOM、用户输入、网络、路径或账号。
    const info = { kind: 'qa-reproduction/v1', createdAt: new Date().toISOString(), build: __CODEX_BUILD_SHA__, scenario, mode, view,
      viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
      lastCheck: { runId: summary.runId, sourceFingerprint: summary.sourceFingerprint, fixtureFingerprint: summary.fixtureFingerprint, result: summary.result },
      steps: ['请补充：点了什么、预期怎样、实际怎样（不要写密钥或账号）'], automatedPassIsNotUserAcceptance: true }
    const url = URL.createObjectURL(new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = `qa-issue-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url)
    setMessage('已导出复现信息，不包含账号、配置正文或请求内容。')
  }
  return <details className="qa-evidence"><summary>检查记录 · {resultLabel[summary.result] ?? '未知'}</summary>
    <p>这是最近一次记录，不保证对应后来改动；体验是否通过仍由你确认。</p>
    {summary.runId && <small>运行 {summary.runId.slice(0, 8)} · {summary.finishedAt ? new Date(summary.finishedAt).toLocaleString() : '尚未结束'}</small>}
    <ul>{summary.checks?.map(c => <li key={c.name}><span>{c.name}</span><strong>{resultLabel[c.result] ?? c.result}</strong></li>)}</ul>
    {summary.skipped?.map(s => <p key={s}>未运行：{s}</p>)}
    <div className="qa-action-pair"><button type="button" onClick={() => void refresh()}>刷新记录</button><button type="button" onClick={record}>记录这个问题</button></div>
    <p role="status">{message}</p>
  </details>
}
