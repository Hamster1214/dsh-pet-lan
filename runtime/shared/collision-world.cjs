'use strict'
const S = require('./pet-core.cjs')

/** One contact per pair; static overlaps never create energy or teleport pets. */
class CollisionWorld {
  constructor() { this.contacts = new Map(); this.pending = new Set(); this.generation = 0 }
  clear() { this.contacts.clear(); this.generation++; this.pending.clear() }
  step(bodies, commit) {
    const live = new Set()
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j]
      const key = JSON.stringify([a.id, b.id].sort())
      if (!S.rectsOverlap(S.bodyPixelBox(a), S.bodyPixelBox(b))) continue
      live.add(key)
      if (a.busy || b.busy || (!a.flying && !b.flying) || this.contacts.has(key) || this.pending.has(a.id) || this.pending.has(b.id)) continue
      const hit = S.collidePet(a, b)
      if (!hit) continue
      this.contacts.set(key, true)
      this.pending.add(a.id); this.pending.add(b.id)
      const generation = this.generation
      Promise.resolve(commit(a, b, hit)).catch(() => false).then(accepted => {
        if (generation !== this.generation) return
        this.pending.delete(a.id); this.pending.delete(b.id)
        if (!accepted) this.contacts.delete(key)
      })
    }
    for (const key of this.contacts.keys()) if (!live.has(key)) this.contacts.delete(key)
  }
}
module.exports = { CollisionWorld }
