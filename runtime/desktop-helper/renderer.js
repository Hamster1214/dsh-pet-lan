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

/* Drag: the renderer reports the pointer's screen position; the main process
   moves the window. The pet keeps following even when the window moves under
   the cursor because the pointer is captured. */
petEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  dragging = true
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
  window.petLan.dragMove(event.screenX, event.screenY)
})

function endDrag() {
  if (!dragging) return
  dragging = false
  petEl.classList.remove('dragging')
  window.petLan.dragEnd()
}

window.addEventListener('pointerup', endDrag)
window.addEventListener('pointercancel', endDrag)

window.petLan.ready()
