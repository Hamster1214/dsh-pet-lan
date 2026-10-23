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
const MARGIN_BOTTOM = 28
const MIN_SIZE = 80
const MAX_SIZE = 320

/** Throw physics: gravity, edge restitution and slow-down. */
const GRAVITY = 2200
const RESTITUTION = 0.55
const FRICTION = 0.995
const THROW_STOP_VX = 40
const THROW_STOP_VY = 25

/** key -> { win, size, height, pet, ignoring, drag } */
const windows = new Map()

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

function defaultPosition(index, width, height) {
  const area = screen.getPrimaryDisplay().workArea
  const x = area.x + area.width - width - 48 - index * 36
  const y = area.y + area.height - height - 72 - index * 36
  return {
    x: Math.max(area.x, Math.round(x)),
    y: Math.max(area.y, Math.round(y)),
  }
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
  const position = hasSaved
    ? { x: Math.round(pet.x), y: Math.round(pet.y) }
    : defaultPosition(windows.size, width, totalHeight)

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
  const bounds = entry.win.getBounds()
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
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || Math.hypot(vx, vy) < 60) {
    persistMove(entry)
    return
  }
  const bounds = entry.win.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  entry.physics = {    x: bounds.x,
    y: bounds.y,
    vx: Math.max(-2600, Math.min(2600, vx)),
    vy: Math.max(-2600, Math.min(2600, vy)),
    width: bounds.width,
    height: bounds.height,
    area,
    last: Date.now(),
  }
}

/** One shared 60 Hz tick for every window currently in flight. */
function tickThrows() {
  const now = Date.now()
  for (const entry of windows.values()) {
    const body = entry.physics
    if (body === undefined) continue
    if (entry.win.isDestroyed()) {
      entry.physics = undefined
      continue
    }
    const dt = Math.min(0.05, Math.max(0.001, (now - body.last) / 1000))
    body.last = now
    body.vy += GRAVITY * dt
    body.x += body.vx * dt
    body.y += body.vy * dt

    const minX = body.area.x
    const maxX = Math.max(minX, body.area.x + body.area.width - body.width)
    const minY = body.area.y
    const maxY = Math.max(minY, body.area.y + body.area.height - body.height)
    if (body.x < minX) {
      body.x = minX
      body.vx = Math.abs(body.vx) * RESTITUTION
    } else if (body.x > maxX) {
      body.x = maxX
      body.vx = -Math.abs(body.vx) * RESTITUTION
    }
    if (body.y < minY) {
      body.y = minY
      body.vy = Math.abs(body.vy) * RESTITUTION
    } else if (body.y > maxY) {
      body.y = maxY
      body.vy = -Math.abs(body.vy) * RESTITUTION
    }
    body.vx *= FRICTION
    body.vy *= FRICTION
    const onFloor = body.y >= maxY - 0.5
    if (onFloor) body.vx *= 0.92
    try {
      entry.win.setPosition(Math.round(body.x), Math.round(body.y))
    } catch {
      entry.physics = undefined
      continue
    }

    if (onFloor && Math.abs(body.vy) < THROW_STOP_VY && Math.abs(body.vx) < THROW_STOP_VX) {
      entry.physics = undefined
      persistMove(entry)
    }
  }
}

ipcMain.on('pet-lan-ready', (event) => {
  const entry = findByWebContents(event.sender)
  if (entry !== undefined) sendState(entry)
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
  entry.win.setPosition(entry.drag.x + dx, entry.drag.y + dy)
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
    entry.win.setPosition(entry.drag.x, entry.drag.y)
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
      const bounds = entry.win.getBounds()
      const left = bounds.x + MARGIN_SIDE - 8
      const top = bounds.y + MARGIN_TOP - 8
      const right = left + entry.size + 16
      const bottom = top + entry.height + 16
      const onPet = point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
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
