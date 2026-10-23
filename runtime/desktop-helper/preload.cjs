'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petLan', {
  ready() {
    ipcRenderer.send('pet-lan-ready')
  },
  onState(callback) {
    ipcRenderer.on('pet-lan-state', (_event, state) => callback(state))
  },
  dragStart(screenX, screenY) {
    ipcRenderer.send('pet-lan-drag-start', { screenX, screenY })
  },
  dragMove(screenX, screenY) {
    ipcRenderer.send('pet-lan-drag-move', { screenX, screenY })
  },
  dragEnd(payload) {
    ipcRenderer.send('pet-lan-drag-end', payload || {})
  },
  dragCancel() {
    ipcRenderer.send('pet-lan-drag-cancel')
  },
  poke(key) {
    ipcRenderer.send('pet-lan-poke', String(key || ''))
  },
})
