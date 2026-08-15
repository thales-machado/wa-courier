'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { SendQueue } = require('../src/lib/sendQueue')

test('SendQueue runs tasks one at a time, in order', async () => {
  const queue = new SendQueue({ minIntervalMs: 0 })
  const order = []
  let concurrent = 0
  let maxConcurrent = 0

  const tasks = [1, 2, 3].map((n) =>
    queue.enqueue(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 10))
      order.push(n)
      concurrent -= 1
      return n
    })
  )

  assert.deepStrictEqual(await Promise.all(tasks), [1, 2, 3])
  assert.deepStrictEqual(order, [1, 2, 3])
  assert.strictEqual(maxConcurrent, 1)
})

test('SendQueue spaces consecutive tasks by minIntervalMs', async () => {
  const queue = new SendQueue({ minIntervalMs: 60 })
  const times = []

  await Promise.all([
    queue.enqueue(async () => times.push(Date.now())),
    queue.enqueue(async () => times.push(Date.now()))
  ])

  assert.ok(times[1] - times[0] >= 55, `expected >=55ms gap, got ${times[1] - times[0]}`)
})

test('SendQueue rejects the caller but keeps processing when a task throws', async () => {
  const queue = new SendQueue({ minIntervalMs: 0 })

  const failing = queue.enqueue(async () => {
    throw new Error('boom')
  })
  const following = queue.enqueue(async () => 'ok')

  await assert.rejects(failing, /boom/)
  assert.strictEqual(await following, 'ok')
})

test('SendQueue refuses new work past maxPending', async () => {
  const queue = new SendQueue({ minIntervalMs: 5, maxPending: 2 })
  const slow = () => new Promise((r) => setTimeout(r, 30))

  const accepted = [queue.enqueue(slow), queue.enqueue(slow)]
  assert.throws(() => queue.enqueue(slow), /queue_full/)

  await Promise.all(accepted)
  // capacity frees up once the backlog clears
  await queue.enqueue(async () => 'ok')
})

test('SendQueue.drain resolves true once everything finished', async () => {
  const queue = new SendQueue({ minIntervalMs: 0 })
  void queue.enqueue(() => new Promise((r) => setTimeout(r, 20)))

  assert.strictEqual(await queue.drain(1000), true)
  assert.strictEqual(queue.pending, 0)
})

test('SendQueue.drain resolves false when work outlasts the deadline', async () => {
  const queue = new SendQueue({ minIntervalMs: 0 })
  const slow = queue.enqueue(() => new Promise((r) => setTimeout(r, 300)))

  assert.strictEqual(await queue.drain(50), false)
  await slow
})
