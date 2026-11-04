// 人设分层 → 提示词正文。纯函数。
// 旧版导入的整篇 Markdown 原样输出（不擅自改写用户的设定）；新建的卡按层拼。
// 通用的输出格式、工具规则、失败说法不在这里，在 rulesText（运行边界）里。

const PROACTIVE = {
  low: '你话不多，别人不找你时很少主动开口。',
  normal: '',
  high: '你很爱聊天，会主动接话、开新话题。',
}

// 卡里没写对应层时用的默认说话习惯（原先写死在运行规则里，会压过卡自己的风格）。
// 卡写了就完全以卡为准；旧版整篇 Markdown 卡原样输出，不补默认。
export const DEFAULT_BEHAVIOR = '自然接话、表达想法，适当提起有记录的共同话题，不为维持聊天强行反问；别每句都以问题结尾，也别查户口。对方回得很短、很敷衍时，说明在忙，少说两句。有人戳你时可以撒娇、吐槽或者问对方干嘛。'
export const DEFAULT_STYLE = '闲聊以自然纯文本为主，通常一到三句，短答尽量放在一条消息里。'

/** 聊天用的人设正文。 */
export function compilePersona(layers) {
  if (!layers) return ''
  if (layers.legacy?.body) {
    // 旧卡：原文就是全部设定；新加的分层内容（如果有）补在后面
    const extra = structured(layers, { skipName: true, defaults: false })
    return [layers.legacy.body.trim(), extra].filter(Boolean).join('\n\n')
  }
  return structured(layers)
}

function structured(l, { skipName = false, defaults = true } = {}) {
  const parts = []
  const id = l.identity || {}
  if (!skipName && (id.name || id.core)) {
    parts.push(['【你是谁】', id.name ? `你是「${id.name}」。` : '', id.callOwner ? `你管主人叫「${id.callOwner}」。` : '', id.core].filter(Boolean).join('\n'))
  } else if (skipName && id.callOwner) {
    parts.push(`你管主人叫「${id.callOwner}」。`)
  }
  if (l.appearance?.text) parts.push(`【你的样子】\n${l.appearance.text}`)
  const be = l.behavior || {}
  const beText = [PROACTIVE[be.proactivity] || '', be.text || (defaults ? DEFAULT_BEHAVIOR : '')].filter(Boolean).join('\n')
  if (beText) parts.push(`【平时怎么做】\n${beText}`)
  const st = l.style || {}
  const stParts = [st.text || (defaults && !st.examples?.length ? DEFAULT_STYLE : '')]
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
    useDefaultReference: layers?.appearance?.useDefaultReference !== false,
    referenceVariants: layers?.appearance?.referenceVariants || [],
    defaultReferenceAssetId: layers?.appearance?.defaultReferenceAssetId || '',
  }
}

/** 人设绑定出错时给模型的中性说明（不冒用任何一张卡的身份）。 */
export const PERSONA_ERROR_TEXT = '（人设配置有误，这一轮不扮演任何角色。只用中性、简短的话说明暂时没法正常聊天，请主人到面板「人格」页检查。）'
