'use strict'
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomBytes } = require('node:crypto')
const { channel } = require('./json-channel.cjs')

function bridgeFile() {
  return process.env.DSH_PET_LAN_BRIDGE_FILE || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-pet', 'lan-physics-v1.json')
}

/** Runs inside dsh-pet's main process. Ownership is a short renewable lease. */
function createNativeBridge({ file = bridgeFile(), snapshot, apply, onOwner, leaseMs = 1000 }) {
  const token = randomBytes(32).toString('hex')
  const sockets = new Set()
  let owner = null, active = false, lastBeat = 0, closed = false
  const setOwner = value => {
    if (active === value) return
    active = value
    onOwner(value)
  }
  const server = net.createServer(socket => {
    sockets.add(socket)
    let authenticated = false
    const authTimeout = setTimeout(() => { if (!authenticated) socket.destroy() }, 1000)
    authTimeout.unref?.()
    const send = channel(socket, message => {
      if (!message || typeof message !== 'object') return
      if (!authenticated) {
        if (message.type !== 'hello' || message.token !== token || message.protocol !== 1 || owner) return socket.destroy()
        authenticated = true
        clearTimeout(authTimeout)
        owner = socket
        lastBeat = Date.now()
        send({ type: 'hello', protocol: 1, nativeVersion: '0.3.8' })
        return
      }
      if (message.type === 'lease') {
        lastBeat = Date.now()
        setOwner(message.enabled === true)
      } else if (message.type === 'impulse') {
        const valid = active && owner === socket && Array.isArray(message.hits) && message.hits.length > 0 && message.hits.length <= 2
          && new Set(message.hits.map(hit => hit.id)).size === message.hits.length
          && message.hits.every(hit => typeof hit.id === 'string' && [hit.vx, hit.vy].every(v => Number.isFinite(v) && Math.abs(v) <= 100000))
        const accepted = valid && apply(message.hits)
        send({ type: 'ack', seq: message.seq, accepted: !!accepted })
      }
    })
    const tick = setInterval(() => {
      if (!authenticated || socket !== owner) return
      if (Date.now() - lastBeat > leaseMs) { setOwner(false); socket.destroy(); return }
      send({ type: 'snapshot', active, at: Date.now(), ...snapshot() })
    }, 16)
    tick.unref?.()
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      clearInterval(tick); clearTimeout(authTimeout)
      if (owner === socket) { owner = null; setOwner(false) }
    })
  })
  server.on('error', () => setOwner(false))
  server.listen(0, '127.0.0.1', () => {
    if (closed) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ protocol: 1, port: server.address().port, token, pid: process.pid }), { mode: 0o600 })
  })
  return {
    get active() { return active }, server,
    close() {
      closed = true
      setOwner(false)
      for (const socket of sockets) socket.destroy()
      server.close()
      try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file) } catch {}
    },
  }
}
module.exports = { bridgeFile, createNativeBridge }
