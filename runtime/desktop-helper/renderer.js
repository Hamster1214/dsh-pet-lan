'use strict'

const petEl = document.getElementById('pet')
const bubbleEl = document.getElementById('bubble')
const bubbleImage = document.getElementById('bubble-image')
const bubbleText = document.getElementById('bubble-text')
const tagName = document.getElementById('tag-name')
const videos = [document.getElementById('v0'), document.getElementById('v1')]
const fallback = document.getElementById('fallback')

let front = 0
let currentUrl = null
let dragging = false
let dragStartX = 0
let dragStartY = 0
let dragMoved = false
let dragSamples = []

/** Lazily-created WebAudio context for the rubber-duck squeak. */
let duckAudio = null

function playDuck() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (Ctor === undefined) return
    if (duckAudio === null) duckAudio = new Ctor()
    const ctx = duckAudio
    if (ctx.state === 'suspended') void ctx.resume()
    const now = ctx.currentTime + 0.005

    const out = ctx.createGain()
    out.gain.setValueAtTime(0.0001, now)
    out.gain.linearRampToValueAtTime(0.2, now + 0.01)
    out.gain.exponentialRampToValueAtTime(0.0001, now + 0.22)
    out.connect(ctx.destination)

    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(1150, now)
    filter.frequency.exponentialRampToValueAtTime(1750, now + 0.06)
    filter.Q.value = 1.2
    filter.connect(out)

    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(620, now)
    osc.frequency.exponentialRampToValueAtTime(980, now + 0.055)
    osc.frequency.exponentialRampToValueAtTime(430, now + 0.21)
    osc.connect(filter)
    osc.start(now)
    osc.stop(now + 0.23)

    const body = ctx.createOscillator()
    body.type = 'square'
    body.frequency.setValueAtTime(240, now)
    body.frequency.exponentialRampToValueAtTime(150, now + 0.18)
    const bodyGain = ctx.createGain()
    bodyGain.gain.setValueAtTime(0.05, now)
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.19)
    body.connect(bodyGain)
    bodyGain.connect(ctx.destination)
    body.start(now)
    body.stop(now + 0.2)
  } catch {
    // Audio may be unavailable; the interaction still works.
  }
}

function squashPet() {
  petEl.classList.remove('is-squash')
  void petEl.offsetWidth
  petEl.classList.add('is-squash')
}

petEl.addEventListener('animationend', (event) => {
  if (event.animationName === 'pet-squash') petEl.classList.remove('is-squash')
})

function applySize(state) {
  petEl.style.width = state.size + 'px'
  petEl.style.height = state.height + 'px'
  fallback.style.fontSize = Math.round(state.size * 0.26) + 'px'
}

function applyFacing(facing) {
  const transform = facing === 'right' ? 'scaleX(-1)' : ''
  for (const video of videos) video.style.transform = transform
}

function applyAnimation(url) {
  if (url === null || url === undefined || url === '') {
    for (const video of videos) video.classList.remove('is-front')
    fallback.style.display = 'flex'
    currentUrl = null
    return
  }
  if (url === currentUrl) return
  currentUrl = url
  const target = videos[1 - front]
  const previous = videos[front]
  target.classList.remove('is-front')
  target.src = url
  const onReady = () => {
    target.removeEventListener('loadeddata', onReady)
    target.play().catch(() => {})
    target.classList.add('is-front')
    previous.classList.remove('is-front')
    fallback.style.display = 'none'
    front = 1 - front
  }
  target.addEventListener('loadeddata', onReady)
  target.load()
}

function applyBubble(state) {
  const text = typeof state.bubble === 'string' ? state.bubble : ''
  const hasText = text !== ''
  bubbleEl.classList.toggle('is-on', hasText)
  bubbleText.textContent = text
  if (hasText && typeof state.imageUrl === 'string' && state.imageUrl !== '') {
    bubbleImage.src = state.imageUrl
    bubbleImage.style.display = 'block'
  } else {
    bubbleImage.removeAttribute('src')
    bubbleImage.style.display = 'none'
  }
}

function applyState(state) {
  if (state === null || typeof state !== 'object') return
  applySize(state)
  tagName.textContent = state.name || ''
  applyFacing(state.facing)
  applyAnimation(state.animUrl)
  applyBubble(state)
}

window.petLan.onState(applyState)

/* Click = squash + squeak; drag = move the window; flick = throw with bounce.
   The renderer reports pointer screen positions; the main process moves the
   window and runs the bounce physics. */
petEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  dragging = true
  dragMoved = false
  dragStartX = event.screenX
  dragStartY = event.screenY
  dragSamples = [{ x: event.screenX, y: event.screenY, t: performance.now() }]
  petEl.classList.add('dragging')
  try {
    petEl.setPointerCapture(event.pointerId)
  } catch {
    // Older Chromium: window-level move/up still work.
  }
  window.petLan.dragStart(event.screenX, event.screenY)
})

window.addEventListener('pointermove', (event) => {
  if (!dragging) return
  const dx = event.screenX - dragStartX
  const dy = event.screenY - dragStartY
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragMoved = true
  const now = performance.now()
  dragSamples.push({ x: event.screenX, y: event.screenY, t: now })
  if (dragSamples.length > 10) dragSamples.shift()
  window.petLan.dragMove(event.screenX, event.screenY)
})

function endDrag(event, cancelled) {
  if (!dragging) return
  dragging = false
  petEl.classList.remove('dragging')
  if (cancelled) {
    window.petLan.dragCancel()
    return
  }

  const now = performance.now()
  dragSamples.push({ x: event.screenX, y: event.screenY, t: now })
  if (!dragMoved) {
    squashPet()
    playDuck()
    window.petLan.dragCancel()
    return
  }

  const recent = dragSamples.filter((sample) => now - sample.t <= 140)
  const first = recent[0] ?? dragSamples[0]
  const last = recent[recent.length - 1] ?? dragSamples[dragSamples.length - 1]
  const dt = (last.t - first.t) / 1000
  const vx = dt > 0 ? Math.max(-2500, Math.min(2500, (last.x - first.x) / dt)) : 0
  const vy = dt > 0 ? Math.max(-2500, Math.min(2500, (last.y - first.y) / dt)) : 0
  window.petLan.dragEnd({ vx, vy })
}

window.addEventListener('pointerup', (event) => endDrag(event, false))
window.addEventListener('pointercancel', (event) => endDrag(event, true))

window.petLan.ready()
