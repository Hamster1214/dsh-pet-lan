/**
 * dsh-pet live-state hook installer.
 *
 * Adds a tiny, idempotent reporting layer to the installed @linxin666/dsh-pet
 * (0.3.7) so the LAN plugin can broadcast what a pet is *doing* — current
 * animation, facing, bubble text and meme image — not just where it is.
 *
 * Patched files (originals are backed up once as `<file>.dsh-pet-lan.bak`):
 *   - runtime/electron-helper/sprite.js  : reports the sprite's live state
 *   - runtime/electron-helper/preload.js : exposes petBridge.reportLive
 *   - runtime/electron-helper/main.js    : writes $DSH_HOME/dsh-pet/desktop-live.json
 *   - lib/client.js                      : adds data-anim / data-bubble attrs
 *                                          for browser-rendered pets
 *
 * Usage:
 *   node scripts/patch-dsh-pet.mjs [path-to-dsh-pet]
 *
 * Re-run after every dsh-pet update; already-patched files are skipped.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = process.env.DSH_PROFILE || 'desktop'
const candidates = [
  process.argv[2],
  process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules', 'dsh-pet') : undefined,
  join(home, 'profiles', profile, 'node_modules', 'dsh-pet'),
]

function resolvePackageRoot() {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
      if (manifest.name === 'dsh-pet') return candidate
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

const root = resolvePackageRoot()
if (!root) {
  console.error('[patch-dsh-pet] dsh-pet package not found; pass its path as the first argument')
  process.exit(1)
}

function backup(file) {
  const bak = file + '.dsh-pet-lan.bak'
  if (!existsSync(bak)) copyFileSync(file, bak)
}

function patchFile(relative, marker, apply) {
  const file = join(root, relative)
  if (!existsSync(file)) {
    console.warn('[patch-dsh-pet] missing ' + relative)
    return false
  }
  const source = readFileSync(file, 'utf8')
  if (source.includes(marker)) {
    console.log('[patch-dsh-pet] already patched: ' + relative)
    return false
  }
  const next = apply(source)
  if (typeof next !== 'string' || next === source) {
    throw new Error('anchor not found in ' + relative)
  }
  backup(file)
  writeFileSync(file, next, 'utf8')
  console.log('[patch-dsh-pet] patched: ' + relative)
  return true
}

/** preload: expose reportLive. */
patchFile('runtime/electron-helper/preload.js', 'pet-lan-live', (source) => source.replace(
  `  setInputRegions(input) {
    ipcRenderer.send('pet:input-regions', input);
  },`,
  `  setInputRegions(input) {
    ipcRenderer.send('pet:input-regions', input);
  },
  // dsh-pet-lan: live sprite state (anim/facing/bubble/meme) for the LAN plugin.
  reportLive(state) {
    ipcRenderer.send('pet-lan-live', state);
  },`,
))

/** main: write the latest state of each pet to a small JSON file. */
patchFile('runtime/electron-helper/main.js', 'pet-lan-live', (source) => source.replace(
  `  ipcMain.on('pet:open-site', (event, payload) => {`,
  `  // dsh-pet-lan: the LAN plugin reads this file to broadcast what each pet is
  // doing. One small document, rewritten only when a sprite reports a change.
  ipcMain.on('pet-lan-live', (event, state) => {
    if (!state || typeof state !== 'object' || typeof state.petId !== 'string') return;
    try {
      const path = require('node:path');
      const fs = require('node:fs');
      const os = require('node:os');
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const dir = path.join(home, 'dsh-pet');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'desktop-live.json');
      let doc = {};
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (!doc || typeof doc !== 'object') doc = {};
      doc[state.petId] = {
        anim: String(state.anim || '').slice(0, 60),
        facing: state.facing === 'right' ? 'right' : 'left',
        bubble: String(state.bubble || '').slice(0, 120),
        image: String(state.image || '').slice(0, 60),
        at: Date.now(),
      };
      fs.writeFileSync(file, JSON.stringify(doc));
    } catch {}
  });

  ipcMain.on('pet:open-site', (event, payload) => {`,
))

/** sprite: report the current state every 500 ms, only when it changed. */
patchFile('runtime/electron-helper/sprite.js', 'lanLiveSig', (source) => {
  const withTimer = source.replace(
    `    this.pet = pet; // 这只宠物的配置段（拍平后的成品实例，条目级字段已吹入：动画池/权重/周期）`,
    `    this.pet = pet; // 这只宠物的配置段（拍平后的成品实例，条目级字段已吹入：动画池/权重/周期）
    // dsh-pet-lan: report live state (animation / facing / bubble / meme) to the
    // LAN plugin through the preload bridge. Change-only, 500 ms cadence.
    this.lanLiveSig = '';
    this.lanLiveTimer = window.setInterval(() => this.reportLiveState(), 500);`,
  )
  return withTimer.replace(
    `  renderBubble() {`,
    `  // dsh-pet-lan: the bubble slot decides what counts as "saying something".
  liveSlot() {
    const workOn = !!(this.workOn && this.workText);
    const whisperOn = !!(this.whisperOn && this.whisperText);
    const balanceOn = !!(this.bubbleOn && this.balanceView);
    const workTerminal = this.workState === 'success' || this.workState === 'error';
    return workTerminal && workOn ? 'work' : whisperOn ? 'whisper' : balanceOn ? 'balance' : workOn ? 'work' : 'none';
  }

  reportLiveState() {
    if (!window.petBridge || typeof window.petBridge.reportLive !== 'function') return;
    const slot = this.liveSlot();
    const bubble = slot === 'whisper' || slot === 'work' ? (slot === 'whisper' ? this.whisperText : this.workText) || '' : '';
    const image = slot === 'whisper' ? this.whisperImage || '' : '';
    const sig = this.anim + '|' + this.facing + '|' + slot + '|' + bubble + '|' + image;
    if (sig === this.lanLiveSig) return;
    this.lanLiveSig = sig;
    try {
      window.petBridge.reportLive({
        petId: this.pet.id,
        anim: this.anim,
        facing: this.facing,
        bubble,
        image,
        at: Date.now(),
      });
    } catch {}
  }

  renderBubble() {`,
  )
})

/** client bundle: mirror the same state into DOM attributes (browser mode). */
patchFile('lib/client.js', 'data-pet-id', (source) => {
  const anchor = `\t\treturn h("div", {
\t\t\tref: rootRef,
\t\t\tclassName: "dsh-pet-root",
\t\t\t"data-corner": corner,
\t\t\t"data-facing": facing,`
  if (!source.includes(anchor)) throw new Error('client root anchor not found')
  return source.replace(
    anchor,
    `\t\tconst lanBubbleText = whisperBubbleOn && whisperText ? whisperText : (workBubbleOn && workText && cfg.workStatusEnabled ? workText : "");
\t\tconst lanBubbleImage = whisperBubbleOn && whisperText && whisperImage ? whisperImage : "";
${anchor}
\t\t\t"data-pet-id": cfg.id,
\t\t\t"data-anim": anim,
\t\t\t"data-bubble": lanBubbleText,
\t\t\t"data-bubble-image": lanBubbleImage,`,
  )
})

console.log('[patch-dsh-pet] done for ' + root)
