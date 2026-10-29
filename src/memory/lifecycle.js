import { createWorkControl } from './background.js'

// Logical cancellation is independent of whether the host model transport can
// physically abort a request. A late answer never continues into domain storage.
export function createLifecycle({getAccount, getBlockReason = () => ''} = {}) {
  return createWorkControl(scope => {
    const current=getAccount?.()
    if(current && String(current)!==scope.account) return 'ACCOUNT_CHANGED'
    return getBlockReason(scope)
  }, 'MEMORY_STOPPED')
}
