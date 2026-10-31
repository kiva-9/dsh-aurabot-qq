/** Artworks are keyed by their originating job AND asset, never by display position. */
export function canUseArtwork(job, { account, chatId, actorId, personaId }) {
  return Boolean(job && job.kind === 'image' && job.state === 'delivered' && job.chatId === chatId && job.actorId === String(actorId) &&
    job.input?.accountId === String(account) && personaId && job.input?.persona?.personaId === personaId && Array.isArray(job.output?.assetIds) && job.output.assetIds.length)
}
export const artworkId = (jobId, assetId) => `${jobId}:${assetId}`

export function artworkList(jobs, scope) {
  return jobs.filter(job => canUseArtwork(job, scope)).flatMap(job => job.output.assetIds.map(assetId => ({
    id: artworkId(job.id, assetId), jobId: job.id, assetId, prompt: Array.from(String(job.input.prompt || '')).slice(0, 120).join(''), createdAt: job.createdAt,
  })))
}

/** Single-image job IDs from the first gallery version remain usable. */
export function resolveArtwork(id, getJob, scope) {
  const value = String(id || ''), colon = value.lastIndexOf(':')
  const job = getJob(colon < 0 ? value : value.slice(0, colon))
  if (!canUseArtwork(job, scope)) return null
  const assetId = colon < 0 ? (job.output.assetIds.length === 1 ? job.output.assetIds[0] : '') : value.slice(colon + 1)
  return assetId && job.output.assetIds.includes(assetId) ? { job, assetId, id: artworkId(job.id, assetId) } : null
}
