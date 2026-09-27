import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseWorldSeedEvents, resolveWorldSeederRuntime, summaryJaccard,
  validateSeedEvent, worldSeederSystemPrompt, type SeedValidationInput, type WorldSeedEventDraft,
} from '../src/world-seeder'

const NOW = new Date('2026-09-26T10:00:00+08:00')
const BASE: SeedValidationInput = {
  now: NOW, timezone: 'Asia/Shanghai', maxHorizonHours: 72,
  blockedNames: ['小桃'], recentSummaries: [],
}

function draft(overrides: Partial<WorldSeedEventDraft> = {}): WorldSeedEventDraft {
  return {
    summary: '楼下五金店开始装修，电钻声断断续续。',
    importance: 'low',
    occursAt: new Date('2026-09-26T11:30:00+08:00'),
    subjects: [],
    rationale: '上午在家的质感事件',
    ...overrides,
  }
}

test('runtime resolves from the assignment checkbox: no assigned provider means disabled, clamps applied', () => {
  const off = resolveWorldSeederRuntime(undefined)
  assert.equal(off.enabled, false)
  // 总开关开了但没有勾选“用于世界播种”的连接 → 关闭。
  const unassigned = resolveWorldSeederRuntime({ enabled: true })
  assert.equal(unassigned.enabled, false)
  const disabledProvider = resolveWorldSeederRuntime({ enabled: true }, { enabled: false, model: 'm' } as any)
  assert.equal(disabledProvider.enabled, false)
  const on = resolveWorldSeederRuntime({
    enabled: true,
    cadenceMinutes: 999_999, dailyCap: 99, temperature: 9,
  }, { enabled: true, model: 'seeder-model' } as any)
  assert.equal(on.enabled, true)
  assert.equal(on.provider?.model, 'seeder-model')
  assert.equal(on.cadenceMinutes, 1_440)
  assert.equal(on.dailyCap, 20)
  assert.equal(on.temperature, 2)
})

test('parseWorldSeedEvents trims defensively and drops malformed entries', () => {
  const parsed = parseWorldSeedEvents({
    events: [
      { summary: '  快递到了，放在驿站。 ', importance: 'medium', occursAt: '2026-09-26T12:00:00+08:00', subjects: ['快递员', 42], rationale: 'x'.repeat(500) },
      { summary: '', importance: 'low', occursAt: '2026-09-26T12:00:00+08:00' },
      { summary: '坏时间', importance: 'low', occursAt: 'not-a-date' },
      { summary: '坏档', importance: 'huge', occursAt: '2026-09-26T12:00:00+08:00' },
      'junk',
    ],
  })
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]!.summary, '快递到了，放在驿站。')
  assert.deepEqual(parsed[0]!.subjects, ['快递员'])
  assert.equal(parsed[0]!.rationale.length, 200)
  assert.deepEqual(parseWorldSeedEvents({}), [])
  assert.deepEqual(parseWorldSeedEvents('junk'), [])
})

test('validation gates reject each documented failure mode', () => {
  assert.equal(validateSeedEvent(draft(), BASE), undefined, 'clean draft passes')
  assert.equal(validateSeedEvent(draft({ summary: '' }), BASE), 'empty-summary')
  assert.equal(validateSeedEvent(draft({ importance: 'huge' as never }), BASE), 'invalid-importance')
  assert.equal(validateSeedEvent(draft({ occursAt: new Date('2026-09-26T09:00:00+08:00') }), BASE), 'invalid-time', 'past')
  assert.equal(validateSeedEvent(draft({ occursAt: new Date('2026-10-20T09:00:00+08:00') }), BASE), 'invalid-time', 'beyond horizon')
  assert.equal(validateSeedEvent(draft({ summary: '小桃在楼下和她打招呼。' }), BASE), 'blocked-name', 'summary mention')
  assert.equal(validateSeedEvent(draft({ subjects: ['小桃'] }), BASE), 'blocked-name', 'subject mention')
  assert.equal(validateSeedEvent(draft({ importance: 'high', occursAt: new Date('2026-09-27T02:00:00+08:00') }), BASE), 'night-high')
  assert.equal(validateSeedEvent(draft(), { ...BASE, recentSummaries: ['楼下五金店开始装修，电钻声断断续续响着。'] }), 'duplicate')
})

test('high importance is allowed during waking hours and duplicates below threshold pass', () => {
  assert.equal(validateSeedEvent(draft({ importance: 'high', occursAt: new Date('2026-09-26T14:00:00+08:00') }), BASE), undefined)
  assert.equal(validateSeedEvent(draft(), { ...BASE, recentSummaries: ['完全无关的另一件事。'] }), undefined)
})

test('summaryJaccard separates near-duplicates from unrelated text', () => {
  assert.ok(summaryJaccard('楼下五金店开始装修，电钻声断断续续。', '楼下五金店开始装修，电钻声阵阵。') > 0.6)
  assert.ok(summaryJaccard('楼下五金店开始装修。', '她在集市买了两斤苹果。') < 0.3)
})

test('seeder prompt teaches the critical rules', () => {
  const prompt = worldSeederSystemPrompt()
  assert.match(prompt, /NEVER generate events about BLOCKED NAMES/)
  assert.match(prompt, /Offline channels only/)
  assert.match(prompt, /External facts only/)
  assert.match(prompt, /MOST RUNS MUST RETURN an empty events array/)
  assert.match(prompt, /high is rare/)
})
