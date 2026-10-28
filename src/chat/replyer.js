// Replyer：聊天会话（Planner）定下要说什么之后，可选地再用一个模型按人设的说话方式改写措辞。
// 只在面板里给「回复改写」选了模型时才跑。它不碰工具，不加不减事实、动作、承诺；
// 回复里的控制标记（语音、表情、引用、戳一戳、沉默）必须原样保留，对不上就用原文。

import { compilePersona } from '../persona/compiler.js'

const MARKS = /<\/?voice>|<sticker:[^>]+>|<reply:\d+>|<poke>|\[沉默\]/g

/** 回复里的控制标记（按出现顺序）。 */
export const marksOf = (text) => String(text || '').match(MARKS) || []

/** 改写结果能不能用：不能为空、控制标记要和原文一模一样（顺序也一样）、不能长出一大截。 */
export function acceptRewrite(original, rewritten) {
  const out = String(rewritten || '').trim()
  if (!out) return false
  const a = marksOf(original)
  const b = marksOf(out)
  if (a.length !== b.length || a.some((m, i) => m !== b[i])) return false
  if (out.length > Math.max(60, String(original).length * 2)) return false
  return true
}

export const REPLYER_SYSTEM = [
  '你只负责改写一条 QQ 聊天回复的措辞，让它更像下面这个角色会说的话。',
  '- 意思、事实、答应要做的事、做没做成，一律不改：不加新内容，不删内容，不把「做不到」说成「做好了」。',
  '- <voice>…</voice>、<sticker:…>、<reply:数字>、<poke>、[沉默] 这些标记原样保留，位置也不变。',
  '- 一句一行的分行和 ||| 分隔可以按角色习惯调整。',
  '- 只输出改写后的回复本身，不要解释。',
].join('\n')

/**
 * @param {(o: object) => Promise<string>} ask 调模型（askModel 绑好宿主和设置，role 固定为 replyer）
 * @returns {Promise<{text: string, rewritten: boolean, reason?: string}>}
 */
export async function rewriteReply(text, { ask, persona }) {
  if (!String(text || '').trim() || String(text).trim() === '[沉默]') return { text, rewritten: false, reason: '空回复或沉默' }
  const role = persona && !persona.error ? compilePersona(persona.layers) : ''
  try {
    const out = await ask({
      role: 'replyer',
      system: REPLYER_SYSTEM + (role ? `\n\n【角色设定】\n${role}` : ''),
      text: `要改写的回复：\n${text}`,
      maxTokens: 800,
      temperature: 0.5,
    })
    if (!acceptRewrite(text, out)) return { text, rewritten: false, reason: '改写结果没通过检查（标记对不上或太长）' }
    return { text: out.trim(), rewritten: true }
  } catch (error) {
    return { text, rewritten: false, reason: error.message }
  }
}
