'use strict'
const net = require('node:net')
const fs = require('node:fs')
const { channel } = require('./json-channel.cjs')
const { bridgeFile } = require('./native-bridge.cjs')

/** Real-time local transport. Descriptor files are used only for discovery. */
function createLocalPetLink({ file = bridgeFile(), enabled, onStatus = () => {} }) {
  let socket = null, send = null, connecting = false, ready = false, active = false, receivedAt = 0
  let latest = { bodies: [], scale: 1 }, sequence = 0, closed = false
  const pending = new Map()
  let statusKey = ''
  const status = () => {
    const next = { connected: ready, active: active && enabled(), nativeVersion: ready ? '0.3.8' : null }
    const key = JSON.stringify(next)
    if (key !== statusKey) { statusKey = key; onStatus(next) }
  }
  const reset = () => {
    ready = false; active = false; latest = { bodies: [], scale: 1 }; receivedAt = 0; send = null; connecting = false
    for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(false) }
    pending.clear(); status()
  }
  function connect() {
    if (closed || connecting || socket) return
    let descriptor
    try { descriptor = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { status(); return }
    if (descriptor.protocol !== 1 || !Number.isInteger(descriptor.port) || typeof descriptor.token !== 'string') return
    connecting = true
    const current = net.createConnection({ host: '127.0.0.1', port: descriptor.port })
    socket = current
    send = channel(current, message => {
      if (message.type === 'hello' && message.protocol === 1 && message.nativeVersion === '0.3.8') {
        ready = true; connecting = false; receivedAt = Date.now()
        send({ type: 'lease', enabled: enabled() }); status()
      } else if (message.type === 'snapshot' && ready) {
        receivedAt = Date.now(); latest = message; active = message.active === true; status()
      } else if (message.type === 'ack') {
        const item = pending.get(message.seq)
        if (item) { pending.delete(message.seq); clearTimeout(item.timer); item.resolve(message.accepted === true && active && enabled()) }
      }
    })
    current.on('connect', () => send?.({ type: 'hello', protocol: 1, token: descriptor.token }))
    current.on('error', () => {})
    current.on('close', () => { if (socket === current) { socket = null; reset() } })
    current.setTimeout(1500, () => current.destroy())
  }
  const heartbeat = setInterval(() => {
    if (!socket) connect()
    if (ready) {
      if (Date.now() - receivedAt > 250) { socket?.destroy(); return }
      send?.({ type: 'lease', enabled: enabled() }); status()
    }
  }, 100)
  heartbeat.unref?.()
  connect()
  return {
    get active() { return ready && active && enabled() && Date.now() - receivedAt < 150 },
    get scale() { return Number.isFinite(latest.scale) ? latest.scale : 1 },
    bodies() { return this.active && Array.isArray(latest.bodies) ? latest.bodies : [] },
    impulse(hits) {
      if (!this.active) return Promise.resolve(false)
      const seq = ++sequence
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(seq); resolve(false) }, 150)
        pending.set(seq, { resolve, timer })
        if (!send?.({ type: 'impulse', seq, hits })) { pending.delete(seq); clearTimeout(timer); resolve(false) }
      })
    },
    close() { closed = true; clearInterval(heartbeat); send?.({ type: 'lease', enabled: false }); socket?.destroy(); reset() },
  }
}
module.exports = { createLocalPetLink }
