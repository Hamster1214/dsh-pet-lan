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
let currentKey = ''
let physics = PetShared.DEFAULT_PHYSICS
let scale = 1
let squashAnimation = null

/** Exact duck sound from dsh-whale-widget (Ya1 = press, Ya2 = release). */
const duckPressUrl = new URL('../../assets/duck-press.mp3', location.href).href
const duckReleaseUrl = new URL('../../assets/duck-release.mp3', location.href).href

function playDuckPress() {
  try {
    const press = new Audio(duckPressUrl)
    press.volume = 0.75
    void press.play().catch(() => {})
  } catch {
    // Audio may be unavailable; the interaction still works.
  }
}

function playDuckRelease() {
  try {
    const release = new Audio(duckReleaseUrl)
    release.volume = 0.75
    void release.play().catch(() => {})
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
  physics = state.physics || physics
  scale = state.scale || 1
  document.getElementById('stage').style.transform = 'translateY(' + (state.bottomPad || 0) + 'px)'
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
  currentKey = typeof state.key === 'string' ? state.key : ''
  applySize(state)
  tagName.textContent = state.name || ''
  applyFacing(state.facing)
  applyAnimation(state.animUrl)
  applyBubble(state)
}

window.petLan.onState(applyState)
window.petLan.onLand(({ squash }) => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const stage = document.getElementById('stage')
  squashAnimation?.cancel()
  squashAnimation = stage.animate(Array.from({ length: 31 }, (_, i) => ({
    scale: '1 ' + PetShared.squashScale(i / 30, squash), offset: i / 30,
  })), { duration: PetShared.SQ_DURATION_MS })
})

/* Click = squash + squeak; drag = move the window; flick = throw with bounce.
   The renderer reports pointer screen positions; the main process moves the
   window and runs the bounce physics. */
petEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  dragging = true
  dragMoved = false
  playDuckPress()
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
  dragSamples = PetShared.trimTrail(dragSamples, now)
  window.petLan.dragMove(event.screenX, event.screenY)
})

function endDrag(event, cancelled) {
  if (!dragging) return
  dragging = false
  petEl.classList.remove('dragging')
  playDuckRelease()
  if (cancelled) {
    window.petLan.dragCancel()
    return
  }

  const now = performance.now()
  if (!dragMoved) {
    squashPet()
    if (currentKey !== '') window.petLan.poke(currentKey)
    window.petLan.dragCancel()
    return
  }

  const velocity = PetShared.estimateReleaseVelocity(
    dragSamples.map(sample => ({ ...sample, x: sample.x / scale, y: sample.y / scale })), now, physics)
  window.petLan.dragEnd({ vx: (velocity?.vx || 0) * scale, vy: (velocity?.vy || 0) * scale })
}

window.addEventListener('pointerup', (event) => endDrag(event, false))
window.addEventListener('pointercancel', (event) => endDrag(event, true))

window.petLan.ready()
