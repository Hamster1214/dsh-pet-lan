/** Version-pinned, reversible adapter. Requires an explicit dsh-pet directory. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = process.argv[2]
const restore = process.argv.includes('--restore')
if (!root) throw new Error('Usage: node scripts/patch-physics-038.mjs <dsh-pet-0.3.8-directory> [--restore]')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
if (manifest.name !== 'dsh-pet' || manifest.version !== '0.3.8') throw new Error('This adapter requires exactly dsh-pet 0.3.8')
const runtime = path.join(root, 'runtime/electron-helper')
const backupArg = process.argv.indexOf('--backup-dir')
const backupDir = backupArg >= 0 ? path.resolve(process.argv[backupArg + 1]) : path.join(runtime, '.lan-physics-038-backup')
const journalFile = path.join(backupDir, 'manifest.json')
const hash = source => createHash('sha256').update(source).digest('hex')
if (restore) {
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
  for (const entry of journal) {
    if (hash(fs.readFileSync(path.join(runtime, entry.name))) !== entry.patched) throw new Error('File changed since patch; refusing to overwrite: ' + entry.name)
  }
  for (const entry of journal) {
    const dest = path.join(runtime, entry.name)
    if (entry.original) fs.copyFileSync(path.join(backupDir, entry.name), dest)
    else fs.unlinkSync(dest)
  }
  fs.unlinkSync(journalFile)
  console.log('Restored original runtime: ' + root)
  process.exit(0)
}
if (fs.existsSync(journalFile)) {
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
  for (const entry of journal) if (hash(fs.readFileSync(path.join(runtime, entry.name))) !== entry.patched) throw new Error('Patched file changed: ' + entry.name)
  console.log('Already patched and verified: ' + root)
  process.exit(0)
}
function replaceOne(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Missing or non-unique anchor: ' + anchor.slice(0, 100))
  return source.replace(anchor, replacement)
}
const staged = new Map()
let main = fs.readFileSync(path.join(runtime, 'main.js'), 'utf8').replace(/\r\n/g, '\n')
main = replaceOne(main, 'const petStates = new Map();', `const petStates = new Map();
// LAN physics 0.3.8: effective runtime override; never overwrite user configuration.
let lanCollisionOwned = false;
let lanCollisionBridge = null;
const lanStateAt = new Map();`)
main = replaceOne(main, '  for (const [pid, s] of petStates) {', '  for (const [pid, s] of (lanCollisionOwned ? [] : petStates)) {')
main = replaceOne(main, '  petStates.set(petId, Object.assign({}, prev, partial));', '  petStates.set(petId, Object.assign({}, prev, partial));\n  lanStateAt.set(petId, Date.now());')
main = replaceOne(main, "  ipcMain.on('pet:collide-result', (event, payload) => {", "  ipcMain.on('pet:collide-result', (event, payload) => {\n    if (lanCollisionOwned) return;")
const initialization = `
  // Authenticated loopback stream: direct states and velocities, no /pose polling.
  lanCollisionBridge = require('./native-bridge.cjs').createNativeBridge({
    snapshot: () => {
      const geo = deskGeometry();
      const bodies = [];
      for (const [id, state] of petStates) {
        const win = windows.get(id);
        if (!win || win.isDestroyed() || !(state.size > 0)) continue;
        win.webContents.send('pet:lan-owner', lanCollisionOwned);
        const flying = Math.hypot(state.vx, state.vy) > 0;
        if (flying && Date.now() - (lanStateAt.get(id) || 0) > 250) continue;
        bodies.push({ id, x: state.x + geo.hull.x, y: state.y + geo.hull.y,
          size: state.size, bottomPad: state.bottomPad, vx: state.vx, vy: state.vy,
          flying, busy: !!inputBusy.get(win.id), sourceAt: lanStateAt.get(id) });
      }
      return { bodies, scale: petScale() };
    },
    apply: hits => {
      // Validate both targets before changing either side of a native/native pair.
      if (!lanCollisionOwned || hits.some(hit => {
        const win = windows.get(hit.id);
        return !win || win.isDestroyed() || inputBusy.get(win.id) || !petStates.has(hit.id);
      })) return false;
      for (const hit of hits) {
        Object.assign(petStates.get(hit.id), { vx: hit.vx, vy: hit.vy });
        lanStateAt.set(hit.id, Date.now());
        windows.get(hit.id).webContents.send('pet:hit', { vx: hit.vx, vy: hit.vy });
      }
      return true;
    },
    onOwner: active => {
      lanCollisionOwned = active;
      for (const win of windows.values()) if (!win.isDestroyed()) win.webContents.send('pet:lan-owner', active);
      broadcastPetStates();
    },
  });
  app.on('will-quit', () => lanCollisionBridge?.close());
`
main = replaceOne(main, '  createPetWindows();\n\n  // 宠物窗口跟随', '  createPetWindows();\n' + initialization + '\n  // 宠物窗口跟随')
staged.set('main.js', main)
let preload = fs.readFileSync(path.join(runtime, 'preload.js'), 'utf8').replace(/\r\n/g, '\n')
preload = replaceOne(preload, "contextBridge.exposeInMainWorld('petBridge', {", `let lanCollisionOwned = false;
ipcRenderer.on('pet:lan-owner', (_event, active) => { lanCollisionOwned = active === true; });
contextBridge.exposeInMainWorld('petBridge', {
  isLanCollisionOwned() { return lanCollisionOwned; },`)
staged.set('preload.js', preload)
let sprite = fs.readFileSync(path.join(runtime, 'sprite.js'), 'utf8').replace(/\r\n/g, '\n')
sprite = replaceOne(sprite, 'if (this.physics && this.physics.petCollision) {', 'if (this.physics && this.physics.petCollision && !window.petBridge?.isLanCollisionOwned?.()) {')
sprite = replaceOne(sprite, '  onDeskHit(vx, vy) {', '  onDeskHit(vx, vy) {\n    if (this.dragState.active) return;')
sprite = replaceOne(sprite, '        this.throwState = null;\n        this.customPos =', '        this.throwState = null;\n        this.sendBounds(this.pos.x, this.pos.y); // publish zero velocity immediately on rest\n        this.customPos =')
staged.set('sprite.js', sprite)
const shared = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime/shared')
for (const name of ['native-bridge.cjs', 'json-channel.cjs']) staged.set(name, fs.readFileSync(path.join(shared, name), 'utf8'))

// Prepare every anchor and backup before the first write. Roll back on write failure.
fs.mkdirSync(backupDir, { recursive: true })
const journal = []
for (const [name, source] of staged) {
  const file = path.join(runtime, name)
  const original = fs.existsSync(file)
  if (original) fs.copyFileSync(file, path.join(backupDir, name))
  journal.push({ name, original, patched: hash(source) })
}
try {
  for (const [name, source] of staged) fs.writeFileSync(path.join(runtime, name), source)
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2))
} catch (error) {
  for (const entry of journal) {
    if (entry.original) fs.copyFileSync(path.join(backupDir, entry.name), path.join(runtime, entry.name))
    else if (fs.existsSync(path.join(runtime, entry.name))) fs.unlinkSync(path.join(runtime, entry.name))
  }
  throw error
}
console.log('Patched dsh-pet 0.3.8; restart its desktop helper to activate: ' + root)
