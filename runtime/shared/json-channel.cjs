'use strict'

/** Bounded newline transport, shared by the native adapter and LAN helper. */
function channel(socket, receive) {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.setNoDelay(true)
  socket.on('data', chunk => {
    buffer += chunk
    if (buffer.length > 256 * 1024) return socket.destroy()
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try { receive(JSON.parse(line)) } catch { socket.destroy(); return }
    }
  })
  return message => {
    if (socket.destroyed || socket.writableLength > 256 * 1024) return false
    socket.write(JSON.stringify(message) + '\n')
    return true
  }
}
module.exports = { channel }
