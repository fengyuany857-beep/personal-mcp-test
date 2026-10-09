#!/usr/bin/env node
'use strict'
// HDSI R1 real dependency smoke test. This file is executed inside the isolated
// upstream HDSI checkout, and deliberately does NOT claim Koishi E2E coverage.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const requireHdsi = createRequire(path.join(process.cwd(), 'package.json'))
const { createMachine, createActor } = requireHdsi('xstate')
const { Engine } = requireHdsi('json-rules-engine')
const checks = []
function verify(name, callback) {
  callback()
  checks.push({ check: name, result: 'PASS' })
}
const machine = createMachine({
  id: 'hdsi-r1-attention-smoke',
  initial: 'idle',
  states: {
    idle: { on: { ARRIVED: 'unseen' } },
    unseen: { on: { OBSERVE: { target: 'observed', guard: ({ event }) => event.allowed === true } } },
    observed: { on: { BUFFER: 'responding' } },
    responding: { on: { FINISH: 'idle' } }
  }
})
const actor = createActor(machine).start()
verify('starts idle', () => assert.equal(actor.getSnapshot().value, 'idle'))
actor.send({ type: 'ARRIVED' })
verify('arrived is unseen', () => assert.equal(actor.getSnapshot().value, 'unseen'))
actor.send({ type: 'BUFFER' })
verify('unseen cannot buffer', () => assert.equal(actor.getSnapshot().value, 'unseen'))
actor.send({ type: 'OBSERVE', allowed: false })
verify('denied observation leaves unread', () => assert.equal(actor.getSnapshot().value, 'unseen'))
const persisted = actor.getPersistedSnapshot()
actor.stop()
const recovered = createActor(machine, { snapshot: persisted }).start()
verify('restored unread is still unseen', () => assert.equal(recovered.getSnapshot().value, 'unseen'))
recovered.send({ type: 'OBSERVE', allowed: true })
verify('observed transition occurs', () => assert.equal(recovered.getSnapshot().value, 'observed'))
recovered.send({ type: 'BUFFER' })
verify('buffer after observation', () => assert.equal(recovered.getSnapshot().value, 'responding'))
recovered.send({ type: 'FINISH' })
verify('finished returns idle', () => assert.equal(recovered.getSnapshot().value, 'idle'))
recovered.stop()
async function main() {
  const engine = new Engine()
  engine.addRule({
    conditions: { all: [
      { fact: 'awake', operator: 'equal', value: true },
      { fact: 'deviceAccess', operator: 'equal', value: true }
    ] },
    event: { type: 'ALLOW_PRIVATE_REPLY' }
  })
  const allow = await engine.run({ awake: true, deviceAccess: true })
  verify('rules allow valid action', () => assert.equal(allow.events.length, 1))
  const asleep = await engine.run({ awake: false, deviceAccess: true })
  verify('rules block asleep character', () => assert.equal(asleep.events.length, 0))
  const noDevice = await engine.run({ awake: true, deviceAccess: false })
  verify('rules block device unavailable', () => assert.equal(noDevice.events.length, 0))
  let unknownAllowed = false
  try {
    const unknown = await engine.run({ awake: true })
    unknownAllowed = unknown.events.length > 0
  } catch (_) { unknownAllowed = false }
  verify('rules fail closed on missing facts', () => assert.equal(unknownAllowed, false))
  const result = {
    tier: 'REAL_NPM_MODULE_SMOKE_ONLY',
    verified: checks.length,
    passed: checks.filter(x => x.result === 'PASS').length,
    checks,
    limitations: ['NOT integrated in HDSI service.ts', 'NOT Koishi E2E', 'NOT production acceptance']
  }
  fs.writeFileSync('hdsi-r1-real-smoke-report.json', JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}
main().catch(err => { console.error(err); process.exitCode = 1 })
