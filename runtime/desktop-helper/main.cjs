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
const S = require('../shared/pet-core.cjs')
const { advance, spaceFor } = require('../shared/motion.cjs')
const { CollisionWorld } = require('../shared/collision-world.cjs')
const { createLocalPetLink } = require('../shared/local-pet-link.cjs')
if (process.platform === 'win32') app.commandLine.appendSwitch('force-device-scale-factor', '1')

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

/** key -> { win, size, height, pet, ignoring, drag, physics? } */
const windows = new Map()

let physics = { ...DEFAULT_PHYSICS }
let petCollision = false
let confineToScreen = false
let localLink = null
const collisionWorld = new CollisionWorld()
const motionScale = () => localLink?.scale || 1


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




function defaultPosition(index, width, height) {
  const area = screen.getPrimaryDisplay().workArea
  const size = width - MARGIN_SIDE * 2
  const bodyHeight = (height - MARGIN_TOP - MARGIN_BOTTOM) / (1 + FEET_PAD_RATIO)
  const pad = 0
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
  const top = bounds.y + MARGIN_TOP + entry.height * FEET_PAD_RATIO + (HIT_BOX.y0 / STAGE_H) * entry.height
  const bottom = bounds.y + MARGIN_TOP + entry.height * FEET_PAD_RATIO + (HIT_BOX.y1 / STAGE_H) * entry.height
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
    bottomPad: entry.height * FEET_PAD_RATIO,
    physics,
    scale: motionScale(),
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
  const size = Math.round(clampSize(pet.size) * motionScale())
  const height = size * 9 / 16
  const width = size + MARGIN_SIDE * 2
  const totalHeight = Math.ceil(height * (1 + FEET_PAD_RATIO) + MARGIN_TOP + MARGIN_BOTTOM)
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
    const floor = area.y + area.height
    if (bodyBottom > floor - 40 && bodyBottom < floor + 40) position.y += floor - bodyBottom
  }

  const win = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: Math.ceil(width),
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
    const size = Math.round(clampSize(pet.size) * motionScale())
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
      if (doc !== null && typeof doc === 'object') {
        const nextPhysics = sanitizePhysics(doc.physics)
        if (nextPhysics !== null) physics = nextPhysics
        if (typeof doc.petCollision === 'boolean') petCollision = doc.petCollision
        confineToScreen = doc.confineToScreen === true
        if (Array.isArray(doc.pets)) applyPets(doc.pets)
      }
    } catch {
      // A half-written file is retried on the next tick.
    }
  }, 150).unref?.()

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
  if (entry.win.isDestroyed() || !Number.isFinite(vx) || !Number.isFinite(vy)) return
  const bounds = entry.win.getBounds()
  const x = bounds.x + MARGIN_SIDE, y = bounds.y + MARGIN_TOP
  const scale = motionScale()
  const space = spaceFor(entry.size, screen.getAllDisplays(), scale)
  entry.physics = { x, y, vx, vy, last: performance.now(), grounded: false,
    lockScreen: confineToScreen ? S.screenOfBox(space, x / scale, y / scale) : -1 }
}

/** One shared 60 Hz tick for every window currently in flight. */


/** Same circle-impulse response as dsh-pet's collidePet (mass = size^2). */


function bodyOfEntry(entry) {
  const moving = entry.physics, bounds = entry.win.getBounds()
  return { id: 'remote:' + entry.key, entry, local: false, size: entry.size,
    bottomPad: entry.height * FEET_PAD_RATIO,
    x: moving ? moving.x : bounds.x + MARGIN_SIDE, y: moving ? moving.y : bounds.y + MARGIN_TOP,
    vx: moving?.vx || 0, vy: moving?.vy || 0, flying: !!moving, busy: entry.drag.active }
}

/** Penetration depth and direction between two body boxes. */




function applyBodyVelocity(entry, vx, vy) {
  if (entry.win.isDestroyed() || entry.drag.active) return
  if (!entry.physics) startThrow(entry, vx, vy)
  else { entry.physics.vx = vx; entry.physics.vy = vy }
}

function collidePets() {
  // No bridge = no takeover. Never run a second solver beside native physics.
  if (!petCollision || !localLink?.active) { collisionWorld.clear(); return }
  const remotes = [...windows.values()].filter(entry => !entry.win.isDestroyed()).map(bodyOfEntry)
  const locals = localLink.bodies().map(body => ({ ...body, nativeId: body.id, id: 'local:' + body.id, local: true }))
  collisionWorld.step([...remotes, ...locals], async (a, b, hit) => {
    const pairs = [[a, hit.fvx, hit.fvy], [b, hit.hvx, hit.hvy]]
    const nativeHits = pairs.filter(([body]) => body.local).map(([body, vx, vy]) => ({ id: body.nativeId, vx, vy }))
    if (nativeHits.length && !await localLink.impulse(nativeHits)) return false
    if (!petCollision || !localLink.active) return false
    for (const [body, vx, vy] of pairs) if (!body.local) applyBodyVelocity(body.entry, vx, vy)
    return true
  })
}

function tickThrows() {
  const now = performance.now()
  const displays = screen.getAllDisplays(), scale = motionScale()
  for (const entry of windows.values()) {
    if (entry.win.isDestroyed()) continue
    const drag = entry.drag
    if (drag.active && drag.target) {
      const dt = Math.min((now - drag.last) / 1000, 1 / 30)
      drag.last = now
      drag.vx = S.springStep(drag.vx / scale, drag.px / scale, drag.target.x / scale, dt, physics.throwPower) * scale
      drag.vy = S.springStep(drag.vy / scale, drag.py / scale, drag.target.y / scale, dt, physics.throwPower) * scale
      drag.px += drag.vx * dt; drag.py += drag.vy * dt
      entry.win.setPosition(Math.round(drag.px), Math.round(drag.py))
    }
    const body = entry.physics
    if (!body) continue
    const dt = Math.min(S.MAX_STEP_DT, Math.max(0.001, (now - body.last) / 1000))
    body.last = now
    const result = advance(body, entry.size, displays, physics, dt, scale)
    Object.assign(body, result)
    entry.win.setPosition(Math.round(body.x - MARGIN_SIDE), Math.round(body.y - MARGIN_TOP))
    if (result.landed) entry.win.webContents.send('pet-lan-land', { squash: result.squash })
    if (result.atRest) { entry.physics = undefined; persistMove(entry) }
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
    px: bounds.x, py: bounds.y, vx: 0, vy: 0, last: performance.now(), target: null,
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
    entry.drag.target = { x: entry.drag.x + dx, y: entry.drag.y + dy }
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
  if (Number.isFinite(vx) && Number.isFinite(vy) && Math.hypot(vx, vy) > 0) {
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
  localLink = createLocalPetLink({ enabled: () => petCollision,
    onStatus: state => write({ type: 'collision-status', ...state }) })
  app.on('will-quit', () => localLink.close())
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
