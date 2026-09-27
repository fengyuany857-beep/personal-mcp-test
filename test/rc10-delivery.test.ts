import assert from 'node:assert/strict'
import test from 'node:test'
import { h } from 'koishi'
import { readFileSync } from 'node:fs'
import { InterludeService } from '../src/service'

const methods = InterludeService.prototype as any

test('cross-group partial delivery records only accepted segments and preserves event identity', async () => {
  const updates: any[] = [], entries: any[] = []
  const host = {
    config: { onebot: { groupChats: [{ groupId: '12345', enabled: true }] } },
    serial: async (_id: string, run: () => Promise<void>) => run(),
    sendGroupMessage: async () => ({ complete: false, deliveredSegments: ['first'], segmentOutcomes: [
      { index: 0, content: 'first', status: 'delivered' }, { index: 1, content: 'second', status: 'failed', reason: 'offline' },
    ] }),
    updateScriptDeliveryOutcome: async (...args: any[]) => updates.push(args),
    appendEntry: async (...args: any[]) => entries.push(args), report: () => {},
  }
  await methods.sendCrossGroupMessage.call(host, { id: 's' }, { participantId: 'group:12345', content: 'first<sep/>second', scriptEvent: { eventId: 'e', segmentIndex: 0, scriptEntryId: 7 } })
  assert.deepEqual(updates.map(x => [x[1].eventId, x[1].segmentIndex, x[2]]), [['e', 0, 'delivered'], ['e', 1, 'failed']])
  assert.equal(entries[0][1].kind, 'character-group-message')
  assert.equal(entries[0][1].content, 'first')
  assert.equal(entries[0][1].metadata.partialDelivery, true)
})

test('disabled cross-group target fails ledger without transport or invented speech', async () => {
  let sends = 0, entries = 0
  const statuses: string[] = []
  await methods.sendCrossGroupMessage.call({
    config: { onebot: { groupChats: [] } }, splitOutgoingMessage: () => ['text'],
    serial: async (_id: string, run: () => Promise<void>) => run(),
    sendGroupMessage: async () => { sends++ }, appendEntry: async () => { entries++ },
    updateScriptDeliveryOutcome: async (_id: string, _ref: any, status: string) => { statuses.push(status) }, report: () => {},
  }, { id: 's' }, { participantId: 'group:12345', content: 'text', scriptEvent: { eventId: 'e', segmentIndex: 0 } })
  assert.equal(sends, 0); assert.equal(entries, 0); assert.deepEqual(statuses, ['failed'])
})

test('cross-group queue works without a live session and never looks up a private participant', async () => {
  let groups = 0
  const result = await methods.sendOutgoingMessages.call({
    getParticipant: async () => { throw new Error('group routed as private') },
    sendCrossGroupMessage: async (_story: any, message: any, session: any) => {
      assert.equal(message.participantId, 'group:12345'); assert.equal(session, undefined); groups++
    }, report: () => {},
  }, { id: 's' }, [{ participantId: 'group:12345', content: 'text' }])
  assert.equal(groups, 1); assert.deepEqual(result, [])
})

test('group failure is isolated from a subsequent private reply', async () => {
  const privateTarget = { id: 'p', channelId: 'private:p' }
  let sends = 0
  const delivered = await methods.sendOutgoingMessages.call({
    sendCrossGroupMessage: async () => { throw new Error('group receipt failure') },
    canHandleParticipant: () => true, resolveLiteralQuoteMessageId: async () => undefined,
    config: { logging: {} }, report: () => {}, reportOperation: () => {},
  }, { id: 's' }, [{ participantId: 'group:12345', content: 'group' }, { participantId: 'p', content: 'private' }], privateTarget, { send: async () => { sends++; return ['id'] } })
  assert.equal(sends, 1); assert.equal(delivered.length, 1); assert.equal(delivered[0].content, 'private')
})

test('empty group transport receipt is not recorded as delivery', async () => {
  const outcome = await methods.sendGroupMessage.call({
    ctx: { bots: [] }, splitOutgoingMessage: () => ['text'], report: () => {},
  }, { id: 's' }, '12345', 'text', undefined, { bot: { sendMessage: async () => [] } })
  assert.equal(outcome.complete, false); assert.deepEqual(outcome.deliveredSegments, [])
})

test('history commands render stored segments as literal text', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  for (const command of ['interlude.timeline [limit:number]', 'interlude.script [limit:number]']) {
    const block = source.slice(source.indexOf(`ctx.command('${command}'`)).split('\n  ctx.command(')[0]
    assert.match(block, /return h\.text\(entries\.map/)
  }
  const text = '[history] <at id="12345"/> <img src="file:///not-to-send"/>'
  const parsed = h.parse(h.text(text).toString())
  assert.ok(parsed.every(element => element.type === 'text'))
})
