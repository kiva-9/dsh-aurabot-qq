// 生图服务登记：按 profile 的协议找适配器，能力 = 适配器能做的 ∩ 主人声明的。
// 「本地接口」里接的画图脚本也当成一个只会文生图的服务（profile id 固定为 local）。

import { createOpenAIImages } from './openai.js'
import { createGeminiImages } from './gemini.js'
import { createComfyImages } from './comfyui.js'
import { createHttpImages } from './http.js'
import { mergeCapabilities, ProviderError, imageMime, checkRequest } from './common.js'

const FACTORIES = { openai: createOpenAIImages, gemini: createGeminiImages, comfyui: createComfyImages, http: createHttpImages }

export const PROTOCOLS = () => Object.keys(FACTORIES)

/** 本地接口的画图脚本：只会文生图。 */
export function createLocalImages(local, { toImageBuffer }) {
  return {
    protocol: 'local',
    capabilities: () => ({ modes: ['text'], maxInputs: 0, async: false, cancel: false, idempotent: false, sizes: [] }),
    async submit(req) {
      const why = checkRequest(req, { modes: ['text'], maxInputs: 0, sizes: [] })
      if (why) throw new ProviderError('unsupported', why)
      let buf
      try {
        buf = await toImageBuffer(await local.call('image', { prompt: req.prompt, size: req.size }))
      } catch (error) {
        throw new ProviderError('unknown', '本地画图脚本出错：' + error.message, { maybeCharged: false })
      }
      const mime = imageMime(buf)
      if (!mime) throw new ProviderError('invalid', '本地画图脚本返回的不是图片')
      return { status: 'done', outputs: [{ buf, mime }], billing: 'free' }
    },
  }
}

/** 按 profile 建适配器；返回 { adapter, caps }。 */
export function adapterFor(profile, deps = {}) {
  if (profile.protocol === 'local') {
    const adapter = createLocalImages(deps.local, deps)
    return { adapter, caps: adapter.capabilities() }
  }
  const f = FACTORIES[profile.protocol]
  if (!f) throw new ProviderError('unsupported', `不认识的生图协议：${profile.protocol}`)
  const adapter = f(profile, { fetchImpl: deps.fetchImpl || fetch })
  return { adapter, caps: mergeCapabilities(adapter.capabilities(), profile.capabilities || {}) }
}
