import { createHash } from 'node:crypto'

/** A stable transport identity for upload notices, never an invented author. */
export function fileNoticeMessage(event) {
  if (event?.post_type !== 'notice' || !['group_upload', 'private_upload', 'offline_file'].includes(event.notice_type)) return null
  const file = event.file
  const account = String(event.self_id || ''), user = String(event.user_id || '')
  const group = event.notice_type === 'group_upload' ? String(event.group_id || '') : ''
  const id = String(file?.id || file?.file_id || '')
  if (!/^\d+$/.test(account) || !/^\d+$/.test(user) || (event.notice_type === 'group_upload' && !/^\d+$/.test(group)) || !id || !file?.name) return null
  const key = createHash('sha256').update(JSON.stringify([account, group || 'private', user, id])).digest('hex')
  return { ...event, post_type: 'message', message_type: group ? 'group' : 'private',
    message_id: 'upload:' + key, user_id: user, ...(group ? { group_id: group } : {}),
    sender: { ...(event.sender || {}), user_id: user },
    message: [{ type: 'file', data: { ...file, file_id: id, name: String(file.name) } }] }
}
