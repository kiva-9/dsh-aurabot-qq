// Conservative safeguards for accidental self-writing notes and claims about
// this request's unfinished jobs. Quoted material/code is never rewritten.
const writingNote = /^(?:轻松接一句就好|这里(?:应该|可以|需要)(?:回复|回答|接话)|(?:回复|回答)时(?:要|应当|应该|需要)|我(?:应该|需要)(?:简短|轻松|自然)地?(?:回复|回答|接话))/u
const imageClaim = /(?:我画得|(?:图|画|漫画).{0,12}(?:画好|画完|发出来了|已经发|已发|完成了)|(?:画好了|画完了|已经画好))/u
const songClaim = /(?:我唱得|(?:歌曲|翻唱|歌|语音).{0,12}(?:唱好|唱完|录好|发出来了|已经发|已发|完成了)|(?:唱好了|唱完了|已经唱好))/u
const protectedText = text => /```|^\s*>|[「『“"]/.test(text)
export function publicReply(text, { jobs = [], userText = '' } = {}) {
  let removedNotes = 0, correctedClaims = 0
  const requestedWriting = /(?:分析|解释|引用|翻译|复述|写作|提示词|回复策略)/u.test(userText)
  const pending = jobs.filter(j => j.state !== 'delivered')
  let code = false
  const lines = String(text || '').split(/\|\|\||\n/).flatMap(line => {
    if (/^\s*```/.test(line)) { code = !code; return [line] }
    if (code) return [line]
    if (!requestedWriting && writingNote.test(line.trim()) && !protectedText(line)) { removedNotes++; return [] }
    if (protectedText(line)) return [line]
    return [line.replace(/[^。！？!?]+[。！？!?]?/gu, sentence => {
      const job = pending.find(j => j.kind === 'song' ? songClaim.test(sentence) : /image|draw/.test(j.kind) && imageClaim.test(sentence))
      if (!job) return sentence
      correctedClaims++
      const label = job.kind === 'song' ? '翻唱' : '图片'
      if (['failed', 'canceled', 'unknown'].includes(job.state)) return `${label}任务尚未确认成功，请以任务状态为准。`
      if (['generated', 'delivery_pending'].includes(job.state)) return `${label}已生成，正在等待发送确认。`
      return `${label}任务已提交，还在处理中，完成后会发送。`
    })]
  })
  return { text: lines.join('\n').trim(), removedNotes, correctedClaims }
}
