// Conservative safeguards for accidental self-writing notes and claims about
// this request's unfinished jobs. Quoted material/code is never rewritten.
import { createReplySource, protectedReplyRanges } from './reply.js'
const writingNote = /^(?:轻松接一句就好|这里(?:应该|可以|需要)(?:回复|回答|接话)|(?:回复|回答)时(?:要|应当|应该|需要)|我(?:应该|需要)(?:简短|轻松|自然)地?(?:回复|回答|接话))/u
const imageClaim = /(?:我画得|(?:图|画|漫画).{0,12}(?:画好|画完|发出来了|已经发|已发|完成了)|(?:画好了|画完了|已经画好))/u
const songClaim = /(?:我唱得|(?:歌曲|翻唱|歌|语音).{0,12}(?:唱好|唱完|录好|发出来了|已经发|已发|完成了)|(?:唱好了|唱完了|已经唱好))/u
// A promise to send after completion is not a claim that the work is finished.
// Remove only that future clause for detection; a separate "已经画好了" still counts.
const futureDelivery = /(?:等(?:我|它)?|待)?(?:画|唱|录|生成)(?:好|完)(?:以后|之后|后)?(?:我)?(?:就|再|会|直接|自动|马上|立刻)[^，。！？!?;；]*/gu
const protectedText = text => /```|^\s*>|[「『“"]/.test(text)
export function publicReply(text, { jobs = [], userText = '' } = {}) {
  let removedNotes = 0, correctedClaims = 0
  const requestedWriting = /(?:分析|解释|引用|翻译|复述|写作|提示词|回复策略)/u.test(userText)
  const pending = jobs.filter(j => j.state !== 'delivered')
  const rewrite = raw => {
    const protectedRanges = protectedReplyRanges(raw).filter(r => r.kind !== 'number')
    let offset = 0, seenContent = false, targetRemoved = false
    const rewritten = raw.split(/(\r?\n)/).map(line => {
      const start = offset; offset += line.length
      const firstContent = Boolean(line.trim()) && !seenContent
      if (line.trim()) seenContent = true
      const overlaps = (from, to) => protectedRanges.some(r => r.start < to && r.end > from)
      if (/^\r?\n$/.test(line) || protectedText(line)) return line
      if (!requestedWriting && writingNote.test(line.trim()) && !overlaps(start, offset)) {
        removedNotes++; if (firstContent) targetRemoved = true; return ''
      }
      return line.replace(/[^。！？!?]+[。！？!?]?/gu, (sentence, at) => {
        if (overlaps(start + at, start + at + sentence.length)) return sentence
        const claim = sentence.replace(futureDelivery, '')
        const job = pending.find(j => j.kind === 'song' ? songClaim.test(claim) : /image|draw/.test(j.kind) && imageClaim.test(claim))
        if (!job) return sentence
        correctedClaims++
        const label = job.kind === 'song' ? '翻唱' : '图片'
        if (['failed', 'canceled', 'unknown'].includes(job.state)) return `${label}任务尚未确认成功，请以任务状态为准。`
        if (['generated', 'delivery_pending'].includes(job.state)) return `${label}已生成，正在等待发送确认。`
        return `${label}任务已提交，还在处理中，完成后会发送。`
      })
    }).join('')
    return { raw: rewritten, targetRemoved }
  }
  // Rewrite text blocks only. Retain actual break/media tokens and literal |||
  // inside protected text, instead of flattening every delimiter to a newline.
  const blocks = []
  let quote = null
  for (const block of createReplySource(String(text || '')).blocks) {
    if (block.type === 'quote') { quote = block; continue }
    const result = block.type === 'text' ? rewrite(block.raw) : block
    const raw = result.raw
    if (result.targetRemoved) quote = null
    if (block.type === 'text' && !raw.trim()) {
      // A removed target consumes its reply marker: never attach that marker
      // to the next unrelated message or media item.
      if (block.raw.trim()) quote = null
      continue
    }
    if (block.type !== 'break' && quote) { blocks.push(quote); quote = null }
    blocks.push({ type: block.type, raw })
  }
  while (blocks[0]?.type === 'break') blocks.shift()
  while (blocks.at(-1)?.type === 'break') blocks.pop()
  return { text: blocks.map(block => block.raw).join('').trim(), removedNotes, correctedClaims }
}
