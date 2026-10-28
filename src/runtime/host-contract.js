// 宿主契约检查：DSH 给插件的能力在不同版本里可能不一样。启动时探一遍，按结果选实现路径；
// 缺了关键能力就在面板上说清楚，而不是运行到一半才出错。核实过的契约见 DSH 0.2.1-rc.3。

const fn = (o, k) => Boolean(o) && typeof o[k] === 'function'

/** 宿主级能力（不需要具体会话）。 */
export function probeHost(ctx) {
  const get = (name) => {
    // Cordis can reject an undeclared property access while explicit get() is supported.
    try { const value=ctx[name];if(value)return value } catch {}
    try { return ctx.get?.(name)||null } catch { return null }
  }
  const controller = get('sessionController')
  const llm = get('llm')
  const stt = get('speechToText')
  const attachments = get('attachments')
  const systemPrompt = get('systemPrompt')
  const checks = [
    { id: 'sessionController', ok: fn(controller, 'create') && fn(controller, 'resolveAgent'), need: true, what: '创建、恢复 QQ 会话' },
    { id: 'controller.cancel', ok: fn(controller, 'cancel'), need: false, what: '按会话停下当前这一轮' },
    { id: 'controller.selectModel', ok: fn(controller, 'selectModel') || fn(controller?.agents, 'selectForNextRequest'), need: false, what: '按聊天切换模型' },
    { id: 'workspaceRegistry', ok: fn(get('workspaceRegistry'), 'list'), need: true, what: '把 QQ 会话放进专用工作区' },
    { id: 'systemPrompt.variable', ok: fn(systemPrompt, 'variable'), need: true, what: '注入人格和规则' },
    { id: 'llm.stream', ok: fn(llm, 'stream'), need: true, what: '后台整理、识图等直接调用模型' },
    { id: 'llm.resolveModelInfo', ok: fn(llm, 'resolveModelInfo'), need: false, what: '查模型的思考强度和上下文长度' },
    { id: 'attachments', ok: fn(attachments, 'admitPromptContent'), need: false, what: '把图片交给模型' },
    { id: 'speechToText', ok: fn(stt, 'transcribe'), need: false, what: '本机语音识别' },
    { id: 'webServer', ok: fn(get('webServer'), 'register'), need: true, what: '面板接口' },
  ]
  return summarize(checks)
}

/** 会话级能力：拿到第一个 agent 时探一次。 */
export function probeAgent(agent) {
  const checks = [
    { id: 'agent.followup', ok: fn(agent, 'followup'), need: true, what: '把消息交给她' },
    { id: 'agent.steer', ok: fn(agent, 'steer'), need: false, what: '她还在想时把新消息插进去' },
    { id: 'agent.inject', ok: fn(agent, 'inject'), need: false, what: '补充上下文但不另起一轮' },
    { id: 'agent.cancel', ok: fn(agent, 'cancel'), need: false, what: '取消正在跑的一轮（换人设、重开时）' },
    { id: 'agent.tools', ok: fn(agent?.ctx?.tools, 'register'), need: true, what: '按会话挂工具' },
    { id: 'agent.systemPrompt.section', ok: fn(agent?.ctx?.systemPrompt, 'section'), need: false, what: '按会话设置人格' },
    { id: 'agent.systemPrompt.context', ok: fn(agent?.ctx?.systemPrompt, 'context'), need: false, what: '按会话注入记忆和上下文' },
  ]
  return summarize(checks)
}

function summarize(checks) {
  const missing = checks.filter((c) => !c.ok)
  return {
    ok: !missing.some((c) => c.need),
    caps: Object.fromEntries(checks.map((c) => [c.id, c.ok])),
    missing: missing.map((c) => ({ id: c.id, need: c.need, what: c.what })),
  }
}
