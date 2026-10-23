/**
 * dsh-pet-lan desktop helper — Electron main process.
 *
 * One small transparent always-on-top window per remote pet. The window is
 * click-through except over the pet body; pointer events over the body drag
 * the window, and the final position is reported to the Host (which persists
 * it per peer/pet).
 *
 * The Host feeds the window list over stdin as JSON lines:
 *   {"type":"pets","pets":[{key,name,size,animUrl,imageUrl,bubble,facing,x?,y?}]}
 * and receives:
 *   {"type":"ready"} | {"type":"moved","key","x","y"} | {"type":"error","message"}
 *
 * This process is started by lib/index.js with the Electron binary that the
 * dsh-pet desktop mode already installs under $DSH_HOME/electron.
 */

'use strict'

const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

app.disableHardwareAcceleration()
app.setName('dsh-pet-lan-helper')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const MARGIN_SIDE = 28
const MARGIN_TOP = 210
const MARGIN_BOTTOM = 0
const MIN_SIZE = 80
const MAX_SIZE = 320

/** dsh-pet's body hit box in the 640x360 animation stage. */
const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 }
const STAGE_W = 640
const STAGE_H = 360
/** Transparent strip below the feet in the WebM; dsh-pet puts this below the floor. */
const FEET_PAD_RATIO = (STAGE_H - 330) / STAGE_H

/** Throw physics: defaults mirror dsh-pet, overridden by the local config. */
const DEFAULT_PHYSICS = {
  gravity: 1400,
  restitution: 0.78,
  groundFriction: 2.5,
  ceilingBounce: true,
  throwPower: 1,
}
const PET_BOUNCE_E = 0.995
const REST_VY = 40
const REST_VX = 15

/** key -> { win, size, height, pet, ignoring, drag, physics? } */
const windows = new Map()

let physics = { ...DEFAULT_PHYSICS }
let petCollision = true
/** Local dsh-pet bodies (absolute screen px) reported by the Host /pose poll. */
let localBodies = []
const localHitAt = new Map()

process.on('uncaughtException', (error) => {
  write({ type: 'error', message: String(error && error.message ? error.message : error) })
})

function write(message) {
  try {
    process.stdout.write(JSON.stringify(message) + '\n')
  } catch {
    // Host gone: nothing useful can happen anymore.
    app.quit()
  }
}

function clampSize(value) {
  const size = Number(value)
  return Number.isFinite(size) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size))) : 160
}

function sanitizePhysics(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const gravity = Number(raw.gravity)
  const restitution = Number(raw.restitution)
  const groundFriction = Number(raw.groundFriction)
  const throwPower = Number(raw.throwPower)
  if (!Number.isFinite(gravity) || gravity < 0 || gravity > 10000) return null
  if (!Number.isFinite(restitution) || restitution < 0 || restitution > 1) return null
  if (!Number.isFinite(groundFriction) || groundFriction < 0 || groundFriction > 50) return null
  if (!Number.isFinite(throwPower) || throwPower <= 0 || throwPower > 5) return null
  return { gravity, restitution, groundFriction, throwPower, ceilingBounce: raw.ceilingBounce !== false }
}

/** Work-area hull matching dsh-pet's desktop VIEW (all monitors). */
function desktopHull() {
  const displays = screen.getAllDisplays()
  const workAreas = displays.map((display) => ({ ...display.workArea }))
  const panels = displays.map((display) => ({ ...display.bounds }))
  const areas = process.platform === 'darwin'
    ? workAreas.map((area, index) => ({
      ...area,
      y: panels[index].y,
      height: area.y + area.height - panels[index].y,
    }))
    : workAreas
  if (areas.length === 0) return { ...screen.getPrimaryDisplay().workArea }
  const x = Math.min(...areas.map((area) => area.x))
  const y = Math.min(...areas.map((area) => area.y))
  return {
    x,
    y,
    width: Math.max(...areas.map((area) => area.x + area.width)) - x,
    height: Math.max(...areas.map((area) => area.y + area.height)) - y,
  }
}

const lastLocalSample = new Map()

function sanitizeLocalBody(raw, hull, now) {
  if (raw === null || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id.slice(0, 64) : ''
  const rawSize = Number(raw.size)
  const size = Number.isFinite(rawSize) ? Math.max(40, Math.min(800, Math.round(rawSize))) : 0
  if (id === '' || size <= 0) return null
  const height = Math.round(size * 9 / 16)
  const nx = Number(raw.nx)
  const ny = Number(raw.ny)
  let x
  let y
  if (Number.isFinite(nx) && Number.isFinite(ny) && nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
    x = hull.x + nx * hull.width - size / 2
    y = hull.y + ny * hull.height - height / 2
  } else {
    x = Number(raw.x)
    y = Number(raw.y)
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const prev = lastLocalSample.get(id)
  let vx = Number.isFinite(Number(raw.vx)) ? Number(raw.vx) : 0
  let vy = Number.isFinite(Number(raw.vy)) ? Number(raw.vy) : 0
  if (prev !== undefined) {
    const dt = (now - prev.at) / 1000
    if (dt > 0.02 && dt < 3) {
      vx = Math.max(-3000, Math.min(3000, (x - prev.x) / dt))
      vy = Math.max(-3000, Math.min(3000, (y - prev.y) / dt))
    }
  }
  lastLocalSample.set(id, { x, y, at: now })
  return { id, size, width: size, height, x, y, vx, vy }
}

function defaultPosition(index, width, height) {
  const area = screen.getPrimaryDisplay().workArea
  const size = width - MARGIN_SIDE * 2
  const bodyHeight = height - MARGIN_TOP - MARGIN_BOTTOM
  const pad = Math.round(bodyHeight * FEET_PAD_RATIO)
  const bodyX = area.x + area.width - size - 48 - index * 36
  const bodyY = area.y + area.height - bodyHeight + pad - 8 - index * 36
  return {
    x: Math.round(bodyX - MARGIN_SIDE),
    y: Math.round(bodyY - MARGIN_TOP),
  }
}

/** Body hit rectangle matching dsh-pet's HIT_BOX. */
function hitRect(entry) {
  const bounds = entry.win.getBounds()
  const left = bounds.x + MARGIN_SIDE + (HIT_BOX.x0 / STAGE_W) * entry.size
  const right = bounds.x + MARGIN_SIDE + (HIT_BOX.x1 / STAGE_W) * entry.size
  const top = bounds.y + MARGIN_TOP + (HIT_BOX.y0 / STAGE_H) * entry.height
  const bottom = bounds.y + MARGIN_TOP + (HIT_BOX.y1 / STAGE_H) * entry.height
  return { left, right, top, bottom }
}

function findByWebContents(contents) {
  for (const entry of windows.values()) {
    if (entry.win.webContents === contents) return entry
  }
  return undefined
}

function stateFor(entry) {
  const pet = entry.pet
  return {
    key: entry.key,
    name: pet.name,
    size: entry.size,
    height: entry.height,
    animUrl: pet.animUrl || null,
    bubble: pet.bubble || '',
    imageUrl: pet.imageUrl || null,
    facing: pet.facing === 'right' ? 'right' : 'left',
  }
}

function sendState(entry) {
  if (entry.win.isDestroyed()) return
  entry.win.webContents.send('pet-lan-state', stateFor(entry))
}

function createWindow(key, pet) {
  const size = clampSize(pet.size)
  const height = Math.round(size * 9 / 16)
  const width = size + MARGIN_SIDE * 2
  const totalHeight = height + MARGIN_TOP + MARGIN_BOTTOM
  const hasSaved = Number.isFinite(pet.x) && Number.isFinite(pet.y)
  let position = hasSaved
    ? { x: Math.round(pet.x), y: Math.round(pet.y) }
    : defaultPosition(windows.size, width, totalHeight)
  if (hasSaved) {
    // Older versions clamped the window (not the body) to the work area, which
    // left the pet 28-100 px above the floor. Snap near-floor saved windows.
    const area = screen.getDisplayMatching({
      x: position.x,
      y: position.y,
      width,
      height: totalHeight,
    }).workArea
    const bodyBottom = position.y + MARGIN_TOP + height
    const floor = area.y + area.height + Math.round(height * FEET_PAD_RATIO)
    if (bodyBottom > floor - 40 && bodyBottom < floor + 40) position.y += floor - bodyBottom
  }

  const win = new BrowserWindow({
    x: position.x,
    y: position.y,
    width,
    height: totalHeight,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  win.loadFile(path.join(__dirname, 'index.html'))
  win.once('ready-to-show', () => {
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
  })
  win.webContents.on('did-finish-load', () => sendState(entry))
  win.on('closed', () => {
    windows.delete(key)
  })

  const entry = { key, win, size, height, pet, ignoring: true, drag: { active: false } }
  windows.set(key, entry)
  return entry
}

function applyPets(list) {
  const seen = new Set()
  const entries = []
  list.forEach((pet, index) => {
    if (pet === null || typeof pet !== 'object' || typeof pet.key !== 'string') return
    seen.add(pet.key)
    const size = clampSize(pet.size)
    let entry = windows.get(pet.key)
    if (entry !== undefined && entry.size !== size) {
      entry.win.destroy()
      windows.delete(pet.key)
      entry = undefined
    }
    if (entry === undefined) {
      entry = createWindow(pet.key, pet)
    }
    entry.pet = pet
    entries.push(entry)
  })
  for (const [key, entry] of [...windows]) {
    if (seen.has(key)) continue
    entry.win.destroy()
    windows.delete(key)
  }
  for (const entry of entries) sendState(entry)
  if (entries.length === 0) write({ type: 'empty' })
}

function startStdin() {  // Electron's main process cannot read a piped stdin on Windows
  // (electron#4218), so the Host publishes state through files instead.
  const stateFile = process.env.DSH_PET_LAN_STATE || ''
  const movesFile = process.env.DSH_PET_LAN_MOVES || ''
  const hostPid = Number(process.env.DSH_PET_LAN_HOST_PID) || 0
  let lastState = ''

  setInterval(() => {
    if (stateFile === '') return
    let raw
    try {
      raw = fs.readFileSync(stateFile, 'utf8')
    } catch {
      return
    }
    if (raw === lastState) return
    lastState = raw
    try {
      const doc = JSON.parse(raw)
      if (doc !== null && typeof doc === 'object' && Array.isArray(doc.pets)) applyPets(doc.pets)
      if (doc !== null && typeof doc === 'object') {
        if (Array.isArray(doc.locals)) {
          const hull = desktopHull()
          const now = Date.now()
          const seen = new Set()
          localBodies = doc.locals.map((raw) => sanitizeLocalBody(raw, hull, now)).filter((body) => {
            if (body === null) return false
            seen.add(body.id)
            return true
          })
          for (const id of lastLocalSample.keys()) {
            if (!seen.has(id)) lastLocalSample.delete(id)
          }
        }
        const nextPhysics = sanitizePhysics(doc.physics)
        if (nextPhysics !== null) physics = nextPhysics
        if (typeof doc.petCollision === 'boolean') petCollision = doc.petCollision
      }
    } catch {
      // A half-written file is retried on the next tick.
    }
  }, 300).unref?.()

  if (hostPid > 0) {
    setInterval(() => {
      try {
        process.kill(hostPid, 0)
      } catch {
        for (const entry of windows.values()) entry.win.destroy()
        app.quit()
      }
    }, 2000).unref?.()
  }

  globalThis.__petLanMovesFile = movesFile
}

/** Persist a settled window position to the Host. */
function persistMove(entry) {
  if (entry.win.isDestroyed()) return
  let bounds
  try {
    bounds = entry.win.getBounds()
  } catch {
    return
  }
  const movesFile = globalThis.__petLanMovesFile
  if (typeof movesFile === 'string' && movesFile !== '') {
    try {
      fs.appendFileSync(movesFile, JSON.stringify({ key: entry.key, x: bounds.x, y: bounds.y, at: Date.now() }) + '\n')
    } catch {
      // Host may have moved the file; stdout remains a fallback.
    }
  }
  write({ type: 'moved', key: entry.key, x: bounds.x, y: bounds.y })
}

function stopThrow(entry) {
  entry.physics = undefined
}

function startThrow(entry, vx, vy) {
  stopThrow(entry)
  if (entry.win.isDestroyed()) return
  const power = Number.isFinite(physics.throwPower) ? physics.throwPower : DEFAULT_PHYSICS.throwPower
  vx *= power
  vy *= power
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || Math.hypot(vx, vy) < 60) {
    persistMove(entry)
    return
  }
  let bounds
  try {
    bounds = entry.win.getBounds()
  } catch {
    return
  }
  const area = screen.getDisplayMatching(bounds).workArea
  entry.physics = {
    x: bounds.x + MARGIN_SIDE,
    y: bounds.y + MARGIN_TOP,
    vx: Math.max(-2600, Math.min(2600, vx)),
    vy: Math.max(-2600, Math.min(2600, vy)),
    width: entry.size,
    height: entry.height,
    area,
    last: Date.now(),
  }
}

/** One shared 60 Hz tick for every window currently in flight. */
function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** Same circle-impulse response as dsh-pet's collidePet (mass = size^2). */
function collideBodies(a, b) {
  const ah = a.height / 2
  const bh = b.height / 2
  const cx = (b.x + b.width / 2) - (a.x + a.width / 2)
  const cy = (b.y + bh) - (a.y + ah)
  const dist = Math.hypot(cx, cy)
  if (dist < 1e-6) return null
  const nx = cx / dist
  const ny = cy / dist
  const vrel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny
  if (vrel <= 0) return null
  const m1 = a.width * a.width
  const m2 = b.width * b.width
  const v1n = a.vx * nx + a.vy * ny
  const v2n = b.vx * nx + b.vy * ny
  const v1n2 = ((m1 - PET_BOUNCE_E * m2) * v1n + (1 + PET_BOUNCE_E) * m2 * v2n) / (m1 + m2)
  const v2n2 = ((m2 - PET_BOUNCE_E * m1) * v2n + (1 + PET_BOUNCE_E) * m1 * v1n) / (m1 + m2)
  return {
    avx: a.vx - v1n * nx + v1n2 * nx,
    avy: a.vy - v1n * ny + v1n2 * ny,
    bvx: b.vx - v2n * nx + v2n2 * nx,
    bvy: b.vy - v2n * ny + v2n2 * ny,
  }
}

function bodyOfEntry(entry) {
  const moving = entry.physics
  const bounds = entry.win.getBounds()
  const x = moving === undefined ? bounds.x + MARGIN_SIDE : moving.x
  const y = moving === undefined ? bounds.y + MARGIN_TOP : moving.y
  return {
    x,
    y,
    width: entry.size,
    height: entry.height,
    vx: moving === undefined ? 0 : moving.vx,
    vy: moving === undefined ? 0 : moving.vy,
  }
}

/** Penetration depth and direction between two body boxes. */
function overlapInfo(a, b) {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (overlapX <= 0 || overlapY <= 0) return null
  const acx = a.x + a.width / 2
  const acy = a.y + a.height / 2
  const bcx = b.x + b.width / 2
  const bcy = b.y + b.height / 2
  const dx = bcx - acx
  const dy = bcy - acy
  const dist = Math.hypot(dx, dy)
  const nx = dist > 1e-6 ? dx / dist : 0
  const ny = dist > 1e-6 ? dy / dist : -1
  return { nx, ny, penetration: Math.min(overlapX, overlapY) }
}

function moveEntry(entry, dx, dy) {
  if (entry.win.isDestroyed()) return
  try {
    const bounds = entry.win.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    const bodyX = (entry.physics === undefined ? bounds.x + MARGIN_SIDE : entry.physics.x) + dx
    const bodyY = (entry.physics === undefined ? bounds.y + MARGIN_TOP : entry.physics.y) + dy
    const x = Math.max(area.x, Math.min(area.x + area.width - entry.size, Math.round(bodyX)))
    const y = Math.max(
      area.y,
      Math.min(
        area.y + area.height + Math.round(entry.height * FEET_PAD_RATIO) - entry.height,
        Math.round(bodyY),
      ),
    )
    entry.win.setPosition(x - MARGIN_SIDE, y - MARGIN_TOP)
    if (entry.physics !== undefined) {
      entry.physics.x = x
      entry.physics.y = y
    }
  } catch {
    // Window destroyed mid-tick.
  }
}

function applyBodyVelocity(entry, vx, vy) {
  if (entry.win.isDestroyed()) return
  if (entry.physics === undefined) {
    const bounds = entry.win.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    entry.physics = {
      x: bounds.x + MARGIN_SIDE,
      y: bounds.y + MARGIN_TOP,
      vx,
      vy,
      width: entry.size,
      height: entry.height,
      area,
      last: Date.now(),
    }
  } else {
    entry.physics.vx = vx
    entry.physics.vy = vy
  }
}

function collidePets() {
  if (!petCollision) return
  const entries = [...windows.values()].filter((entry) => !entry.win.isDestroyed())
  for (let i = 0; i < entries.length; i += 1) {
    const a = entries[i]
    if (a.drag.active) continue
    let ab = bodyOfEntry(a)
    for (let j = i + 1; j < entries.length; j += 1) {
      const b = entries[j]
      if (b.drag.active) continue
      const bb = bodyOfEntry(b)
      const info = overlapInfo(ab, bb)
      if (info === null) continue
      const hit = collideBodies(ab, bb)
      if (hit !== null) {
        applyBodyVelocity(a, hit.avx, hit.avy)
        applyBodyVelocity(b, hit.bvx, hit.bvy)
      }
      // Resolve the remaining overlap even when both pets are at rest (a
      // slow drag-and-drop has zero relative velocity but must still collide).
      const push = Math.min(24, info.penetration / 2 + 0.5)
      moveEntry(a, -info.nx * push, -info.ny * push)
      moveEntry(b, info.nx * push, info.ny * push)
      persistMove(a)
      persistMove(b)
      ab = bodyOfEntry(a)
    }
    for (const local of localBodies) {
      const info = overlapInfo(ab, local)
      if (info === null) continue
      const hit = collideBodies(ab, local)
      if (hit !== null) applyBodyVelocity(a, hit.avx, hit.avy)
      const push = Math.min(40, info.penetration + 1)
      moveEntry(a, -info.nx * push, -info.ny * push)
      persistMove(a)
      const now = Date.now()
      if (now - (localHitAt.get(local.id) ?? 0) < 300) continue
      const nudge = Math.max(80, Math.min(240, 80 + info.penetration * 4))
      const vx = hit !== null ? hit.bvx : info.nx * nudge
      const vy = hit !== null ? hit.bvy : info.ny * nudge
      if (Math.abs(vx) + Math.abs(vy) < 2) continue
      localHitAt.set(local.id, now)
      write({ type: 'local-hit', petId: local.id, vx, vy })
      ab = bodyOfEntry(a)
    }
  }
  for (const [id, at] of localHitAt) {
    if (Date.now() - at > 5000) localHitAt.delete(id)
  }
}

function tickThrows() {
  const now = Date.now()
  const gravity = Number.isFinite(physics.gravity) ? physics.gravity : DEFAULT_PHYSICS.gravity
  const restitution = Number.isFinite(physics.restitution) ? physics.restitution : DEFAULT_PHYSICS.restitution
  const groundFriction = Number.isFinite(physics.groundFriction) ? physics.groundFriction : DEFAULT_PHYSICS.groundFriction
  const ceilingBounce = physics.ceilingBounce !== false

  for (const entry of windows.values()) {
    const body = entry.physics
    if (body === undefined) continue
    if (entry.win.isDestroyed()) {
      entry.physics = undefined
      continue
    }
    const dt = Math.min(0.05, Math.max(0.001, (now - body.last) / 1000))
    body.last = now
    body.vy += gravity * dt
    body.x += body.vx * dt
    body.y += body.vy * dt

    const minX = body.area.x
    const maxX = Math.max(minX, body.area.x + body.area.width - body.width)
    const minY = body.area.y
    const maxY = Math.max(minY, body.area.y + body.area.height + Math.round(body.height * FEET_PAD_RATIO) - body.height)
    let bounced = false
    if (body.x < minX) {
      body.x = minX
      body.vx = Math.abs(body.vx) * restitution
      bounced = true
    } else if (body.x > maxX) {
      body.x = maxX
      body.vx = -Math.abs(body.vx) * restitution
      bounced = true
    }
    if (body.y < minY) {
      if (ceilingBounce) {
        body.y = minY
        body.vy = Math.abs(body.vy) * restitution
        bounced = true
      }
    } else if (body.y >= maxY) {
      body.y = maxY
      body.vx *= Math.max(0, 1 - groundFriction * dt)
      if (Math.abs(body.vy) < REST_VY) body.vy = 0
      else body.vy = -Math.abs(body.vy) * restitution
      bounced = true
    }
    try {
      entry.win.setPosition(Math.round(body.x - MARGIN_SIDE), Math.round(body.y - MARGIN_TOP))
    } catch {
      entry.physics = undefined
      continue
    }

    const onFloor = body.y >= maxY - 1
    const speed = Math.hypot(body.vx, body.vy)
    const atRest = onFloor && Math.abs(body.vy) < 1 && Math.abs(body.vx) < REST_VX
      || bounced && speed < REST_VY && Math.abs(body.vy) < 1
    if (atRest) {
      entry.physics = undefined
      persistMove(entry)
    }
  }

  collidePets()
}

ipcMain.on('pet-lan-ready', (event) => {
  const entry = findByWebContents(event.sender)
  if (entry !== undefined) sendState(entry)
})

ipcMain.on('pet-lan-poke', (event, key) => {
  const entry = findByWebContents(event.sender)
  const id = entry !== undefined ? entry.key : (typeof key === 'string' ? key.slice(0, 200) : '')
  if (id !== '') write({ type: 'poke', key: id })
})

ipcMain.on('pet-lan-drag-start', (event, payload) => {
  const entry = findByWebContents(event.sender)
  if (entry === undefined || entry.win.isDestroyed() || payload === null || typeof payload !== 'object') return
  stopThrow(entry)
  const bounds = entry.win.getBounds()
  entry.drag = {
    active: true,
    startX: Number(payload.screenX) || 0,
    startY: Number(payload.screenY) || 0,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  }
  entry.win.setIgnoreMouseEvents(false)
  entry.ignoring = false
  entry.win.setAlwaysOnTop(true, 'screen-saver')
})

ipcMain.on('pet-lan-drag-move', (event, payload) => {
  const entry = findByWebContents(event.sender)
  if (entry === undefined || entry.win.isDestroyed() || entry.drag.active !== true || payload === null || typeof payload !== 'object') return
  const dx = Math.round((Number(payload.screenX) || 0) - entry.drag.startX)
  const dy = Math.round((Number(payload.screenY) || 0) - entry.drag.startY)
  try {
    entry.win.setPosition(entry.drag.x + dx, entry.drag.y + dy)
  } catch {
    entry.drag.active = false
  }
})

ipcMain.on('pet-lan-drag-end', (event, payload) => {
  const entry = findByWebContents(event.sender)
  if (entry === undefined || entry.win.isDestroyed() || entry.drag.active !== true) return
  entry.drag.active = false
  const vx = payload !== null && typeof payload === 'object' ? Number(payload.vx) : 0
  const vy = payload !== null && typeof payload === 'object' ? Number(payload.vy) : 0
  if (Number.isFinite(vx) && Number.isFinite(vy) && Math.hypot(vx, vy) >= 60) {
    startThrow(entry, vx, vy)
  } else {
    persistMove(entry)
  }
})

ipcMain.on('pet-lan-drag-cancel', (event) => {
  const entry = findByWebContents(event.sender)
  if (entry === undefined || entry.win.isDestroyed()) return
  const wasActive = entry.drag.active === true
  entry.drag.active = false
  stopThrow(entry)
  if (wasActive && Number.isFinite(entry.drag.x) && Number.isFinite(entry.drag.y)) {
    try {
      entry.win.setPosition(entry.drag.x, entry.drag.y)
    } catch {
      // The window vanished between the guard and the move.
    }
  }
})

app.whenReady().then(() => {
  startStdin()
  write({ type: 'ready' })

  // Advance every window currently flying/falling after a throw.
  setInterval(tickThrows, 16).unref?.()

  // Hover test: the window stays click-through until the cursor is over the
  // pet body, so transparent pixels never block the desktop underneath.
  setInterval(() => {
    const point = screen.getCursorScreenPoint()
    for (const entry of windows.values()) {
      if (entry.win.isDestroyed()) continue
      if (entry.drag.active) {
        if (entry.ignoring) {
          entry.ignoring = false
          entry.win.setIgnoreMouseEvents(false)
        }
        continue
      }
      const hit = hitRect(entry)
      const onPet = point.x >= hit.left && point.x <= hit.right && point.y >= hit.top && point.y <= hit.bottom
      if (onPet === entry.ignoring) {
        entry.ignoring = !onPet
        entry.win.setIgnoreMouseEvents(!onPet)
      }
    }
  }, 60).unref?.()

  // Windows occasionally drops the topmost style after focus changes.
  setInterval(() => {
    for (const entry of windows.values()) {
      if (!entry.win.isDestroyed()) entry.win.setAlwaysOnTop(true, 'screen-saver')
    }
  }, 2000).unref?.()
})

app.on('window-all-closed', () => {
  // Keep the process alive: the Host keeps sending pet updates over stdin.
})
