'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const S = require('../runtime/shared/pet-core.cjs')
const { CollisionWorld } = require('../runtime/shared/collision-world.cjs')
const { spaceFor, advance } = require('../runtime/shared/motion.cjs')
const { channel } = require('../runtime/shared/json-channel.cjs')

const body = (overrides = {}) => ({
  id: 'a',
  x: 0,
  y: 0,
  size: 100,
  bottomPad: 0,
  vx: 0,
  vy: 0,
  flying: false,
  busy: false,
  ...overrides,
})

const display = {
  workArea: { x: 10, y: 20, width: 1000, height: 800 },
  bounds: { x: 0, y: 0, width: 1020, height: 900 },
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
    this.writableLength = 0
    this.output = []
  }

  setEncoding() {}

  setNoDelay() {}

  destroy() {
    this.destroyed = true
  }

  write(chunk) {
    this.output.push(chunk)
    return true
  }
}

test('bodyPixelBox uses the dsh-pet HIT_BOX horizontal bounds', () => {
  const box = S.bodyPixelBox(body())
  assert.equal(box.left, 200 / 640 * 100)
  assert.equal(box.right, 440 / 640 * 100)
})

test('bodyPixelBox includes bottomPad and the 360px stage height', () => {
  const box = S.bodyPixelBox(body({ bottomPad: 10 }))
  assert.equal(box.top, 10 + 50 / 360 * (100 * 9 / 16))
  assert.equal(box.bottom, 10 + 335 / 360 * (100 * 9 / 16))
})

test('rectsOverlap detects intersecting rectangles', () => {
  assert.equal(S.rectsOverlap(
    { left: 0, top: 0, right: 20, bottom: 20 },
    { left: 10, top: 10, right: 30, bottom: 30 },
  ), true)
})

test('rectsOverlap rejects edge and non-overlapping rectangles', () => {
  assert.equal(S.rectsOverlap(
    { left: 0, top: 0, right: 20, bottom: 20 },
    { left: 20, top: 0, right: 40, bottom: 20 },
  ), false)
})

test('collidePet exchanges momentum only while approaching', () => {
  const hit = S.collidePet(
    body({ id: 'fly', x: 0, vx: 100, flying: true }),
    body({ id: 'hit', x: 20, vx: -100, flying: true }),
  )
  assert.notEqual(hit, null)
  assert.ok(hit.fvx < 100)
  assert.ok(hit.hvx > -100)
})

test('collidePet ignores pets already moving apart', () => {
  const hit = S.collidePet(
    body({ id: 'fly', x: 0, vx: -100, flying: true }),
    body({ id: 'hit', x: 20, vx: 100, flying: true }),
  )
  assert.equal(hit, null)
})

test('CollisionWorld does not commit static overlap', async () => {
  const world = new CollisionWorld()
  let commits = 0
  world.step(
    [body({ id: 'a' }), body({ id: 'b', x: 20 })],
    async () => {
      commits += 1
      return true
    },
  )
  await flush()
  assert.equal(commits, 0)
})

test('CollisionWorld commits a closing pair once', async () => {
  const world = new CollisionWorld()
  let commits = 0
  const commit = async () => {
    commits += 1
    return true
  }
  const bodies = [
    body({ id: 'a', x: 0, vx: 100, flying: true }),
    body({ id: 'b', x: 20, vx: -100, flying: true }),
  ]
  world.step(bodies, commit)
  await flush()
  world.step(bodies, commit)
  await flush()
  assert.equal(commits, 1)
})

test('CollisionWorld accepts a new contact after separation', async () => {
  const world = new CollisionWorld()
  let commits = 0
  const commit = async () => {
    commits += 1
    return true
  }
  const a = body({ id: 'a', x: 0, vx: 100, flying: true })
  const b = body({ id: 'b', x: 20, vx: -100, flying: true })
  world.step([a, b], commit)
  await flush()
  b.x = 200
  world.step([a, b], commit)
  await flush()
  b.x = 20
  world.step([a, b], commit)
  await flush()
  assert.equal(commits, 2)
})

test('spaceFor works in screen coordinates and respects sideAllow', () => {
  const space = spaceFor(100, [display])
  assert.equal(space.areas[0].x, 10)
  assert.equal(space.areas[0].y, 20)
  assert.equal(space.bounds[0].maxX, 10 + 1000 - 100 + 100 * 200 / 640)
  assert.equal(space.bounds[0].maxY, 20 + 800 - 100 * 9 / 16)
})

test('advance applies gravity to a free body', () => {
  const result = advance(
    { x: 100, y: 100, vx: 0, vy: 0, grounded: false },
    100,
    [display],
    { gravity: 1400, restitution: 0.78, groundFriction: 2.5, ceilingBounce: true, throwPower: 1 },
    0.016,
  )
  assert.ok(result.y > 100)
  assert.ok(Number.isFinite(result.x))
  assert.ok(Number.isFinite(result.vx))
})

test('json-channel parses newline-delimited messages and writes JSON', () => {
  const socket = new FakeSocket()
  const received = []
  const send = channel(socket, (message) => received.push(message))
  socket.emit('data', '{"a":1}\n{"b":2}\n')
  assert.deepEqual(received, [{ a: 1 }, { b: 2 }])
  assert.equal(send({ type: 'x' }), true)
  assert.equal(socket.output[0], '{"type":"x"}\n')
})

test('json-channel destroys a socket on oversized input', () => {
  const socket = new FakeSocket()
  channel(socket, () => {})
  socket.emit('data', 'x'.repeat(256 * 1024 + 1))
  assert.equal(socket.destroyed, true)
})

test('json-channel destroys a socket on malformed JSON', () => {
  const socket = new FakeSocket()
  channel(socket, () => {})
  socket.emit('data', '{not-json}\n')
  assert.equal(socket.destroyed, true)
})

