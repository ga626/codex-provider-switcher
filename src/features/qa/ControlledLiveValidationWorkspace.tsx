import { ArrowLeft, ClipboardCheck, LockKeyhole, ShieldCheck } from 'lucide-react'

export function ControlledLiveValidationWorkspace({ onReturnToSimulation }: { onReturnToSimulation: () => void }) {
  return <main className="qa-live-validation" aria-labelledby="qa-live-validation-title">
    <section className="qa-live-validation-card">
      <div className="qa-live-validation-mark"><ClipboardCheck size={23} /></div>
      <div className="qa-live-validation-heading">
        <span>开发版 · 单独环境</span>
        <h1 id="qa-live-validation-title">受控真实验证</h1>
        <p>这里不是模拟成功页。它只把真实验证需要的边界和顺序固定下来；在你明确放行前，开发板不会触碰真实 Codex、账号、密钥或稳定安装。</p>
      </div>

      <div className="qa-live-validation-steps" role="list" aria-label="真实验证的前置条件">
        <div role="listitem"><span>01</span><div><strong>锁定目标</strong><small>明确这次只验证哪一个服务商、账号或功能，不把所有配置一次接入。</small></div></div>
        <div role="listitem"><span>02</span><div><strong>建立双重恢复点</strong><small>先备份目标资料，再回读确认备份可用；异常时能手动恢复到原状态。</small></div></div>
        <div role="listitem"><span>03</span><div><strong>逐项执行并留回执</strong><small>每次只做一个真实动作，记录输入边界、结果、影响和恢复结果。</small></div></div>
      </div>

      <div className="qa-live-validation-boundary"><LockKeyhole size={17} /><span>当前状态：尚未选择真实目标，因此没有账号登录、配置写入或外部请求被执行。</span></div>
      <div className="qa-live-validation-actions"><button type="button" className="ghost-button" onClick={onReturnToSimulation}><ArrowLeft size={16} />回到日常模拟</button><p><ShieldCheck size={15} />真实验证将在单独确认后启动</p></div>
    </section>
  </main>
}
