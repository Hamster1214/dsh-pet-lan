#!/usr/bin/env node
/**
 * One-shot installer for colleagues (and their AI agents).
 *
 * What it does:
 *   1. copies this package to a stable DSH home directory
 *      (default: $DSH_HOME/plugins/dsh-pet-lan),
 *   2. writes/merges $DSH_HOME/dsh-pet-lan.json with the requested room,
 *      port and display mode (defaults: dsh-pet / 41234 / desktop),
 *   3. registers the bundle in the selected DSH profile (package.json +
 *      node_modules junction) unless --no-register is given,
 *   4. applies the dsh-pet live-state patch when dsh-pet is installed.
 *
 * Everything is idempotent; profile package.json is backed up once as
 * package.json.dsh-pet-lan.bak.
 *
 * Usage:
 *   node scripts/install.mjs [--room Kunpo] [--port 41234] [--mode desktop]
 *                            [--target <dir>] [--profile desktop]
 *                            [--no-register] [--no-patch] [--dry-run] [--json]
 */

import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readArg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

const dryRun = process.argv.includes('--dry-run')
const noRegister = process.argv.includes('--no-register')
const noPatch = process.argv.includes('--no-patch')
const asJson = process.argv.includes('--json')

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const room = readArg('room', 'dsh-pet')
const port = Number(readArg('port', '41234'))
const mode = readArg('mode', 'desktop')
const profileName = readArg('profile', process.env.DSH_PROFILE || 'desktop')
const target = resolve(readArg('target', join(home, 'plugins', 'dsh-pet-lan')))
const profileDir = process.env.DSH_PROFILE_DIR
  ? resolve(process.env.DSH_PROFILE_DIR)
  : join(home, 'profiles', profileName)

const result = {
  source: sourceRoot,
  target,
  profileDir,
  room,
  port,
  mode,
  copied: false,
  config: false,
  registered: false,
  patched: 'skipped',
  warnings: [],
}

function log(message) {
  if (!asJson) console.log(message)
}

function warn(message) {
  result.warnings.push(message)
  if (!asJson) console.warn('[install] warning: ' + message)
}

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('[install] invalid --port (1024..65535)')
  process.exit(2)
}
if (!['desktop', 'browser', 'both'].includes(mode)) {
  console.error('[install] invalid --mode (desktop|browser|both)')
  process.exit(2)
}

/* 1. Copy to the stable target (skip when already running from it). */
const sameDir = resolve(sourceRoot).toLowerCase() === target.toLowerCase()
if (sameDir) {
  log('[install] already running from the target; skipping copy')
} else {
  if (!dryRun) mkdirSync(target, { recursive: true })
  // A target that is a junction would make us write through to its source.
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    if (!dryRun) rmSync(target, { recursive: false })
  }
  log('[install] copy ' + sourceRoot + ' -> ' + target)
  if (!dryRun) {
    cpSync(sourceRoot, target, {
      recursive: true,
      force: true,
      filter: (source) => {
        const base = source.split(/[\\/]/).pop()
        if (base === 'node_modules' || base === '.git' || base === 'shots') return false
        if (base.endsWith('.zip') || base.endsWith('.bak') || base.endsWith('.jsonl')) return false
        return true
      },
    })
  }
  result.copied = true
}

/* 2. Room / port / mode in the plugin's own config. */
const configPath = join(home, 'dsh-pet-lan.json')
let config = {}
try {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
  if (parsed !== null && typeof parsed === 'object') config = parsed
} catch {
  // First install: defaults are fine.
}
config = { ...config, enabled: true, room, port, mode }
if (!dryRun) {
  mkdirSync(home, { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
}
result.config = true
log('[install] config ' + configPath + ' room=' + room + ' port=' + port + ' mode=' + mode)

/* 3. Profile registration: dependency + bundle selection + node_modules link. */
function register() {
  const profileManifest = join(profileDir, 'package.json')
  if (!existsSync(profileManifest)) {
    warn('profile package.json not found: ' + profileManifest)
    return false
  }
  const manifest = JSON.parse(readFileSync(profileManifest, 'utf8').replace(/^\uFEFF/, ''))
  manifest.dependencies = { ...(manifest.dependencies || {}) }
  manifest.dependencies['dsh-pet-lan'] = 'link:' + target.replace(/\\/g, '/')
  const profile = { ...(manifest.dsh && manifest.dsh.profile ? manifest.dsh.profile : {}) }
  const bundles = Array.isArray(profile.bundles) ? profile.bundles.slice() : []
  if (!bundles.includes('dsh-pet-lan')) bundles.push('dsh-pet-lan')
  profile.bundles = bundles
  manifest.dsh = { ...(manifest.dsh || {}), profile }

  const backup = profileManifest + '.dsh-pet-lan.bak'
  if (!dryRun && !existsSync(backup)) copyFileSync(profileManifest, backup)
  if (!dryRun) writeFileSync(profileManifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  log('[install] registered bundle in ' + profileManifest)

  const nodeModules = join(profileDir, 'node_modules')
  const linkPath = join(nodeModules, 'dsh-pet-lan')
  if (!dryRun) mkdirSync(nodeModules, { recursive: true })
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink()) {
      if (!dryRun) {
        try {
          rmSync(linkPath, { recursive: false })
        } catch {
          spawnSync('cmd', ['/c', 'rmdir', linkPath], { windowsHide: true })
        }
      }
    } else {
      warn('node_modules/dsh-pet-lan is a real directory; leaving it in place')
      return true
    }
  }
  if (!dryRun) {
    const linked = spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { windowsHide: true, encoding: 'utf8' })
    if (linked.status !== 0) {
      try {
        symlinkSync(target, linkPath, 'junction')
      } catch (error) {
        warn('could not create node_modules link: ' + String(error && error.message ? error.message : error))
      }
    }
  }
  log('[install] linked node_modules/dsh-pet-lan -> ' + target)
  return true
}

if (noRegister) {
  log('[install] registration skipped (--no-register); use plugin_manager install_bundle with target ' + target)
} else {
  try {
    result.registered = register()
  } catch (error) {
    warn('profile registration failed: ' + String(error && error.message ? error.message : error))
    result.registered = false
  }
}

/* 4. dsh-pet live-state patch (needed for animation / bubble / meme sync). */
if (!noPatch) {
  const dshPet = join(profileDir, 'node_modules', 'dsh-pet')
  if (existsSync(join(dshPet, 'package.json'))) {
    log('[install] patching dsh-pet at ' + dshPet)
    if (!dryRun) {
      const patched = spawnSync(process.execPath, [join(target, 'scripts', 'patch-dsh-pet.mjs'), dshPet], {
        stdio: 'inherit',
      })
      result.patched = patched.status === 0 ? 'applied' : 'failed'
      if (patched.status !== 0) warn('dsh-pet patch failed; live state will not sync until it is applied')
    } else {
      result.patched = 'dry-run'
    }
  } else {
    result.patched = 'skipped (dsh-pet not installed)'
    warn('dsh-pet 0.3.7 is not installed in this profile; install it before expecting a pet')
  }
}

log('')
log('[install] done')
log('  package : ' + target)
log('  profile : ' + profileDir)
log('  config  : room=' + room + ' port=' + port + ' mode=' + mode)
log('  patch   : ' + result.patched)
log('  restart : required for a profile registration; re-open DSH, then check 设置 → 桌宠联机')
if (noRegister) log('  next    : plugin_manager install_bundle target=' + target + ' applies it live')
else log('  next    : if you have the plugin_manager tool, install_bundle target=' + target + ' can apply it live')

if (asJson) console.log(JSON.stringify(result, null, 2))
process.exit(0)
