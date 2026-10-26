'use strict'
const S = require('./pet-core.cjs')

function spaceFor(size, displays, scale = 1) {
  const rect = a => ({ x: a.x / scale, y: a.y / scale, width: a.width / scale, height: a.height / scale })
  const areas = displays.map(d => rect(process.platform === 'darwin'
    ? { ...d.workArea, y: d.bounds.y, height: d.workArea.y + d.workArea.height - d.bounds.y } : d.workArea))
  return S.throwSpace({ areas, panels: displays.map(d => rect(d.bounds)), size: size / scale, sideAllow: size / scale * S.HIT_BOX.x0 / 640 })
}

function advance(body, size, displays, physics, dt, scale = 1) {
  const space = spaceFor(size, displays, scale)
  let state = { x: body.x / scale, y: body.y / scale, vx: body.vx / scale, vy: body.vy / scale }
  const steps = S.throwSubsteps(state.vx, state.vy, dt)
  let landed = false, squash = 1, grounded = !!body.grounded
  for (let i = 0; i < steps; i++) {
    const fallingVy = state.vy
    state = S.throwStepRegion(state, dt / steps, space, physics, body.lockScreen ?? -1)
    const bounds = space.bounds[state.screen] || space.bounds[0]
    const onFloor = bounds ? state.y >= bounds.maxY - 1 : false
    if (state.bounced && onFloor && !grounded) { landed = true; squash = S.landingSquash(fallingVy) }
    grounded = onFloor
    if (state.atRest) break
  }
  return { x: state.x * scale, y: state.y * scale, vx: state.vx * scale, vy: state.vy * scale,
    atRest: state.atRest, grounded, landed, squash }
}
module.exports = { spaceFor, advance }
