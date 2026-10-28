// 人设分层 → 提示词正文。纯函数。
// 旧版导入的整篇 Markdown 原样输出（不擅自改写用户的设定）；新建的卡按层拼。
// 通用的输出格式、工具规则、失败说法不在这里，在 rulesText（运行边界）里。

const PROACTIVE = {
  low: '你话不多，别人不找你时很少主动开口。',
  normal: '',
  high: '你很爱聊天，会主动接话、开新话题。',
}

/** 聊天用的人设正文。 */
export function compilePersona(layers) {
  if (!layers) return ''
  if (layers.legacy?.body) {
    // 旧卡：原文就是全部设定；新加的分层内容（如果有）补在后面
    const extra = structured(layers, { skipName: true })
    return [layers.legacy.body.trim(), extra].filter(Boolean).join('\n\n')
  }
  return structured(layers)
}

function structured(l, { skipName = false } = {}) {
  const parts = []
  const id = l.identity || {}
  if (!skipName && (id.name || id.core)) {
    parts.push(['【你是谁】', id.name ? `你是「${id.name}」。` : '', id.callOwner ? `你管主人叫「${id.callOwner}」。` : '', id.core].filter(Boolean).join('\n'))
  } else if (skipName && id.callOwner) {
    parts.push(`你管主人叫「${id.callOwner}」。`)
  }
  if (l.appearance?.text) parts.push(`【你的样子】\n${l.appearance.text}`)
  const be = l.behavior || {}
  const beText = [PROACTIVE[be.proactivity] || '', be.text].filter(Boolean).join('\n')
  if (beText) parts.push(`【平时怎么做】\n${beText}`)
  const st = l.style || {}
  const stParts = [st.text]
  if (st.examples?.length) stParts.push('说话的样子，比如：\n' + st.examples.map((x) => `- ${x}`).join('\n'))
  if (st.banned?.length) stParts.push('这些话别说：' + st.banned.join('、'))
  const stText = stParts.filter(Boolean).join('\n')
  if (stText) parts.push(`【说话方式】\n${stText}`)
  return parts.join('\n\n')
}

/** 画她自己时用的外观描述（只在画这个角色时注入，别让所有人物都长成她）。 */
export function appearanceOf(layers) {
  return {
    text: layers?.appearance?.text || '',
    referenceAssetIds: layers?.appearance?.referenceAssetIds || [],
  }
}

/** 人设绑定出错时给模型的中性说明（不冒用任何一张卡的身份）。 */
export const PERSONA_ERROR_TEXT = '（人设配置有误，这一轮不扮演任何角色。只用中性、简短的话说明暂时没法正常聊天，请主人到面板「人格」页检查。）'
