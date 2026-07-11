import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupUploadSyntheticMessageId, type GroupUploadNotice } from './group-upload.js'

const notice: GroupUploadNotice = {
  time: 1_788_000_000,
  group_id: 123,
  user_id: 456,
  file: { id: 'file-abc', name: 'report.docx', size: 1024, busid: 7 },
}

test('group upload notice gets a stable non-replyable message id', () => {
  const first = groupUploadSyntheticMessageId(notice)
  assert.equal(first, groupUploadSyntheticMessageId({ ...notice, file: { ...notice.file } }))
  assert.ok(Number.isSafeInteger(first))
  assert.ok(first < 0)
  assert.notEqual(first, groupUploadSyntheticMessageId({
    ...notice,
    file: { ...notice.file, id: 'file-other' },
  }))
})
