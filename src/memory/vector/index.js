import { LocalVectorIndex } from './local.js'
import { fail } from '../embedding/space.js'

export { LocalVectorIndex } from './local.js'
export { pointId } from './contract.js'
export { VectorError } from '../embedding/space.js'

export async function createVectorIndex(options) {
  let index
  if (!options || !['local', 'qdrant'].includes(options.backend ?? 'local')) fail('UNKNOWN_BACKEND', 'backend must be local or qdrant')
  if (options.backend === 'qdrant') {
    const { QdrantVectorIndex } = await import('./qdrant.js')
    index = new QdrantVectorIndex(options)
  } else index = new LocalVectorIndex({ ...options, backend: 'local' })
  try {
    await index.ready
    for (const space of options.spaces ?? []) await index.registerSpace(space)
    return index
  } catch (error) { await index.close().catch(() => {}); throw error }
}
