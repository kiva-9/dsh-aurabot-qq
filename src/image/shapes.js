const ALIASES = { square: 'square', '方图': 'square', '方形': 'square', portrait: 'portrait', '竖图': 'portrait', '竖屏': 'portrait', landscape: 'landscape', '横图': 'landscape', '横屏': 'landscape' }
const DEFAULTS = { square: '1024x1024', portrait: '768x1024', landscape: '1024x768' }
export function resolveShape(shape, explicitSize, sizes = []) {
  const kind = ALIASES[String(shape || '').toLowerCase()]
  if (!kind) throw new Error('画幅应为 square / portrait / landscape 或方图 / 竖图 / 横图')
  const matches = size => {
    const m = /^(\d+)x(\d+)$/.exec(size || '')
    return m && (kind === 'square' ? +m[1] === +m[2] : kind === 'portrait' ? +m[1] < +m[2] : +m[1] > +m[2])
  }
  if (explicitSize) {
    if (!matches(explicitSize)) throw new Error('指定的尺寸与画幅冲突')
    if (sizes.length && !sizes.includes(explicitSize)) throw new Error('该服务不支持指定尺寸')
    return explicitSize
  }
  const candidates = sizes.filter(matches)
  if (sizes.length && !candidates.length) throw new Error('该服务不支持这个画幅')
  return candidates.includes(DEFAULTS[kind]) ? DEFAULTS[kind] : candidates[0] || DEFAULTS[kind]
}
