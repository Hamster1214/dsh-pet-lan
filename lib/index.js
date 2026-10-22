/**
 * dsh-pet-lan host half — LAN co-op for the installed dsh-pet desktop pet.
 *
 * Each DSH process runs one tiny presence service:
 *   - a UDP socket bound to 0.0.0.0:<port> (default 41234, SO_REUSEADDR),
 *   - a presence datagram broadcast to every interface's broadcast address
 *     (plus 255.255.255.255 and 127.0.0.1) every ~1.5 s,
 *   - a peer table with a 6.5 s TTL (a closed DSH disappears from the desktop
 *     within a few seconds),
 *   - unicast "wave" datagrams for poking a peer's pet.
 *
 * Where the local pets come from: the browser half reads dsh-pet's own public
 * config route ('/dsh-pet-7340/config'), flattens the same pet list the pet
 * renders, and POSTs it to '/api/pet-lan/local'. The host never parses the
 * pet's JSONC files and never imports its internals, so a dsh-pet upgrade
 * cannot break the LAN layer.
 *
 * What the LAN sees is this module's sanitized presence payload: pet identity,
 * display names, sizes and corner offsets. Nothing about the session, the
 * model, the filesystem or the account is exposed.
 * @module dsh-pet-lan
 */

import { createSocket } from 'node:dgram'
import { randomUUID } from 'node:crypto'
import { hostname, homedir, networkInterfaces } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Wire version of the UDP datagrams. */
const PROTOCOL = 1

/** Node id shape (a UUID or any short LAN-safe token). */
const NODE_RE = /^[A-Za-z0-9_-]{6,64}$/

/** Pet id shape: the old pet plugin allows arbitrary ids, so stay permissive. */
const PET_ID_RE = /^[A-Za-z0-9_. -]{1,48}$/

/** Asset root (the config entry key) shape: 'main', or a pet pack prefix. */
const ASSET_ROOT_RE = /^[A-Za-z0-9_.-]{1,32}$/

/** Corner whitelist of the pet's position config. */
const CORNERS = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left'])

/** At most this many pets are announced per machine (keeps one datagram < 1400 B). */
const MAX_PETS = 5

/** Presence is broadcast on this cadence. */
const ANNOUNCE_MS = 1500

/** A peer that has been silent this long is dropped. */
const PEER_TTL_MS = 6500

/** Sweep cadence for expired peers. */
const SWEEP_MS = 1000

/** Delay between two waves aimed at the same peer. */
const WAVE_COOLDOWN_MS = 800

/** Datagrams larger than this are ignored outright. */
const MAX_DATAGRAM = 4096

/** Defaults of the persisted LAN config. */
const DEFAULTS = {
  enabled: true,
  room: 'dsh-pet',
  port: 41234,
  nickname: '',
  nodeId: '',
  mode: 'desktop',
}

/** Where remote pets render: desktop windows, browser overlay, or both. */
const MODES = new Set(['desktop', 'browser', 'both'])

/** Resolve $DSH_HOME the same way the rest of the plugin family does. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const value = fromEnv.trim()
    return value.startsWith('~') ? join(homedir(), value.slice(1)) : value
  }
  return join(homedir(), '.dsh')
}

/** Trim a string field to a bounded length (undefined when unusable). */
function text(value, max) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

/** Whole number clamped into [min, max] (fallback otherwise). */
function clampInt(value, fallback, min, max) {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/** Sanitize the persisted per-peer desktop window positions. */
function sanitizePositions(raw) {
  const positions = {}
  if (raw === null || typeof raw !== 'object') return positions
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 160) continue
    if (value === null || typeof value !== 'object') continue
    const x = Number(value.x)
    const y = Number(value.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    positions[key] = { x: Math.round(x), y: Math.round(y) }
  }
  return positions
}

/** Parse a dotted IPv4 into an unsigned 32-bit integer. */
function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number)
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

/** Format an unsigned 32-bit integer as dotted IPv4. */
function intToIpv4(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

/**
 * Every destination a presence datagram should reach: the subnet broadcast of
 * each non-internal IPv4 interface, limited broadcast, and loopback (so a
 * second DSH on the same machine is visible too).
 */
function broadcastTargets() {
  const targets = new Set(['255.255.255.255', '127.0.0.1'])
  let interfaces
  try {
    interfaces = networkInterfaces()
  } catch {
    return [...targets]
  }
  for (const list of Object.values(interfaces)) {
    for (const address of list ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (typeof address.address !== 'string' || typeof address.netmask !== 'string') continue
      try {
        const ip = ipv4ToInt(address.address)
        const mask = ipv4ToInt(address.netmask)
        targets.add(intToIpv4((ip | (~mask >>> 0)) >>> 0))
      } catch {
        // A malformed interface entry never blocks discovery on the others.
      }
    }
  }
  return [...targets]
}

/** Read the JSON body of a POST request (empty body becomes {}). */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        done(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        done({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        done(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        done(null)
      }
    })
    req.on('error', () => done(null))
  })
}

/** Write one JSON response. */
function writeJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Loopback-only fence for the LAN control routes (defense in depth). */
function fromLoopback(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string') return false
  return address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
}

/** Sanitize one pet record reported by the local browser half or a peer. */
function sanitizeLive(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const anim = text(raw.anim, 24)
  const bubble = text(raw.bubble, 24)
  const image = text(raw.image, 24)
  if (anim === undefined && bubble === undefined && image === undefined) return undefined
  return {
    anim: anim ?? '',
    facing: raw.facing === 'right' ? 'right' : 'left',
    bubble: bubble ?? '',
    image: image ?? '',
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
  }
}

/** Sanitize one pet record reported by the local browser half. */
function sanitizePet(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const id = typeof raw.id === 'string' && PET_ID_RE.test(raw.id.trim()) ? raw.id.trim() : undefined
  if (id === undefined) return undefined
  const assetRoot = typeof raw.assetRoot === 'string' && ASSET_ROOT_RE.test(raw.assetRoot)
    ? raw.assetRoot
    : 'main'
  const corner = CORNERS.has(raw.corner) ? raw.corner : 'bottom-right'
  // Live state may arrive nested (local browser report) or flat (peer presence).
  const live = sanitizeLive(
    raw.live !== undefined
      ? raw.live
      : { anim: raw.anim, facing: raw.facing, bubble: raw.bubble, image: raw.image, at: raw.at },
  )
  return {
    id,
    name: text(raw.name, 20) ?? id,
    size: clampInt(raw.size, 160, 32, 1024),
    assetRoot,
    corner,
    marginX: clampInt(raw.marginX, 24, -2000, 10000),
    marginY: clampInt(raw.marginY, 0, -2000, 10000),
    ...(live === undefined ? {} : { live }),
  }
}

/** Root directory of this package (lib/index.js -> package root). */
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * Build the LAN service for one DSH process.
 */
function createPetLan() {
  const configPath = join(dshHome(), 'dsh-pet-lan.json')
  const statusPath = join(dshHome(), 'dsh-pet-lan.status.json')
  const desktopStatePath = join(dshHome(), 'dsh-pet-lan.desktop.json')
  const desktopMovesPath = join(dshHome(), 'dsh-pet-lan.desktop-moves.jsonl')

  let config = { ...DEFAULTS, positions: {} }
  let socket
  let announceTimer
  let sweepTimer
  let retryTimer
  let disposed = false
  let announcing = false
  let peers = new Map()
  let localPets = []
  let localPetsAt = 0
  /** Live state reported by the pet's desktop helper, keyed by pet id. */
  let desktopLive = {}
  /** Electron helper that draws remote pets in transparent desktop windows. */
  let helper
  let helperReady = false
  let helperFailures = 0
  let lastHelperPush = 0
  let desktopError = null
  let movesTimer
  let clientViewport = { w: 0, h: 0 }
  let clientPolls = 0
  let clientReports = 0
  let lastWave = { seq: 0, at: 0, fromName: '', fromHost: '', fromNode: '' }
  let lastWaveOutAt = 0
  const waveInAt = new Map()
  let statusTimer
  let writingStatus = false
  let statusQueued = false

  const stats = {
    sent: 0,
    received: 0,
    lastError: null,
    boundPort: 0,
    startedAt: 0,
  }

  /** Persist the effective config (atomic replace). */
  async function persistConfig() {
    try {
      await mkdir(dshHome(), { recursive: true })
      const tmp = configPath + '.tmp'
      await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
      await rename(tmp, configPath)
    } catch (error) {
      stats.lastError = 'config-write: ' + String(error?.message ?? error)
    }
  }

  /** Load the persisted config, repairing missing/invalid fields. */
  async function loadConfig() {
    let raw = {}
    try {
      const parsed = JSON.parse(await readFile(configPath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') raw = parsed
    } catch {
      // Missing or corrupt file: defaults are the supported first-run state.
    }
    config = {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
      room: text(raw.room, 32) ?? DEFAULTS.room,
      port: clampInt(raw.port, DEFAULTS.port, 1024, 65535),
      nickname: text(raw.nickname, 24) ?? '',
      nodeId: typeof raw.nodeId === 'string' && NODE_RE.test(raw.nodeId) ? raw.nodeId : randomUUID(),
      mode: MODES.has(raw.mode) ? raw.mode : DEFAULTS.mode,
      positions: sanitizePositions(raw.positions),
    }
    // First run (or a hand-edited file without an id): keep the identity stable
    // across restarts so peers do not see a brand-new pet every launch.
    if (raw.nodeId !== config.nodeId) await persistConfig()
  }

  /** Drop peers whose last presence is older than the TTL. */
  function sweep() {
    refreshDesktopLive()
    const now = Date.now()
    for (const [node, peer] of peers) {
      if (now - peer.lastSeen > PEER_TTL_MS) {
        peers.delete(node)
        console.log('[dsh-pet-lan] peer offline: ' + peer.summary + ' (' + peer.ip + ')')
        writeStatusSoon()
      }
    }
  }

  /**
   * Read the live state the dsh-pet desktop helper writes (anim / facing /
   * bubble / meme). Desktop-mode pets never mount in the browser, so the file
   * is the only place their current action is observable.
   */
  function refreshDesktopLive() {
    try {
      const doc = JSON.parse(readFileSync(join(dshHome(), 'dsh-pet', 'desktop-live.json'), 'utf8'))
      const now = Date.now()
      const next = {}
      for (const [id, value] of Object.entries(doc ?? {})) {
        if (value === null || typeof value !== 'object') continue
        const at = Number(value.at) || 0
        if (now - at > 15_000) continue
        const live = sanitizeLive({ ...value, at })
        if (live !== undefined) next[id] = live
      }
      desktopLive = next
    } catch {
      desktopLive = {}
    }
  }

  /** The freshest live state for one local pet (desktop helper wins). */
  function liveFor(pet) {
    const fromDesktop = desktopLive[pet.id]
    const fromBrowser = pet.live
    if (fromDesktop !== undefined && (fromBrowser === undefined || fromDesktop.at >= fromBrowser.at)) {
      return fromDesktop
    }
    return fromBrowser
  }

  /** One pet's wire form, with only the live fields it actually has. */
  function presentPet(pet) {
    const live = liveFor(pet)
    return {
      id: pet.id,
      name: pet.name,
      size: pet.size,
      assetRoot: pet.assetRoot,
      corner: pet.corner,
      marginX: pet.marginX,
      marginY: pet.marginY,
      ...(live === undefined
        ? {}
        : {
            ...(live.anim === '' ? {} : { anim: live.anim }),
            ...(live.bubble === '' ? {} : { bubble: live.bubble }),
            ...(live.image === '' ? {} : { image: live.image }),
            ...(live.facing === 'left' ? {} : { facing: live.facing }),
          }),
    }
  }

  /* ------------------------------------------------------------------ *
   * Desktop overlay: one transparent Electron window per remote pet.
   * ------------------------------------------------------------------ */

  /** The Electron binary the pet's own desktop mode already installed. */
  function electronExecutable() {
    const explicit = process.env.DSH_PET_ELECTRON_PATH
    if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) return explicit
    const relative = process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
        : 'electron'
    const candidate = join(dshHome(), 'electron', relative)
    return existsSync(candidate) ? candidate : undefined
  }

  /** The installed dsh-pet package root (for built-in animation/meme assets). */
  function dshPetRoot() {
    const candidates = [
      process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules', 'dsh-pet') : undefined,
      join(dshHome(), 'profiles', process.env.DSH_PROFILE || 'desktop', 'node_modules', 'dsh-pet'),
      join(process.cwd(), 'node_modules', 'dsh-pet'),
    ]
    for (const candidate of candidates) {
      if (candidate === undefined) continue
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
    return undefined
  }

  /** Resolve one animation file using dsh-pet's own lookup order. */
  function resolveAnimFile(assetRoot, anim) {
    if (typeof anim !== 'string' || anim === '' || /[\\/]/.test(anim) || anim === '.' || anim === '..') return undefined
    const root = dshPetRoot()
    const userMain = join(dshHome(), 'dsh-pet', 'main-animation', 'webm')
    const packageMain = root === undefined ? undefined : join(root, 'assets', 'webm')
    for (const ext of ['webm', 'mov']) {
      const file = anim + '.' + ext
      const candidates = assetRoot === 'main' || assetRoot === undefined
        ? [join(userMain, file), packageMain === undefined ? undefined : join(packageMain, file)]
        : [join(dshHome(), 'dsh-pet', 'pet', assetRoot + '-animation', file)]
      for (const candidate of candidates) {
        if (candidate !== undefined && existsSync(candidate)) return candidate
      }
    }
    return undefined
  }

  /** Resolve one meme image using dsh-pet's own lookup order. */
  function resolveMemeFile(assetRoot, image) {
    if (typeof image !== 'string' || image === '' || /[\\/]/.test(image) || image === '.' || image === '..') return undefined
    const file = image.toLowerCase().endsWith('.png') ? image : image + '.png'
    const root = dshPetRoot()
    const candidates = [
      join(dshHome(), 'dsh-pet', 'pet', String(assetRoot || 'main') + '-memes', file),
      join(dshHome(), 'dsh-pet', 'memes', file),
      root === undefined ? undefined : join(root, 'assets', 'memes', file),
    ]
    for (const candidate of candidates) {
      if (candidate !== undefined && existsSync(candidate)) return candidate
    }
    return undefined
  }

  /** Build the window list for the desktop helper from the current peers. */
  function desktopPets() {
    const pets = []
    for (const peer of peers.values()) {
      for (const pet of peer.pets) {
        const key = peer.node + '/' + pet.id
        const live = liveFor(pet)
        const animFile = live === undefined ? undefined : resolveAnimFile(pet.assetRoot, live.anim)
        const imageFile = live === undefined ? undefined : resolveMemeFile(pet.assetRoot, live.image)
        const position = config.positions[key]
        pets.push({
          key,
          name: pet.name,
          size: pet.size,
          animUrl: animFile === undefined ? null : pathToFileURL(animFile).href,
          imageUrl: imageFile === undefined ? null : pathToFileURL(imageFile).href,
          bubble: live === undefined ? '' : live.bubble,
          facing: live === undefined ? 'left' : live.facing,
          ...(position === undefined ? {} : { x: position.x, y: position.y }),
        })
      }
    }
    return pets
  }

  /** Push the current peer set to the desktop helper. */
  function pushDesktopState(force) {
    if (helper === undefined || config.mode === 'browser') return
    const now = Date.now()
    if (force !== true && now - lastHelperPush < 700) return
    lastHelperPush = now
    try {
      writeFileSync(desktopStatePath, JSON.stringify({ pets: desktopPets() }), 'utf8')
    } catch (error) {
      desktopError = 'state-write: ' + String(error?.message ?? error)
    }
  }

  /** Read the positions the helper's windows reported after a drag. */
  function startMovesPoll() {
    if (movesTimer !== undefined) return
    movesTimer = setInterval(() => {
      try {
        let raw = ''
        try {
          raw = readFileSync(desktopMovesPath, 'utf8')
        } catch {
          return
        }
        if (raw.trim() === '') return
        try {
          writeFileSync(desktopMovesPath, '', 'utf8')
        } catch {
          // A failed truncate only means the same move is read again.
        }
        let changed = false
        for (const line of raw.split('\n')) {
          if (line.trim() === '') continue
          try {
            const message = JSON.parse(line)
            if (message === null || typeof message !== 'object') continue
            const key = typeof message.key === 'string' ? message.key : ''
            const x = Number(message.x)
            const y = Number(message.y)
            if (key === '' || !Number.isFinite(x) || !Number.isFinite(y)) continue
            config.positions[key] = { x: Math.round(x), y: Math.round(y) }
            changed = true
          } catch {
            // skip the malformed line
          }
        }
        if (changed) {
          void persistConfig()
          pushDesktopState(true)
        }
      } catch (error) {
        desktopError = 'moves-poll: ' + String(error?.message ?? error)
      }
    }, 1000)
  }

  /** Handle one JSON line from the helper's stdout. */
  function onHelperLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    if (message.type === 'ready') {
      helperReady = true
      desktopError = null
      helperFailures = 0
      pushDesktopState(true)
      writeStatusSoon()
      return
    }
    if (message.type === 'moved') {
      const key = typeof message.key === 'string' ? message.key : ''
      const x = Number(message.x)
      const y = Number(message.y)
      if (key !== '' && Number.isFinite(x) && Number.isFinite(y)) {
        config.positions[key] = { x: Math.round(x), y: Math.round(y) }
        void persistConfig()
      }
      return
    }
    if (message.type === 'error') {
      desktopError = String(message.message ?? 'helper error').slice(0, 200)
      console.warn('[dsh-pet-lan] desktop helper: ' + desktopError)
    }
  }

  /** Start (or restart) the desktop helper when the mode needs it. */
  function startDesktop() {
    if (disposed || helper !== undefined || config.mode === 'browser') return
    const electron = electronExecutable()
    if (electron === undefined) {
      desktopError = 'electron-not-found'
      writeStatusSoon()
      return
    }
    const main = join(PACKAGE_ROOT, 'runtime', 'desktop-helper', 'main.cjs')
    if (!existsSync(main)) {
      desktopError = 'helper-missing'
      writeStatusSoon()
      return
    }
    let child
    try {
      // Electron's main process cannot read piped stdin on Windows
      // (electron#4218): state travels through a small JSON file instead.
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      env.DSH_PET_LAN_STATE = desktopStatePath
      env.DSH_PET_LAN_MOVES = desktopMovesPath
      env.DSH_PET_LAN_HOST_PID = String(process.pid)
      writeFileSync(desktopStatePath, JSON.stringify({ pets: [] }), 'utf8')
      writeFileSync(desktopMovesPath, '', 'utf8')
      child = spawn(electron, [main], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      })
    } catch (error) {
      desktopError = 'helper-spawn: ' + String(error?.message ?? error)
      writeStatusSoon()
      return
    }
    helper = child
    helperReady = false
    desktopError = null
    child.stdout.setEncoding('utf8')
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      try {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line === '') continue
          try {
            onHelperLine(line)
          } catch (error) {
            desktopError = 'helper-line: ' + String(error?.message ?? error)
          }
        }
      } catch (error) {
        desktopError = 'helper-stdout: ' + String(error?.message ?? error)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text !== '') console.warn('[dsh-pet-lan] desktop helper: ' + text.slice(0, 500))
    })
    child.on('error', (error) => {
      desktopError = 'helper: ' + String(error?.message ?? error)
      helper = undefined
      helperReady = false
    })
    child.on('exit', () => {
      helper = undefined
      helperReady = false
      if (disposed || config.mode === 'browser') return
      helperFailures += 1
      if (helperFailures <= 3) {
        setTimeout(() => {
          if (!disposed && config.mode !== 'browser') startDesktop()
        }, 3000)
      } else {
        desktopError = 'helper-exited'
        writeStatusSoon()
      }
    })
    console.log('[dsh-pet-lan] desktop helper started')
    startMovesPoll()
    writeStatusSoon()
  }

  /** Stop the desktop helper and all of its windows. */
  function stopDesktop() {
    if (movesTimer !== undefined) clearInterval(movesTimer)
    movesTimer = undefined
    const current = helper
    helper = undefined
    helperReady = false
    lastHelperPush = 0
    if (current === undefined) return
    try {
      if (current.stdin !== null) current.stdin.end()
    } catch {
      // already closed
    }
    try {
      current.kill()
    } catch {
      // already gone
    }
    if (process.platform === 'win32' && typeof current.pid === 'number') {
      try {
        spawn('taskkill', ['/pid', String(current.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        // best effort
      }
    }
  }

  /** Apply the current mode to the helper lifecycle. */
  function syncDesktop() {
    if (config.mode === 'browser') stopDesktop()
    else startDesktop()
  }

  /** The names other machines show for this one. */
  function summaryOf(pets) {
    const first = pets[0]
    return first === undefined ? hostname() : first.name
  }

  /** The presence payload this process broadcasts. */
  function presence() {
    return {
      v: PROTOCOL,
      t: 'presence',
      room: config.room,
      node: config.nodeId,
      host: hostname().slice(0, 48),
      port: stats.boundPort || config.port,
      viewport: clientViewport,
      pets: localPets.map(presentPet),
      sentAt: Date.now(),
    }
  }

  /** Serialize one presence packet, shedding optional live fields to fit one datagram. */
  function encodePresence(payload) {
    let body = Buffer.from(JSON.stringify(payload), 'utf8')
    if (body.byteLength <= 1400) return body
    for (const pet of [...payload.pets].reverse()) {
      for (const field of ['bubble', 'image', 'anim', 'facing']) {
        if (pet[field] === undefined) continue
        delete pet[field]
        body = Buffer.from(JSON.stringify(payload), 'utf8')
        if (body.byteLength <= 1400) return body
      }
    }
    while (payload.pets.length > 1 && body.byteLength > 1400) {
      payload.pets.pop()
      body = Buffer.from(JSON.stringify(payload), 'utf8')
    }
    return body.byteLength <= 1400 ? body : undefined
  }

  /** Broadcast one datagram to every LAN destination. */
  function broadcast(payload) {
    if (!socket || stats.boundPort === 0) return
    const body = encodePresence(payload)
    if (body === undefined) {
      stats.lastError = 'presence-too-large (too many pets or long names)'
      return
    }
    for (const target of broadcastTargets()) {
      try {
        socket.send(body, 0, body.byteLength, config.port, target, (error) => {
          if (error) stats.lastError = 'send: ' + String(error.message ?? error)
        })
        stats.sent += 1
      } catch (error) {
        stats.lastError = 'send: ' + String(error?.message ?? error)
      }
    }
  }

  /** Announce once (skipped while disabled, while the socket is down, or before the local report). */
  async function announce() {
    if (disposed || !config.enabled || announcing || localPets.length === 0) return
    announcing = true
    try {
      refreshDesktopLive()
      broadcast(presence())
      pushDesktopState()
    } catch (error) {
      stats.lastError = 'announce: ' + String(error?.message ?? error)
    } finally {
      announcing = false
      writeStatusSoon()
    }
  }

  /** Sanitize one incoming presence datagram into a peer record. */
  function readPresence(message, address) {
    const node = typeof message.node === 'string' && NODE_RE.test(message.node) ? message.node : undefined
    if (node === undefined) return undefined
    const rawPets = Array.isArray(message.pets) ? message.pets : []
    const pets = []
    for (const raw of rawPets.slice(0, MAX_PETS)) {
      const pet = sanitizePet(raw)
      if (pet !== undefined) pets.push(pet)
    }
    if (pets.length === 0) return undefined
    const viewport = message.viewport !== null && typeof message.viewport === 'object' ? message.viewport : {}
    return {
      node,
      host: text(message.host, 48) ?? address.address,
      port: clampInt(message.port, config.port, 1, 65535),
      ip: address.address,
      lastSeen: Date.now(),
      viewport: {
        w: clampInt(viewport.w, 0, 0, 20000),
        h: clampInt(viewport.h, 0, 0, 20000),
      },
      pets,
      summary: summaryOf(pets),
    }
  }

  /** Handle one incoming datagram. */
  function onDatagram(buffer, address) {
    if (buffer.byteLength > MAX_DATAGRAM) return
    let message
    try {
      message = JSON.parse(buffer.toString('utf8'))
    } catch {
      return
    }
    if (message === null || typeof message !== 'object' || message.v !== PROTOCOL) return
    if (message.room !== config.room) return
    if (message.t === 'presence') {
      // Our own broadcast is looped back by the OS: never count or store it.
      if (message.node === config.nodeId) return
      stats.received += 1
      const peer = readPresence(message, address)
      if (peer === undefined) return
      const isNew = !peers.has(peer.node)
      peers.set(peer.node, peer)
      if (isNew) {
        console.log('[dsh-pet-lan] peer online: ' + peer.summary + ' @ ' + peer.host + ' (' + peer.ip + ')')
        writeStatusSoon()
      }
      return
    }
    if (message.t === 'wave') {
      if (message.to !== config.nodeId) return
      stats.received += 1
      const fromNode = typeof message.from === 'string' ? message.from : ''
      const now = Date.now()
      if (fromNode === '' || fromNode === config.nodeId) return
      if (now - (waveInAt.get(fromNode) ?? 0) < WAVE_COOLDOWN_MS) return
      waveInAt.set(fromNode, now)
      lastWave = {
        seq: lastWave.seq + 1,
        at: now,
        fromName: text(message.fromName, 20) ?? '局域网伙伴',
        fromHost: text(message.fromHost, 48) ?? '',
        fromNode,
      }
      console.log('[dsh-pet-lan] wave from ' + lastWave.fromName + ' @ ' + lastWave.fromHost)
      writeStatusSoon()
    }
  }

  /** Report a socket-level failure (bind failures also schedule a retry). */
  function onSocketError(error) {
    stats.lastError = String(error?.message ?? error)
    console.warn('[dsh-pet-lan] UDP error: ' + stats.lastError)
    writeStatusSoon()
    if (disposed || !config.enabled) return
    if (stats.boundPort === 0 && retryTimer === undefined) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        if (!disposed && config.enabled && socket !== undefined) openSocket()
      }, 10_000)
    }
  }

  /** Close the current socket (idempotent). */
  function closeSocket() {
    const current = socket
    socket = undefined
    stats.boundPort = 0
    if (current !== undefined) {
      try {
        current.removeAllListeners()
        current.close()
      } catch {
        // Already closed.
      }
    }
  }

  /** Bind 0.0.0.0:<port> and start receiving. */
  function openSocket() {
    if (disposed || !config.enabled) return
    closeSocket()
    let next
    try {
      next = createSocket({ type: 'udp4', reuseAddr: true })
    } catch (error) {
      stats.lastError = 'socket: ' + String(error?.message ?? error)
      return
    }
    socket = next
    next.on('message', (buffer, address) => onDatagram(buffer, address))
    next.on('error', (error) => onSocketError(error))
    next.bind(config.port, '0.0.0.0', () => {
      if (socket !== next) return
      try {
        next.setBroadcast(true)
      } catch (error) {
        stats.lastError = 'broadcast: ' + String(error?.message ?? error)
      }
      stats.boundPort = config.port
      stats.startedAt = Date.now()
      stats.lastError = null
      console.log('[dsh-pet-lan] listening on udp://0.0.0.0:' + config.port + ' room=' + config.room)
      announce()
      writeStatusSoon()
    })
  }

  /** Write the diagnostic snapshot (throttled, coalesced). */
  function writeStatusSoon() {
    if (disposed || statusTimer !== undefined) return
    statusTimer = setTimeout(() => {
      statusTimer = undefined
      void writeStatus()
    }, 2500)
  }

  /** One diagnostic snapshot: useful in the settings page and in support. */
  async function writeStatus() {
    if (writingStatus) {
      statusQueued = true
      return
    }
    writingStatus = true
    try {
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        enabled: config.enabled,
        room: config.room,
        port: config.port,
        nodeId: config.nodeId,
        mode: config.mode,
        host: hostname(),
        udpReady: socket !== undefined && stats.boundPort > 0,
        boundPort: stats.boundPort,
        lastError: stats.lastError,
        desktopReady: helper !== undefined && helperReady,
        desktopError,
        peerCount: peers.size,
        peers: [...peers.values()]
          .sort((a, b) => b.lastSeen - a.lastSeen)
          .map((peer) => ({
            node: peer.node,
            summary: peer.summary,
            host: peer.host,
            ip: peer.ip,
            lastSeen: peer.lastSeen,
            pets: peer.pets,
          })),
        clientPolls,
        clientReports,
        clientViewport,
        sent: stats.sent,
        received: stats.received,
        lastWaveAt: lastWave.at,
        self: {
          at: localPetsAt,
          viewport: clientViewport,
          pets: localPets.map(presentPet),
        },
      }
      await mkdir(dshHome(), { recursive: true })
      const tmp = statusPath + '.tmp'
      await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      await rename(tmp, statusPath)
    } catch {
      // Diagnostics are best effort; a read-only home must not break the LAN.
    } finally {
      writingStatus = false
      if (statusQueued) {
        statusQueued = false
        writeStatusSoon()
      }
    }
  }

  /** The view served to the browser half. */
  function lanView() {
    return {
      ok: true,
      version: PROTOCOL,
      enabled: config.enabled,
      config: {
        enabled: config.enabled,
        room: config.room,
        port: config.port,
        nickname: config.nickname,
        nodeId: config.nodeId,
        mode: config.mode,
      },
      host: hostname(),
      udpReady: socket !== undefined && stats.boundPort > 0,
      boundPort: stats.boundPort,
      lastError: stats.lastError,
      desktopReady: helper !== undefined && helperReady,
      desktopError,
      self: {
        at: localPetsAt,
        viewport: clientViewport,
        pets: localPets.map(presentPet),
      },
      peers: [...peers.values()]
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .map((peer) => ({
          node: peer.node,
          summary: peer.summary,
          host: peer.host,
          ip: peer.ip,
          lastSeen: peer.lastSeen,
          viewport: peer.viewport,
          pets: peer.pets,
        })),
      lastWave,
      clientPolls,
      clientReports,
      stats: {
        sent: stats.sent,
        received: stats.received,
        since: stats.startedAt,
      },
    }
  }

  /** Apply a config patch from the settings page. */
  async function setConfig(patch) {
    const next = { ...config }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (typeof patch.room === 'string') {
      const room = patch.room.trim().slice(0, 32)
      if (room === '') return { ok: false, error: 'invalid-room' }
      next.room = room
    }
    if (typeof patch.nickname === 'string') next.nickname = patch.nickname.trim().slice(0, 24)
    if (typeof patch.mode === 'string') {
      if (!MODES.has(patch.mode)) return { ok: false, error: 'invalid-mode' }
      next.mode = patch.mode
    }
    if (patch.port !== undefined) {
      if (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535) {
        return { ok: false, error: 'invalid-port' }
      }
      next.port = patch.port
    }
    const portChanged = next.port !== config.port
    const roomChanged = next.room !== config.room
    const wasEnabled = config.enabled
    config = next
    if (roomChanged) peers = new Map()
    await persistConfig()
    if (!config.enabled) {
      closeSocket()
    } else if (!wasEnabled || portChanged) {
      openSocket()
    }
    announce()
    syncDesktop()
    writeStatusSoon()
    return { ok: true, config: { ...config } }
  }

  /** Store the local pet report produced by the browser half. */
  function setLocal(body) {
    if (Array.isArray(body.pets)) {
      const pets = []
      for (const raw of body.pets.slice(0, MAX_PETS)) {
        const pet = sanitizePet(raw)
        if (pet !== undefined) pets.push(pet)
      }
      localPets = pets
      localPetsAt = Date.now()
    }
    const viewport = body.viewport !== null && typeof body.viewport === 'object' ? body.viewport : null
    if (viewport !== null) {
      const w = clampInt(viewport.w, 0, 0, 20000)
      const h = clampInt(viewport.h, 0, 0, 20000)
      if (w > 0 && h > 0) clientViewport = { w, h }
    }
    clientReports += 1
    void announce()
    writeStatusSoon()
    return { ok: true, pets: localPets.length }
  }

  /** Send one wave to a peer. */
  function wave(node) {
    const peer = peers.get(node)
    if (peer === undefined) return { ok: false, error: 'unknown-peer' }
    if (socket === undefined || stats.boundPort === 0) return { ok: false, error: 'udp-offline' }
    if (!config.enabled) return { ok: false, error: 'disabled' }
    const now = Date.now()
    if (now - lastWaveOutAt < WAVE_COOLDOWN_MS) return { ok: false, error: 'too-fast' }
    lastWaveOutAt = now
    const payload = {
      v: PROTOCOL,
      t: 'wave',
      room: config.room,
      from: config.nodeId,
      fromName: summaryOf(localPets),
      fromHost: hostname(),
      to: peer.node,
      at: now,
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    try {
      socket.send(body, 0, body.byteLength, peer.port, peer.ip, (error) => {
        if (error) stats.lastError = 'wave: ' + String(error.message ?? error)
      })
      stats.sent += 1
      return { ok: true, to: peer.summary }
    } catch (error) {
      stats.lastError = 'wave: ' + String(error?.message ?? error)
      return { ok: false, error: 'send-failed' }
    }
  }

  /** The route family registered on ctx.webServer. */
  function routes() {
    const guard = (req, res) => {
      if (fromLoopback(req)) return true
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      return false
    }
    const post = (path, run) => ({
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        void readJsonBody(req).then((body) => {
          if (body === null) {
            writeJson(res, 400, { ok: false, error: 'invalid-body' })
            return
          }
          try {
            writeJson(res, 200, run(body))
          } catch (error) {
            writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        })
      },
    })

    return [
      {
        kind: 'exact',
        path: '/api/pet-lan',
        handler: (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'GET') {
            writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          try {
            const url = new URL(req.url ?? '/', 'http://pet-lan.local')
            const w = clampInt(Number(url.searchParams.get('w')), 0, 0, 20000)
            const h = clampInt(Number(url.searchParams.get('h')), 0, 0, 20000)
            if (w > 0 && h > 0) clientViewport = { w, h }
          } catch {
            // A malformed query never blocks the read.
          }
          clientPolls += 1
          writeJson(res, 200, lanView())
        },
      },
      post('/api/pet-lan/local', setLocal),
      post('/api/pet-lan/wave', (body) => wave(typeof body.node === 'string' ? body.node : '')),
      {
        kind: 'exact',
        path: '/api/pet-lan/config',
        handler: (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          void readJsonBody(req).then(async (body) => {
            if (body === null) {
              writeJson(res, 400, { ok: false, error: 'invalid-body' })
              return
            }
            try {
              const result = await setConfig(body)
              writeJson(res, result.ok ? 200 : 400, result)
            } catch (error) {
              writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          })
        },
      },
    ]
  }

  /** Start the service (config load, socket, timers). */
  async function start() {
    if (disposed) return
    await loadConfig()
    if (disposed) return
    if (config.enabled) openSocket()
    syncDesktop()
    announceTimer = setInterval(() => {
      void announce()
    }, ANNOUNCE_MS)
    sweepTimer = setInterval(() => {
      sweep()
      writeStatusSoon()
    }, SWEEP_MS)
    writeStatusSoon()
  }

  /** Release the socket and every timer. */
  function dispose() {
    if (disposed) return
    disposed = true
    if (announceTimer !== undefined) clearInterval(announceTimer)
    if (sweepTimer !== undefined) clearInterval(sweepTimer)
    if (statusTimer !== undefined) clearTimeout(statusTimer)
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    announceTimer = undefined
    sweepTimer = undefined
    statusTimer = undefined
    retryTimer = undefined
    closeSocket()
    stopDesktop()
    peers = new Map()
  }

  return { start, dispose, routes }
}

/** Stable cordis plugin name (matches the bundle patch row). */
export const name = 'dsh-pet-lan'

/** Services required before the LAN routes can mount. */
export const inject = ['webServer']

/**
 * Mount the LAN presence service and its JSON routes.
 * @param ctx - host context.
 */
export function apply(ctx) {
  const lan = createPetLan()
  ctx.effect(() => {
    void lan.start()
    return () => lan.dispose()
  }, 'dsh-pet-lan: presence service')

  ctx.effect(() => {
    const disposers = lan.routes().map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-pet-lan: routes')
}
