// 通用任务控制和 Planner 原语。不接受模型指定 actor/account/chat/force。
import { createPlanner } from '../../runtime/planner.js'
import { defineTool, str } from '../../tools/tools.js'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

export default {
  id: 'tasks',
  name: '任务与等待',
  version: '1.0.0',
  description: '按请求归属查询/取消各类任务；持久等待、停止当前决策和有界唤醒',
  files: ['runtime/planner.js', 'runtime/waits.js'],
  setup(api) {
    const { hub, storage, http } = api.core
    const imagegen = api.lazy?.('imagegen')
    const planner = api.core.planner || createPlanner({
      storage, getConfig: api.config, log: api.log,
      getRunner: (kind) => api.core.getJobRunner?.(kind) || api.core.jobRunners?.get?.(kind) ||
        (kind === 'image' ? imagegen?.runner : null),
      onWake: typeof api.core.wakePlanner === 'function' ? (event, execution) => api.core.wakePlanner(event, execution) : undefined,
    })
    let onControl = api.core.plannerControl

    function context(chat, sessionId, exec) {
      const actor = hub.turnActor(sessionId)
      if (!actor || actor.error || !actor.actorId || !actor.requestId) fail('CONTEXT_REQUIRED', actor?.error || '缺少当前请求者')
      if (hub.chatOfSession?.(sessionId) !== chat.chatId) fail('SCOPE_MISMATCH', '工具会话与聊天不一致')
      const requests = hub.turnRequests?.(sessionId)
      if (!requests?.some((r) => r.id === actor.requestId && String(r.actorId) === String(actor.actorId))) fail('STALE_CONTEXT', '请求不在当前回合')
      const request = storage.requests.get(actor.requestId)
      if (!request) fail('CONTEXT_REQUIRED', '请求记录缺失')
      const first = requests[0].id
      const wakeId = hub.turnWakeId?.(sessionId)
      const account = String(api.config().botQQ || '')
      return {
        account, chatId: chat.chatId, actorId: String(actor.actorId), requestId: request.id,
        epoch: request.epoch, policyRevision: request.policyRevision, turnId: wakeId || first,
        ...(wakeId ? { wakeId } : {}), signal: exec?.signal || exec?.abortSignal,
        assertActive() {
          const current = hub.turnRequests?.(sessionId)
          if (account !== String(api.config().botQQ || '') || hub.chatOfSession?.(sessionId) !== chat.chatId ||
            current?.[0]?.id !== first || !current?.some((r) => r.id === request.id) ||
            hub.turnWakeId?.(sessionId) !== wakeId) fail('STALE_CONTEXT', '工具调用所属回合已改变')
        },
      }
    }
    async function control(action, ctx, result) {
      if (!result.ok || typeof onControl !== 'function') return result
      try {
        await onControl({ action, context: planner.authorize(ctx), ...result })
        return result
      } catch (error) {
        // 持久控制状态已经生效，不能因宿主回调错误重新创建等待或恢复工具执行。
        return { ...result, hostControl: 'failed', controlError: String(error?.message || error).slice(0, 300) }
      }
    }
    const safe = async (fn) => {
      try { return await fn() }
      catch (error) { return { ok: false, code: error.code || (error.name === 'AbortError' ? 'CANCELED' : 'TASK_ERROR'), message: String(error?.message || error).slice(0, 400) } }
    }
    api.tool(({ chat, sessionId, level }) => {
      if (!['group', 'private'].includes(chat.kind) || level === 'chat') return []
      const tool = (name, description, properties, required, execute, stop = false) => {
        const t = defineTool({
          name, description, properties, required,
          execute: (args, exec) => safe(async () => {
            const ctx = context(chat, sessionId, exec)
            // stop 即使预算耗尽仍可结束宿主回合；不会重置预算。
            if (!stop) {
              const admitted = planner.useTool(ctx, { name })
              if (!admitted.ok) return admitted
            } else planner.authorize(ctx)
            return execute(args, ctx)
          }),
        })
        // 宿主统一包装工具预算时据此跳过二次扣减（这四个工具已在内部记账）。
        t.plannerBudgeted = true
        t.output.render = (_args, result) => [{ type: 'text', text: JSON.stringify(result) }]
        return t
      }
      return [
        tool('qq_wait', '登记等待并结束当前决策。必须指明条件和期限：job 等账本终态（unknown 也算，不等于成功）；request 等明确请求补充；media 等该请求附件就绪或失败；time 等指定时长。只会有界唤醒，不能反复调用制造思考循环。',
          {
            condition: { type: 'string', enum: ['job', 'request', 'media', 'time'] },
            job_ids: { type: 'array', items: str('任务 ID'), minItems: 1, maxItems: 8 },
            request_id: str('可选，等待补充/媒体的已有请求 ID；不会改变当前操作者'),
            timeout_ms: { type: 'integer', minimum: 1000, maximum: 86400000, description: '等待上限，毫秒，默认 60000' },
            mode: { type: 'string', enum: ['all', 'any'] },
            result_ready: { type: 'boolean', description: '可选，job 已生成但待发送也可唤醒；不会记成已送达' },
          }, ['condition'], (args, ctx) => control('wait', ctx, planner.wait(ctx, {
            condition: args.condition, jobIds: args.job_ids, requestId: args.request_id,
            timeoutMs: args.timeout_ms, mode: args.mode, resultReady: args.result_ready,
          }))),
        tool('qq_stop', '结束当前决策，不发送普通回复；不会取消后台任务或已登记等待。要取消任务必须另用 qq_cancel_task。',
          { reason: str('简短结构化原因，不填自由推理过程') }, [],
          (args, ctx) => control('stop', ctx, planner.stop(ctx, args.reason)), true),
        tool('qq_tasks', '查询当前聊天、当前账号下有权查看的任务和等待，支持所有已登记任务类型。通常只能看自己的，主人可看当前聊天的其他任务。',
          { task_id: str('可选，明确任务/等待 ID'), kind: str('可选，任务类型，如 image/song/wait'), limit: { type: 'integer', minimum: 1, maximum: 20 } }, [],
          (args, ctx) => {
            if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)) fail('INVALID_LIMIT', '最多查询 20 项')
            const tasks = planner.listTasks(ctx, { id: args.task_id, kind: args.kind, limit: args.limit ?? 10 })
            return { ok: true, tasks, message: tasks.length ? tasks.map((r) => r.id + '：' + (r.stateLabel || r.state)).join('\n') : '没有可查看的任务' }
          }),
        tool('qq_cancel_task', '取消明确的任务或等待。只允许当前请求者自己的任务；主人可管理当前聊天。取消等待不取消它所等待的后台任务。',
          { task_id: str('任务或等待 ID，先用 qq_tasks 查询；不要猜测') }, ['task_id'],
          (args, ctx) => {
            if (typeof args.task_id !== 'string' || !args.task_id.trim()) fail('INVALID_ID', '必须指定任务 ID')
            return planner.cancelTask(ctx, args.task_id)
          }),
      ]
    })
    // 复用宿主的面板鉴权；模型工具不能进入这两个 owner 管理入口。
    api.route('/tasks/list', (req) => safe(() => {
      if (req.method !== 'GET') fail('METHOD_NOT_ALLOWED', '此接口只接受 GET')
      const q = http.query(req) || {}
      return { ok: true, list: planner.panelList({
        chatId: String(q.chatId || ''), id: q.id ? String(q.id) : undefined,
        kind: q.kind ? String(q.kind) : undefined, limit: q.limit === undefined ? 20 : Number(q.limit),
      }) }
    }))
    api.route('/tasks/cancel', (req) => safe(async () => {
      if (req.method !== 'POST') fail('METHOD_NOT_ALLOWED', '此接口只接受 POST')
      const b = await http.body(req) || {}
      if (typeof b.id !== 'string' || !b.id.trim()) fail('INVALID_ID', '必须指定任务或等待 ID')
      return planner.panelCancel({ chatId: String(b.chatId || ''), id: b.id })
    }))
    planner.recover()
    api.every?.(1000, () => planner.tick(), 'Planner 等待唤醒')
    api.on?.('job/changed', (event) => planner.signal({ ...event, type: 'job' }))
    api.on?.('request/changed', (event) => planner.signal({ ...event, type: 'request' }))
    api.on?.('media/settled', (event) => planner.signal({ ...event, type: 'media' }))
    api.onDispose?.(() => planner.dispose())
    return {
      planner, ...planner, context,
      setOnControl: (fn) => { if (fn !== undefined && typeof fn !== 'function') fail('INVALID_CONTROL', '控制接收器必须是函数'); onControl = fn },
    }
  },
}
