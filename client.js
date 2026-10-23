/**
 * dsh-pet-lan browser half — shows every pet discovered on the LAN.
 *
 * The host half broadcasts a presence datagram per machine; this module polls
 * '/api/pet-lan', reads the local pet list from dsh-pet's own public config
 * route ('/dsh-pet-7340/config'), and paints one floating sprite per peer in
 * `shell.overlay`.
 *
 * Rendering reuses the local machine's copy of the same pet: the animation
 * files are served by dsh-pet from '/dsh-pet-7340/thumb/<assetRoot>/<anim>.webm',
 * so a peer running the built-in pet looks exactly like it does on its owner's
 * screen. A pet kind this machine does not have installed degrades to a paw
 * badge with the owner's name instead of disappearing.
 *
 * Interactions go through dsh-pet's public action endpoints, so the pet
 * package stays untouched: a wave makes the remote machine's own pet speak
 * ('/broadcast') and play a greeting animation ('/anim').
 *
 * @module dsh-pet-lan/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-pet-lan',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /** Locale namespace of this plugin. */
    const NS = 'pet-lan'

    /** dsh-pet's public browser API (the pet owns these routes). */
    const PET_BASE = '/dsh-pet-7340'
    const PET_CONFIG_URL = PET_BASE + '/config'

    /** Exact duck sound from dsh-whale-widget (Ya1 = press, Ya2 = release). */
    const DUCK_PRESS_URL = '/api/pet-lan/audio/duck-press.mp3'
    const DUCK_RELEASE_URL = '/api/pet-lan/audio/duck-release.mp3'

    /** Fallback physics mirrors dsh-pet's defaults; the host sends the local config. */
    const DEFAULT_PHYSICS = {
      gravity: 1400,
      restitution: 0.78,
      groundFriction: 2.5,
      ceilingBounce: true,
      throwPower: 1,
    }

    /** Corner whitelist of dsh-pet's position config. */
    const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left']

    /** Chinese copy (also the fallback when the locale service is unavailable). */
    const zh = {
      nav: '桌宠联机',
      loading: '正在读取联机状态…',
      unavailable: '联机状态不可用',
      retry: '重试',
      enabled: '开启局域网联机',
      room: '房间名',
      roomHint: '只有房间名相同的电脑才会互相看见；换一个房间名就能分组。',
      nickname: '联机昵称',
      nicknameHint: '打招呼时对方看到的名字，留空则用你的桌宠名。',
      mode: '显示方式',
      modeDesktop: '桌面窗口',
      modeBrowser: '浏览器浮层',
      modeBoth: '桌面 + 浏览器',
      modeHint: '桌面窗口可以自由拖拽，位置会记住；Electron 不可用时自动退回浏览器浮层。',
      desktopOn: '桌面窗口已就绪',
      desktopOff: '桌面窗口未启动',
      port: 'UDP 端口',
      portHint: '两台电脑必须一致（默认 41234）。改了会立刻重新监听。',
      shareBubbles: '广播气泡文字',
      shareBubblesHint: '同一局域网的人能看到桌宠气泡里的文字（可能包含对话内容）；关闭后只同步动作、表情和位置。',
      acceptWaves: '接受打招呼',
      acceptWavesHint: '允许别人让你的桌宠说一句短问候并播放打招呼动作。',
      petCollision: '桌宠碰撞',
      petCollisionHint: '桌面窗口：远端桌宠之间、以及和本机 dsh-pet 之间会互相弹开；关闭后只保留抛掷/反弹。',
      save: '保存',
      saved: '已保存，联机立即生效。',
      saveFailed: '保存失败',
      refresh: '刷新',
      status: '状态',
      udpOnline: 'UDP 已监听',
      udpOffline: 'UDP 未监听',
      boundPort: '端口 {port}',
      disabledHint: '联机已关闭：本机桌宠不会广播，也看不到别人。',
      peerCount: '发现 {count} 只桌宠',
      noPeers: '还没发现同房间的桌宠。确认对方也装了本插件、连着同一个 Wi-Fi，并且房间名一致。',
      peers: '局域网里的桌宠',
      wave: '打招呼',
      waveSent: '已向 {name} 打招呼',
      waveIn: '来自 {name} 的问候',
      waveInHost: '来自 {name}（{host}）的问候',
      squashHint: '点击挤压并吱一声；拖动可以抛掷',
      pokeIn: '{name} 捏了你一下',
      pokeText: '{name} 捏了你一下',
      pokeSent: '你捏了 {name} 一下',
      lastSeen: '{n} 秒前在线',
      sent: '已发 {n} 个包',
      received: '已收 {n} 个包',
      lastError: '最近一次错误',
      self: '本机桌宠',
      hint: '同一 Wi-Fi / 局域网内自动发现。首次运行 Windows 可能会弹防火墙提示，需要允许“专用网络”的 UDP 入站；如果公司或访客 Wi-Fi 开了客户端隔离（AP isolation），设备之间互相不可见。',
      petMissing: '本机未安装这个宠物',
      noPets: '本机还没有可广播的桌宠',
      waveText: '来自 {name} 的问候',
    }

    /** English copy. */
    const en = {
      nav: 'Pet LAN',
      loading: 'Reading LAN status…',
      unavailable: 'LAN status unavailable',
      retry: 'Retry',
      enabled: 'Enable LAN co-op',
      room: 'Room',
      roomHint: 'Only machines in the same room see each other. Use a different room to split groups.',
      nickname: 'Display name',
      nicknameHint: 'The name peers see when you wave. Empty = your pet name.',
      mode: 'Display',
      modeDesktop: 'Desktop windows',
      modeBrowser: 'Browser overlay',
      modeBoth: 'Desktop + browser',
      modeHint: 'Desktop windows can be dragged freely and remember their position; the browser overlay is used automatically when Electron is unavailable.',
      desktopOn: 'Desktop windows ready',
      desktopOff: 'Desktop windows not running',
      port: 'UDP port',
      portHint: 'Must match on every machine (default 41234). Changing it rebinds immediately.',
      shareBubbles: 'Broadcast bubble text',
      shareBubblesHint: 'Peers on the LAN can read your pet bubble text (it may contain conversation snippets). Off = sync only animation, meme and position.',
      acceptWaves: 'Accept waves',
      acceptWavesHint: 'Let peers make your pet say a short greeting and play the wave animation.',
      petCollision: 'Pet collision',
      petCollisionHint: 'Desktop windows: remote pets bounce off each other and off your local dsh-pet. Off = throws/bounces only.',
      save: 'Save',
      saved: 'Saved — LAN is live.',
      saveFailed: 'Save failed',
      refresh: 'Refresh',
      status: 'Status',
      udpOnline: 'UDP listening',
      udpOffline: 'UDP not listening',
      boundPort: 'port {port}',
      disabledHint: 'LAN is off: your pets are not announced and no peers are shown.',
      peerCount: '{count} pets discovered',
      noPeers: 'No pets in this room yet. Make sure the other machine runs this plugin, is on the same LAN, and uses the same room.',
      peers: 'Pets on the LAN',
      wave: 'Wave',
      waveSent: 'Waved at {name}',
      waveIn: 'Wave from {name}',
      waveInHost: 'Wave from {name} ({host})',
      squashHint: 'Click to squeak; drag to throw',
      pokeIn: '{name} squished you',
      pokeText: '{name} squished you',
      pokeSent: 'You squished {name}',
      lastSeen: 'seen {n}s ago',
      sent: '{n} packets sent',
      received: '{n} packets received',
      lastError: 'Last error',
      self: 'This machine',
      hint: 'Peers are discovered automatically on the same LAN. Windows may ask for a firewall exception on first run — allow UDP on private networks. Guest/enterprise Wi-Fi with AP isolation blocks discovery.',
      petMissing: 'Pet not installed here',
      noPets: 'No local pet to announce yet',
      waveText: 'Wave from {name}',
    }

    /** Minimal interpolating translator used before/without the locale service. */
    function makeTranslator(dictionary) {
      return (key, params) => {
        const template = typeof dictionary[key] === 'string' ? dictionary[key] : key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (
          params[name] === undefined ? match : String(params[name])
        ))
      }
    }

    const zhT = makeTranslator(zh)
    const enT = makeTranslator(en)

    /** Clamp a number into [min, max]. */
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /** Pick a random element (empty list -> undefined). */
    function pickRandom(list) {
      return list.length === 0 ? undefined : list[Math.floor(Math.random() * list.length)]
    }

    /** Lazily-created WebAudio context for the rubber-duck sound. */
    let duckAudio = null
    let duckLoad = null

    function duckContext() {
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (Ctor === undefined) return null
      if (duckAudio === null) duckAudio = new Ctor()
      return duckAudio
    }

    /** Fetch and decode the two whale-widget duck clips (once). */
    function loadDuck() {
      if (duckLoad !== null) return duckLoad
      duckLoad = Promise.all([
        fetch(DUCK_PRESS_URL, { credentials: 'same-origin', cache: 'force-cache' }).then((r) => {
          if (!r.ok) throw new Error('duck-press HTTP ' + r.status)
          return r.arrayBuffer()
        }),
        fetch(DUCK_RELEASE_URL, { credentials: 'same-origin', cache: 'force-cache' }).then((r) => {
          if (!r.ok) throw new Error('duck-release HTTP ' + r.status)
          return r.arrayBuffer()
        }),
      ]).then(async ([press, release]) => {
        const ctx = duckContext()
        if (ctx === null) throw new Error('no-audio-context')
        return [await ctx.decodeAudioData(press), await ctx.decodeAudioData(release)]
      })
      return duckLoad
    }

    function playBuffer(ctx, buffer) {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      const gain = ctx.createGain()
      gain.gain.value = 0.75
      source.connect(gain)
      gain.connect(ctx.destination)
      source.start()
    }

    /** Play the exact dsh-whale-widget duck press + release clips. */
    function playDuckClip(index) {
      try {
        const ctx = duckContext()
        if (ctx === null) return
        if (ctx.state === 'suspended') void ctx.resume()
        loadDuck().then((clips) => {
          const buffer = clips[index]
          if (buffer !== undefined) playBuffer(ctx, buffer)
        }).catch(() => {
          // Missing audio route/unsupported codec: interaction still works.
        })
      } catch {
        // Audio may be unavailable/blocked; interaction still works.
      }
    }

    /** Ya1: one press clip at pointer/key down. */
    function playDuckPress() {
      playDuckClip(0)
    }

    /** Ya2: one release clip at pointer/key up. */
    function playDuckRelease() {
      playDuckClip(1)
    }

    void loadDuck().catch(() => {})

    /** Replay the squash animation on an element. */
    function squashElement(element) {
      if (element === null || element === undefined) return
      element.classList.remove('is-squash')
      void element.offsetWidth
      element.classList.add('is-squash')
    }

    /** POST JSON and always resolve to a parsed object. */
    async function postJson(path, body) {
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body === undefined ? {} : body),
          credentials: 'same-origin',
          cache: 'no-store',
        })
        const parsed = await response.json().catch(() => null)
        if (parsed !== null && typeof parsed === 'object') return parsed
        return { ok: false, error: 'HTTP ' + response.status }
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
    }

    /* ------------------------------------------------------------------ *
     * Local pet config: the same merged aggregate dsh-pet's own browser
     * half consumes. Flattened here so the host can broadcast it and the
     * overlay can pick a matching animation pool.
     * ------------------------------------------------------------------ */

    let localConfig = null
    let localConfigAt = 0
    let localConfigPromise = null

    /** Fetch dsh-pet's merged config (short TTL so a drag shows up promptly). */
    function loadPetConfig(force) {
      const now = Date.now()
      if (!force && localConfig !== null && now - localConfigAt < 1500) return Promise.resolve(localConfig)
      if (localConfigPromise !== null) return localConfigPromise
      localConfigPromise = fetch(PET_CONFIG_URL, { credentials: 'same-origin', cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((merged) => {
          if (merged !== null && typeof merged === 'object') {
            localConfig = merged
            localConfigAt = Date.now()
          }
          localConfigPromise = null
          return localConfig
        })
        .catch(() => {
          localConfigPromise = null
          return localConfig
        })
      return localConfigPromise
    }

    /**
     * Flatten dsh-pet's `{ main: {...}, pig: {...} }` aggregate into the pet
     * list both halves share. Mirrors the pet's own `flattenConfigPets`.
     */
    function flattenPets(merged) {
      const pets = []
      const entries = new Map()
      if (merged === null || typeof merged !== 'object') return { pets, entries }
      for (const [entry, conf] of Object.entries(merged)) {
        if (conf === null || typeof conf !== 'object') continue
        entries.set(entry, conf)
        if (!Array.isArray(conf.pets)) continue
        for (const pet of conf.pets) {
          if (pet === null || typeof pet !== 'object' || typeof pet.id !== 'string' || pet.id === '') continue
          if (pet.display === 'none') continue
          const position = pet.position !== null && typeof pet.position === 'object' ? pet.position : {}
          const corner = CORNERS.includes(position.corner) ? position.corner : 'bottom-right'
          pets.push({
            id: pet.id,
            name: typeof pet.name === 'string' && pet.name.trim() !== '' ? pet.name.trim().slice(0, 20) : pet.id,
            size: Number.isFinite(pet.size) ? Math.round(pet.size) : 160,
            assetRoot: entry,
            corner,
            marginX: Number.isFinite(position.marginX) ? Math.round(position.marginX) : 24,
            marginY: Number.isFinite(position.marginY) ? Math.round(position.marginY) : 0,
            display: typeof pet.display === 'string' ? pet.display : 'both',
          })
        }
      }
      return { pets, entries }
    }

    /** Every animation name a pet entry can play (idle first, duplicates removed). */
    function animationPool(conf) {
      const pool = []
      const seen = new Set()
      const add = (value) => {
        if (typeof value === 'string') {
          if (value !== '' && !seen.has(value)) {
            seen.add(value)
            pool.push(value)
          }
          return
        }
        if (Array.isArray(value)) {
          for (const item of value) add(item)
        }
      }
      const animations = conf !== null && conf !== undefined ? conf.animations : undefined
      if (animations === null || typeof animations !== 'object') return pool
      add(animations.idle)
      add(animations.clicks)
      add(animations.turn)
      for (const category of Array.isArray(animations.categories) ? animations.categories : []) {
        if (category === null || typeof category !== 'object') continue
        for (const action of Array.isArray(category.actions) ? category.actions : []) {
          if (typeof action === 'string') add(action)
          else if (action !== null && typeof action === 'object') add(action.name)
        }
      }
      return pool
    }

    /**
     * Live state of browser-rendered pets, read from the attributes the
     * dsh-pet patch writes on every `.dsh-pet-root`.
     */
    function readBrowserLive(pets) {
      const out = {}
      for (const pet of pets) {
        let root = null
        try {
          root = document.querySelector('.dsh-pet-root[data-pet-id="' + CSS.escape(pet.id) + '"]')
        } catch {
          root = null
        }
        if (root === null) continue
        const anim = root.getAttribute('data-anim') || ''
        const bubble = root.getAttribute('data-bubble') || ''
        const image = root.getAttribute('data-bubble-image') || ''
        if (anim === '' && bubble === '' && image === '') continue
        out[pet.id] = {
          anim,
          facing: root.getAttribute('data-facing') === 'right' ? 'right' : 'left',
          bubble,
          image,
          at: Date.now(),
        }
      }
      return out
    }

    /** The animation URL dsh-pet serves for one pet kind. */
    function petAssetUrl(assetRoot, anim, ext) {
      return PET_BASE + '/thumb/' + encodeURIComponent(assetRoot) + '/' + encodeURIComponent(anim) + '.' + ext
    }

    /** The meme image URL dsh-pet serves for one pet kind. */
    function memeImageUrl(assetRoot, name) {
      return PET_BASE + '/pic/memes/' + encodeURIComponent(assetRoot) + '/' + encodeURIComponent(name) + '.png'
    }

    /**
     * One shared polling store: the overlay and the settings page subscribe to
     * the same snapshot, so two visible surfaces never double the request rate.
     * Every tick also reports the local pet list to the host (that report is
     * what the UDP presence carries).
     */
    function createLanStore() {
      let state = { data: null, error: null }
      const listeners = new Set()
      let timer = null
      let poseTimer = null
      let inflight = false
      let lastLocalHitSeq = 0
      let localHitInitialized = false

      const publish = (next) => {
        state = next
        for (const listener of [...listeners]) listener()
      }

      const reportLocal = async () => {
        const merged = await loadPetConfig(true)
        if (merged === null) return
        const { pets } = flattenPets(merged)
        // Browser-rendered pets carry their live state in DOM attributes added
        // by the dsh-pet live-state patch (desktop-mode pets have no DOM here;
        // their state reaches the host through the helper's state file).
        const live = readBrowserLive(pets)
        const result = await postJson('/api/pet-lan/local', {
          pets: pets.map((pet) => (live[pet.id] === undefined ? pet : { ...pet, live: live[pet.id] })),
          viewport: { w: window.innerWidth, h: window.innerHeight },
          physics: merged.physics,
        })
        applyLocalHits(result.localHits)
      }

      const throwLocal = (hit) => {
        const petId = typeof hit.petId === 'string' ? hit.petId : ''
        const vx = Number(hit.vx)
        const vy = Number(hit.vy)
        if (petId === '' || !Number.isFinite(vx) || !Number.isFinite(vy)) return
        const speed = Math.hypot(vx, vy)
        if (speed < 20) return
        const physics = localConfig !== null && localConfig.physics !== undefined ? localConfig.physics : null
        const throwPower = physics !== null && Number.isFinite(Number(physics.throwPower)) ? Number(physics.throwPower) : 1
        const power = clamp(speed / (1200 * Math.max(0.1, throwPower)), 0.05, 4)
        const angle = Math.atan2(-vy, vx) * 180 / Math.PI
        void postJson(PET_BASE + '/throw?pet=' + encodeURIComponent(petId) + '&surface=any', { angle, power })
      }

      const applyLocalHits = (hits) => {
        if (!Array.isArray(hits)) return
        if (!localHitInitialized) {
          localHitInitialized = true
          for (const hit of hits) {
            const seq = Number(hit.seq)
            if (Number.isFinite(seq) && seq > lastLocalHitSeq) lastLocalHitSeq = seq
          }
          return
        }
        for (const hit of hits) {
          const seq = Number(hit.seq)
          if (!Number.isFinite(seq) || seq <= lastLocalHitSeq) continue
          lastLocalHitSeq = seq
          throwLocal(hit)
        }
      }

      /** Poll dsh-pet's /pose for the local desktop pet body (collision). */
      const reportPoses = async () => {
        if (localConfig === null) return
        const merged = localConfig
        const { pets } = flattenPets(merged)
        if (pets.length === 0) return
        const bodies = []
        for (const pet of pets.slice(0, 5)) {
          try {
            const response = await fetch(PET_BASE + '/pose?pet=' + encodeURIComponent(pet.id), {
              credentials: 'same-origin',
              cache: 'no-store',
            })
            if (!response.ok) continue
            const pose = await response.json()
            if (pose === null || pose.ok !== true) continue
            const nx = Number(pose.x)
            const ny = Number(pose.y)
            if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) continue
            // Normalized center: the desktop helper maps it against the real
            // multi-monitor work-area hull (the browser only knows one screen).
            bodies.push({ id: pet.id, size: pet.size, nx, ny })
          } catch {
            // The local pet may not be in desktop mode; collision is optional.
          }
        }
        const result = await postJson('/api/pet-lan/local', {
          bodies,
          physics: merged.physics,
          viewport: { w: window.innerWidth, h: window.innerHeight },
        })
        applyLocalHits(result.localHits)
      }

      const tick = async () => {
        if (inflight) return
        inflight = true
        try {
          await reportLocal()
          const query = '?w=' + window.innerWidth + '&h=' + window.innerHeight
          const response = await fetch('/api/pet-lan' + query, {
            credentials: 'same-origin',
            cache: 'no-store',
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const data = await response.json()
          publish({ data, error: null })
          applyLocalHits(data.localHits)
        } catch (error) {
          publish({ data: state.data, error: String(error && error.message ? error.message : error) })
          // The pet config may be missing before dsh-pet mounts; keep retrying.
          void reportLocal()
        } finally {
          inflight = false
        }
      }

      const onVisibility = () => {
        if (document.visibilityState === 'visible') {
          void tick()
          void reportPoses()
        }
      }

      const start = () => {
        if (timer !== null) return
        void tick()
        void reportPoses()
        timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') void tick()
        }, 2000)
        poseTimer = window.setInterval(() => {
          // Pose reporting must not stop just because the overlay returns null
          // in desktop mode or the DSH page is covered by the pet windows.
          void reportPoses()
        }, 200)
        document.addEventListener('visibilitychange', onVisibility)
      }

      const stop = () => {
        if (timer === null) return
        window.clearInterval(timer)
        window.clearInterval(poseTimer)
        timer = null
        poseTimer = null
        document.removeEventListener('visibilitychange', onVisibility)
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          start()
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) stop()
          }
        },
        getSnapshot() {
          return state
        },
        refresh: tick,
        wave(node) {
          return postJson('/api/pet-lan/wave', { node })
        },
        poke(node, petId) {
          return postJson('/api/pet-lan/poke', { node, petId })
        },
        save(config) {
          return postJson('/api/pet-lan/config', config)
        },
      }
    }

    const store = createLanStore()
    // Keep the polling store alive independently of the overlay/settings pages:
    // in desktop mode the overlay returns null, and React may unmount it while
    // the local pose still has to be reported for collisions.
    const releaseStore = store.subscribe(() => {})

    /** Viewport size, refreshed on resize (remote positions are relative). */
    function useViewport() {
      const [size, setSize] = useState([window.innerWidth, window.innerHeight])
      useEffect(() => {
        const onResize = () => setSize([window.innerWidth, window.innerHeight])
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])
      return size
    }

    /**
     * One remote animation clip. Files are fetched as blobs (the same approach
     * dsh-pet uses) so the alpha WebM plays without the server's streaming
     * hiccups; '.mov' covers macOS Safari builds of the pet assets.
     */
    function RemoteClip(props) {
      const { assetRoot, anim, width, height, mirror, onFailed } = props
      const ref = useRef(null)
      const [failed, setFailed] = useState(false)

      useEffect(() => {
        let alive = true
        let objectUrl = null
        const controller = new AbortController()

        const load = async () => {
          for (const ext of ['webm', 'mov']) {
            try {
              const response = await fetch(petAssetUrl(assetRoot, anim, ext), {
                cache: 'default',
                signal: controller.signal,
              })
              if (!response.ok) continue
              const blob = await response.blob()
              if (!alive) return
              objectUrl = URL.createObjectURL(blob)
              setFailed(false)
              if (ref.current !== null) {
                ref.current.src = objectUrl
                ref.current.load()
                ref.current.play().catch(() => {})
              }
              return
            } catch {
              // try the next extension
            }
          }
          if (alive) {
            setFailed(true)
            if (typeof onFailed === 'function') onFailed()
          }
        }

        setFailed(false)
        void load()
        return () => {
          alive = false
          controller.abort()
          if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
        }
      }, [assetRoot, anim])

      if (failed) return null
      return h('video', {
        ref,
        className: 'dsh-pet-lan-video',
        muted: true,
        autoPlay: true,
        loop: true,
        playsInline: true,
        style: { width: Math.round(width) + 'px', height: Math.round(height) + 'px', transform: mirror ? 'scaleX(-1)' : 'none' },
        'aria-hidden': 'true',
      })
    }

    /** Fallback badge for a pet kind this machine does not have installed. */
    function UnknownPet(props) {
      const { size, name } = props
      return h('div', {
        className: 'dsh-pet-lan-avatar',
        style: { width: Math.round(size) + 'px', height: Math.round(size) + 'px', fontSize: Math.round(size * 0.3) + 'px' },
        title: name,
        'aria-hidden': 'true',
      }, '🐾')
    }

    /** One peering pet: position, animation, name tag and wave gesture. */
    function RemotePet(props) {
      const { peer, pet, entry, factor, viewport, onWave, onPoke, t, physics } = props
      const [windowWidth, windowHeight] = viewport
      const size = clamp(Math.round(pet.size * factor), 80, 260)
      const height = Math.round(size * 9 / 16)
      const poolRef = useRef([])
      poolRef.current = useMemo(() => animationPool(entry), [entry])
      const [anim, setAnim] = useState(() => pickRandom(poolRef.current))
      const [override, setOverride] = useState(null)
      const [missing, setMissing] = useState(false)
      const [deadAnim, setDeadAnim] = useState(null)
      const live = pet.live !== null && typeof pet.live === 'object' ? pet.live : null
      const liveAnim = live !== null && typeof live.anim === 'string' && live.anim !== '' ? live.anim : null
      const liveBubble = live !== null && typeof live.bubble === 'string' ? live.bubble : ''
      const liveImage = live !== null && typeof live.image === 'string' ? live.image : ''
      const mirror = live !== null && live.facing === 'right'
      const [dragPos, setDragPos] = useState(null)
      const dragRef = useRef(null)
      const posRef = useRef(null)
      const throwRef = useRef(0)
      const boxRef = useRef(null)

      // A different pet kind (or a repaired asset) should get another chance.
      useEffect(() => {
        setMissing(false)
        setDeadAnim(null)
      }, [pet.assetRoot])

      // Change the idle clip every 7-14 s so a peer's pet does not look frozen.
      // The pool is read through a ref: a config refresh must not restart the
      // timer, or it would never fire while the page polls every 2 s.
      useEffect(() => {
        if (poolRef.current.length === 0) return undefined
        let timer = 0
        const schedule = () => {
          timer = window.setTimeout(() => {
            setAnim(pickRandom(poolRef.current))
            schedule()
          }, 7000 + Math.random() * 7000)
        }
        schedule()
        return () => window.clearTimeout(timer)
      }, [pet.assetRoot, pet.id])

      useEffect(() => {
        if (override === null) return undefined
        const timer = window.setTimeout(() => setOverride(null), 3200)
        return () => window.clearTimeout(timer)
      }, [override])

      // The config may land one tick after the first peer: adopt an idle clip
      // as soon as a pool exists instead of waiting for the rotation timer.
      useEffect(() => {
        if (anim === undefined && poolRef.current.length > 0) setAnim(pickRandom(poolRef.current))
      }, [anim, entry])

      // Recompute anchor offsets on every render: the owner may drag the pet
      // and the next report moves it here too. Clamp so a peer's wider window
      // never parks its pet outside our viewport.
      const offsetX = clamp(Math.round(pet.marginX * factor), 0, Math.max(0, windowWidth - size))
      const offsetY = clamp(Math.round(pet.marginY * factor), 0, Math.max(0, windowHeight - height))
      const style = { width: size + 'px', height: height + 'px' }
      if (dragPos !== null) {
        style.left = dragPos.x + 'px'
        style.top = dragPos.y + 'px'
        style.transition = 'none'
      } else if (pet.corner === 'bottom-right') {
        style.right = offsetX + 'px'
        style.bottom = offsetY + 'px'
      } else if (pet.corner === 'bottom-left') {
        style.left = offsetX + 'px'
        style.bottom = offsetY + 'px'
      } else if (pet.corner === 'top-right') {
        style.right = offsetX + 'px'
        style.top = offsetY + 'px'
      } else {
        style.left = offsetX + 'px'
        style.top = offsetY + 'px'
      }

      const wanted = override !== null ? override : (liveAnim !== null ? liveAnim : anim)
      // A live animation the local copy does not have (peer on a newer pet
      // pack) degrades to one of our own idle clips instead of a paw badge.
      const current = deadAnim !== null && wanted === deadAnim
        ? (poolRef.current[0] !== undefined ? poolRef.current[0] : undefined)
        : wanted
      const hasArt = entry !== null && entry !== undefined && poolRef.current.length > 0

      useEffect(() => () => {
        if (throwRef.current !== 0) cancelAnimationFrame(throwRef.current)
        throwRef.current = 0
      }, [])

      const cancelThrow = () => {
        if (throwRef.current !== 0) {
          cancelAnimationFrame(throwRef.current)
          throwRef.current = 0
        }
      }

      /** Throw the pet from `pos` with a screen-pixel velocity; bounce on edges. */
      const startThrow = (pos, vx, vy) => {
        cancelThrow()
        const model = physics ?? DEFAULT_PHYSICS
        const gravity = Number.isFinite(Number(model.gravity)) ? Number(model.gravity) : DEFAULT_PHYSICS.gravity
        const restitution = Number.isFinite(Number(model.restitution)) ? Number(model.restitution) : DEFAULT_PHYSICS.restitution
        const groundFriction = Number.isFinite(Number(model.groundFriction)) ? Number(model.groundFriction) : DEFAULT_PHYSICS.groundFriction
        const ceilingBounce = model.ceilingBounce !== false
        const throwPower = Number.isFinite(Number(model.throwPower)) ? Number(model.throwPower) : DEFAULT_PHYSICS.throwPower
        const maxX = Math.max(0, windowWidth - size)
        const maxY = Math.max(0, windowHeight - height)
        let x = clamp(pos.x, 0, maxX)
        let y = clamp(pos.y, 0, maxY)
        let vx2 = clamp(vx * throwPower, -2600, 2600)
        let vy2 = clamp(vy * throwPower, -2600, 2600)
        if (Math.hypot(vx2, vy2) < 80) {
          posRef.current = { x, y }
          setDragPos({ x, y })
          return
        }
        let last = performance.now()
        const tick = (frameTime) => {
          const dt = Math.min(0.033, Math.max(0.001, (frameTime - last) / 1000))
          last = frameTime
          vy2 += gravity * dt
          x += vx2 * dt
          y += vy2 * dt
          if (x < 0) {
            x = 0
            vx2 = Math.abs(vx2) * restitution
          } else if (x > maxX) {
            x = maxX
            vx2 = -Math.abs(vx2) * restitution
          }
          if (y < 0) {
            if (ceilingBounce) {
              y = 0
              vy2 = Math.abs(vy2) * restitution
            }
          } else if (y >= maxY) {
            y = maxY
            vx2 *= Math.max(0, 1 - groundFriction * dt)
            if (Math.abs(vy2) < 40) vy2 = 0
            else vy2 = -Math.abs(vy2) * restitution
          }
          posRef.current = { x, y }
          setDragPos({ x, y })
          if (y >= maxY - 1 && Math.abs(vy2) < 1 && Math.abs(vx2) < 15) {
            throwRef.current = 0
            return
          }
          throwRef.current = requestAnimationFrame(tick)
        }
        throwRef.current = requestAnimationFrame(tick)
      }

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        cancelThrow()
        playDuckPress()
        const rect = event.currentTarget.getBoundingClientRect()
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startT: performance.now(),
          originX: rect.left,
          originY: rect.top,
          moved: false,
          samples: [{ x: event.clientX, y: event.clientY, t: performance.now() }],
        }
        posRef.current = { x: rect.left, y: rect.top }
        setDragPos({ x: rect.left, y: rect.top })
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // Pointer capture is an optimization; window-level events still work.
        }
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        const now = performance.now()
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true
        const x = clamp(drag.originX + dx, 0, Math.max(0, windowWidth - size))
        const y = clamp(drag.originY + dy, 0, Math.max(0, windowHeight - height))
        posRef.current = { x, y }
        setDragPos({ x, y })
        drag.samples.push({ x: event.clientX, y: event.clientY, t: now })
        if (drag.samples.length > 10) drag.samples.shift()
      }

      const onPointerUp = (event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        dragRef.current = null
        playDuckRelease()
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          // Already released.
        }
        const now = performance.now()
        drag.samples.push({ x: event.clientX, y: event.clientY, t: now })
        const current = posRef.current ?? { x: drag.originX, y: drag.originY }
        if (!drag.moved) {
          squashElement(boxRef.current)
          onPoke(peer, pet)
          posRef.current = current
          setDragPos(current)
          return
        }
        const recent = drag.samples.filter((sample) => now - sample.t <= 140)
        const first = recent[0] ?? drag.samples[0]
        const last = recent[recent.length - 1] ?? drag.samples[drag.samples.length - 1]
        const dt = (last.t - first.t) / 1000
        const vx = dt > 0 ? clamp((last.x - first.x) / dt, -2500, 2500) : 0
        const vy = dt > 0 ? clamp((last.y - first.y) / dt, -2500, 2500) : 0
        startThrow(current, vx, vy)
      }

      const onPointerCancel = (event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        dragRef.current = null
        playDuckRelease()
        setDragPos(null)
      }

      return h('div', {
        className: 'dsh-pet-lan-pet',
        style,
        title: pet.name + ' · ' + peer.host,
        role: 'button',
        tabIndex: 0,
        'aria-label': pet.name + ' — ' + t('squashHint'),
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (event.repeat) return
            squashElement(boxRef.current)
            playDuckPress()
            onPoke(peer, pet)
          }
        },
        onKeyUp: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            playDuckRelease()
          }
        },
      }, [
        h('div', { key: 'tag', className: 'dsh-pet-lan-tag' }, [
          h('span', { key: 'dot', className: 'dsh-pet-lan-dot' }),
          h('span', { key: 'name', className: 'dsh-pet-lan-tag-name' }, pet.name),
          h('button', {
            key: 'wave',
            type: 'button',
            className: 'dsh-pet-lan-wave',
            title: t('wave'),
            'aria-label': t('wave') + ': ' + pet.name,
            onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => {
              event.stopPropagation()
              const clicks = entry !== null && entry !== undefined && entry.animations !== null && typeof entry.animations === 'object'
                ? entry.animations.clicks
                : undefined
              const pool = Array.isArray(clicks) && clicks.length > 0 ? clicks : poolRef.current
              const next = pickRandom(pool)
              if (next !== undefined) setOverride(next)
              onWave(peer, pet)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
            },
            onKeyUp: (event) => {
              if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
            },
          }, '👋'),
        ]),
        liveBubble !== ''
          ? h('div', { key: 'bubble', className: 'dsh-pet-lan-bubble' }, [
            liveImage !== ''
              ? h('img', {
                key: 'image',
                className: 'dsh-pet-lan-bubble-img',
                src: memeImageUrl(pet.assetRoot, liveImage),
                alt: '',
                draggable: false,
                onError: (event) => {
                  event.currentTarget.style.display = 'none'
                },
              })
              : null,
            h('span', { key: 'text', className: 'dsh-pet-lan-bubble-text' }, liveBubble),
          ])
          : null,
        h('div', {
          key: 'box',
          ref: boxRef,
          className: 'dsh-pet-lan-box',
          style: { width: size + 'px', height: height + 'px' },
          onAnimationEnd: (event) => {
            if (event.animationName === 'dsh-pet-lan-squash') event.currentTarget.classList.remove('is-squash')
          },
        }, hasArt && !missing
          ? h(RemoteClip, {
            assetRoot: pet.assetRoot,
            anim: current !== undefined ? current : '待机',
            width: size,
            height,
            mirror,
            onFailed: () => {
              if (wanted !== undefined && wanted !== deadAnim) setDeadAnim(wanted)
              else setMissing(true)
            },
          })
          : h(UnknownPet, { size: height, name: pet.name })),
      ])
    }

    /** The frame-wide overlay: one sprite per peering pet plus wave toasts. */
    function LanOverlay(props) {
      const { t } = props
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const data = snapshot.data
      const viewport = useViewport()
      const [toasts, setToasts] = useState([])
      const toastId = useRef(0)
      const timers = useRef(new Set())
      const waveSeq = useRef(-1)
      const initializedWave = useRef(false)
      const pokeSeq = useRef(-1)
      const initializedPoke = useRef(false)
      const [windowWidth, windowHeight] = viewport

      const local = useMemo(() => flattenPets(localConfig), [snapshot.data])

      const pushToast = useCallback((text) => {
        const id = toastId.current + 1
        toastId.current = id
        setToasts((list) => [...list, { id, text }].slice(-3))
        const timer = window.setTimeout(() => {
          setToasts((list) => list.filter((item) => item.id !== id))
          timers.current.delete(timer)
        }, 4200)
        timers.current.add(timer)
      }, [])

      useEffect(() => {
        const pending = timers.current
        return () => {
          for (const timer of pending) window.clearTimeout(timer)
          pending.clear()
        }
      }, [])

      // Incoming waves: a toast for us, and the local pet itself answers
      // through dsh-pet's public endpoints (bubble + greeting animation).
      const incomingSeq = data !== null && data.lastWave !== undefined ? data.lastWave.seq : 0
      useEffect(() => {
        if (!initializedWave.current) {
          initializedWave.current = true
          waveSeq.current = incomingSeq
          return
        }
        if (incomingSeq <= waveSeq.current) return
        waveSeq.current = incomingSeq
        const wave = data !== null && data.lastWave !== undefined ? data.lastWave : null
        if (wave === null) return
        pushToast(t('waveIn', { name: wave.fromName }))

        const target = local.pets[0]
        if (target === undefined) return
        const entry = local.entries.get(target.assetRoot)
        void postJson(PET_BASE + '/broadcast?pet=' + encodeURIComponent(target.id) + '&surface=any', {
          text: t('waveText', { name: wave.fromName }),
        })
        const pool = animationPool(entry)
        const greeting = pickRandom(pool)
        if (greeting !== undefined) {
          void postJson(PET_BASE + '/anim?pet=' + encodeURIComponent(target.id) + '&surface=any', { name: greeting })
        }
      }, [incomingSeq, data, pushToast, t, local])

      // Incoming squish notifications: "XX 捏了你一下". The clicked pet's id
      // is used when it exists locally; otherwise the first local pet answers.
      const incomingPokeSeq = data !== null && data.lastPoke !== undefined ? data.lastPoke.seq : 0
      useEffect(() => {
        if (!initializedPoke.current) {
          initializedPoke.current = true
          pokeSeq.current = incomingPokeSeq
          return
        }
        if (incomingPokeSeq <= pokeSeq.current) return
        pokeSeq.current = incomingPokeSeq
        const poke = data !== null && data.lastPoke !== undefined ? data.lastPoke : null
        if (poke === null) return
        pushToast(t('pokeIn', { name: poke.fromName }))
        const target = local.pets.find((pet) => pet.id === poke.petId) ?? local.pets[0]
        if (target === undefined) return
        void postJson(PET_BASE + '/broadcast?pet=' + encodeURIComponent(target.id) + '&surface=any', {
          text: t('pokeText', { name: poke.fromName }),
        })
      }, [incomingPokeSeq, data, pushToast, t, local])

      const waveTo = useCallback((peer, pet) => {
        pushToast(t('waveSent', { name: pet.name }))
        void store.wave(peer.node)
      }, [pushToast, t])

      const pokeTo = useCallback((peer, pet) => {
        pushToast(t('pokeSent', { name: pet.name }))
        void store.poke(peer.node, pet.id)
      }, [pushToast, t])

      if (data === null || data.enabled !== true) return null

      // Desktop windows are the default: while the helper is alive the browser
      // overlay stays out of the way. If Electron is unavailable or crashed,
      // fall back to the overlay so peers remain visible.
      const mode = data.config !== undefined && data.config.mode !== undefined ? data.config.mode : 'desktop'
      if (mode === 'desktop' && data.desktopReady === true) {
        // Keep the toast surface alive in desktop mode: this is where a
        // squish notification ("XX 捏了你一下") becomes visible.
        return toasts.length > 0
          ? h('div', {
            className: 'dsh-pet-lan-toasts',
            style: { right: '16px', bottom: '16px' },
          }, toasts.map((toast) => h('div', { key: toast.id, className: 'dsh-pet-lan-toast' }, toast.text)))
          : null
      }

      const peers = Array.isArray(data.peers) ? data.peers : []
      const sprites = []
      for (const peer of peers) {
        const source = peer.viewport !== undefined && peer.viewport.w > 0 && peer.viewport.h > 0
          ? peer.viewport
          : { w: windowWidth, h: windowHeight }
        const factor = clamp(windowWidth / source.w, 0.6, 1.4)
        for (const pet of peer.pets) {
          sprites.push(h(RemotePet, {
            key: peer.node + ':' + pet.id,
            peer,
            pet,
            entry: local.entries.get(pet.assetRoot),
            factor,
            viewport,
            onWave: waveTo,
            onPoke: pokeTo,
            t,
            physics: data !== null && data.config !== undefined && data.config.physics !== undefined
              ? data.config.physics
              : DEFAULT_PHYSICS,
          }))
        }
      }

      const anchor = local.pets[0]
      const anchorRight = anchor !== undefined ? anchor.marginX : 24
      const anchorBottom = anchor !== undefined ? anchor.marginY + anchor.size : 180
      const maxBottom = Math.max(40, windowHeight - 40)

      return h(React.Fragment, null, [
        sprites.length > 0
          ? h('div', {
            key: 'pets',
            className: 'dsh-pet-lan-layer',
            'data-dsh-pet-lan': 'pets',
            'data-count': sprites.length,
          }, sprites)
          : null,
        toasts.length > 0
          ? h('div', {
            key: 'toasts',
            className: 'dsh-pet-lan-toasts',
            style: {
              right: clamp(anchorRight, 12, Math.max(12, windowWidth - 80)) + 'px',
              bottom: clamp(anchorBottom, 12, maxBottom) + 'px',
            },
          }, toasts.map((toast) => h('div', { key: toast.id, className: 'dsh-pet-lan-toast' }, toast.text)))
          : null,
      ])
    }

    /** One peer row in the settings page. */
    function PeerRow(props) {
      const { peer, t, onWave } = props
      const seconds = Math.max(0, Math.round((Date.now() - peer.lastSeen) / 1000))
      const names = peer.pets.map((pet) => pet.name).join('、')
      return h('div', { className: 'dsh-pet-lan-peer' }, [
        h('span', { key: 'dot', className: 'dsh-pet-lan-dot' }),
        h('div', { key: 'main', className: 'dsh-pet-lan-peer-main' }, [
          h('div', { key: 'name', className: 'dsh-pet-lan-peer-name' }, names + ' · ' + peer.host),
          h('div', { key: 'meta', className: 'dsh-pet-lan-peer-meta' },
            peer.ip + ' · ' + t('lastSeen', { n: seconds })),
        ]),
        h('button', {
          key: 'wave',
          type: 'button',
          className: 'dsh-pet-lan-button dsh-pet-lan-button-small',
          onClick: () => onWave(peer),
        }, t('wave')),
      ])
    }

    /** The settings page: room/port/nickname + discovery status. */
    function SettingsSection(props) {
      const { t } = props
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const data = snapshot.data
      const [form, setForm] = useState(null)
      const [notice, setNotice] = useState('')
      const initialized = useRef(false)

      useEffect(() => {
        if (initialized.current || data === null || data.config === undefined) return
        initialized.current = true
        setForm({
          enabled: data.config.enabled !== false,
          room: data.config.room,
          nickname: data.config.nickname !== undefined ? data.config.nickname : '',
          port: data.config.port,
          mode: data.config.mode !== undefined ? data.config.mode : 'desktop',
          shareBubbles: data.config.shareBubbles !== false,
          acceptWaves: data.config.acceptWaves !== false,
          petCollision: data.config.petCollision !== false,
        })
      }, [data])

      const save = async () => {
        if (form === null) return
        setNotice('')
        const result = await store.save(form)
        if (result.ok === true) {
          setNotice(t('saved'))
          await store.refresh()
        } else {
          setNotice(t('saveFailed') + ' (' + (result.error !== undefined ? result.error : '?') + ')')
        }
      }

      const header = h('div', { key: 'head', className: 'dsh-pet-lan-head' }, [
        h('h3', { key: 'title', className: 'dsh-pet-lan-title' }, t('nav')),
        h('p', { key: 'hint', className: 'dsh-pet-lan-muted' }, t('hint')),
      ])

      if (data === null) {
        return h('div', { className: 'dsh-pet-lan-section' }, [
          header,
          h('p', { key: 'state', className: 'dsh-pet-lan-muted' },
            snapshot.error === null ? t('loading') : t('unavailable') + ' (' + snapshot.error + ')'),
          h('button', { key: 'retry', type: 'button', className: 'dsh-pet-lan-button', onClick: () => void store.refresh() }, t('retry')),
        ])
      }

      const peers = Array.isArray(data.peers) ? data.peers : []
      const local = flattenPets(localConfig)
      const localNames = local.pets.map((pet) => pet.name).join('、')

      const fields = h('div', { key: 'fields', className: 'dsh-pet-lan-fields' }, [
        h('label', { key: 'enabled', className: 'dsh-pet-lan-check' }, [
          h('input', {
            key: 'input',
            type: 'checkbox',
            checked: form !== null && form.enabled === true,
            disabled: form === null,
            onChange: (event) => setForm((current) => ({ ...current, enabled: event.target.checked })),
          }),
          h('span', { key: 'label' }, t('enabled')),
        ]),
        h('label', { key: 'room', className: 'dsh-pet-lan-field' }, [
          h('span', { key: 'label', className: 'dsh-pet-lan-label' }, t('room')),
          h('input', {
            key: 'input',
            className: 'dsh-pet-lan-input',
            type: 'text',
            maxLength: 32,
            value: form !== null ? form.room : '',
            disabled: form === null,
            onChange: (event) => setForm((current) => ({ ...current, room: event.target.value })),
          }),
          h('span', { key: 'hint', className: 'dsh-pet-lan-muted dsh-pet-lan-small' }, t('roomHint')),
        ]),
        h('label', { key: 'mode', className: 'dsh-pet-lan-field' }, [
          h('span', { key: 'label', className: 'dsh-pet-lan-label' }, t('mode')),
          h('select', {
            key: 'input',
            className: 'dsh-pet-lan-input',
            value: form !== null ? form.mode : 'desktop',
            disabled: form === null,
            onChange: (event) => setForm((current) => ({ ...current, mode: event.target.value })),
          }, [
            h('option', { key: 'desktop', value: 'desktop' }, t('modeDesktop')),
            h('option', { key: 'browser', value: 'browser' }, t('modeBrowser')),
            h('option', { key: 'both', value: 'both' }, t('modeBoth')),
          ]),
          h('span', { key: 'hint', className: 'dsh-pet-lan-muted dsh-pet-lan-small' }, t('modeHint')),
        ]),
        h('label', { key: 'port', className: 'dsh-pet-lan-field' }, [
          h('span', { key: 'label', className: 'dsh-pet-lan-label' }, t('port')),
          h('input', {
            key: 'input',
            className: 'dsh-pet-lan-input dsh-pet-lan-input-narrow',
            type: 'number',
            min: 1024,
            max: 65535,
            step: 1,
            value: form !== null ? form.port : '',
            disabled: form === null,
            onChange: (event) => setForm((current) => ({ ...current, port: Number(event.target.value) })),
          }),
          h('span', { key: 'hint', className: 'dsh-pet-lan-muted dsh-pet-lan-small' }, t('portHint')),
        ]),
        h('div', { key: 'privacy', className: 'dsh-pet-lan-field' }, [
          h('label', { key: 'shareBubbles', className: 'dsh-pet-lan-check' }, [
            h('input', {
              key: 'input',
              type: 'checkbox',
              checked: form !== null && form.shareBubbles === true,
              disabled: form === null,
              onChange: (event) => setForm((current) => ({ ...current, shareBubbles: event.target.checked })),
            }),
            h('span', { key: 'label' }, t('shareBubbles')),
          ]),
          h('span', { key: 'hint', className: 'dsh-pet-lan-muted dsh-pet-lan-small' }, t('shareBubblesHint')),
        ]),
        h('div', { key: 'waves', className: 'dsh-pet-lan-field' }, [
          h('label', { key: 'acceptWaves', className: 'dsh-pet-lan-check' }, [
            h('input', {
              key: 'input',
              type: 'checkbox',
              checked: form !== null && form.acceptWaves === true,
              disabled: form === null,
              onChange: (event) => setForm((current) => ({ ...current, acceptWaves: event.target.checked })),
            }),
            h('span', { key: 'label' }, t('acceptWaves')),
          ]),
          h('span', { key: 'hint', className: 'dsh-pet-lan-muted dsh-pet-lan-small' }, t('acceptWavesHint')),
        ]),
        h('div', { key: 'collision', className: 'dsh-pet-lan-field' }, [
          h('label', { key: 'petCollision', className: 'dsh-pet-lan-check' }, [
            h('input', {
              key: 'input',
              type: 'checkbox',
              checked: form !== null && form.petCollision === true,
              disabled: form === null,
              onChange: (event) => setForm((current) => ({ ...current, petCollision: event.target.checked })),
            }),
            h('span', { key: 'label' }, t('petCollision')),
          ]),
          h('span', { key: 'hint', className: 'dsh-pet-lan-muted dsh-pet-lan-small' }, t('petCollisionHint')),
        ]),
        h('div', { key: 'actions', className: 'dsh-pet-lan-actions' }, [
          h('button', { key: 'save', type: 'button', className: 'dsh-pet-lan-button dsh-pet-lan-button-primary', onClick: () => void save() }, t('save')),
          h('button', { key: 'refresh', type: 'button', className: 'dsh-pet-lan-button', onClick: () => void store.refresh() }, t('refresh')),
          notice !== '' ? h('span', { key: 'notice', className: 'dsh-pet-lan-muted dsh-pet-lan-small' }, notice) : null,
        ]),
      ])

      const status = h('div', { key: 'status', className: 'dsh-pet-lan-status' }, [
        h('div', { key: 'line', className: 'dsh-pet-lan-status-line' }, [
          h('span', {
            key: 'dot',
            className: 'dsh-pet-lan-dot',
            style: { background: data.udpReady ? 'var(--dsw-alias-state-success-primary, #22c55e)' : 'var(--dsw-alias-state-error-primary, #ef4444)' },
          }),
          h('span', { key: 'text' }, (data.udpReady ? t('udpOnline') : t('udpOffline'))
            + (data.boundPort > 0 ? ' · ' + t('boundPort', { port: data.boundPort }) : '')),
          h('span', { key: 'count', className: 'dsh-pet-lan-muted' }, t('peerCount', { count: peers.length })),
        ]),
        data.enabled !== true
          ? h('p', { key: 'off', className: 'dsh-pet-lan-muted' }, t('disabledHint'))
          : null,
        data.lastError !== null && data.lastError !== undefined
          ? h('p', { key: 'error', className: 'dsh-pet-lan-error' }, t('lastError') + ': ' + data.lastError)
          : null,
        h('p', { key: 'self', className: 'dsh-pet-lan-muted dsh-pet-lan-small' },
          t('self') + ': ' + (localNames === '' ? t('noPets') : localNames)),
        data.config.mode !== 'browser'
          ? h('p', { key: 'desktop', className: 'dsh-pet-lan-muted dsh-pet-lan-small' },
            (data.desktopReady ? t('desktopOn') : t('desktopOff'))
            + (data.desktopError !== null && data.desktopError !== undefined ? ' · ' + data.desktopError : ''))
          : null,
        h('p', { key: 'stats', className: 'dsh-pet-lan-muted dsh-pet-lan-small' },
          t('sent', { n: data.stats !== undefined ? data.stats.sent : 0 }) + ' · '
          + t('received', { n: data.stats !== undefined ? data.stats.received : 0 })),
      ])

      const list = h('div', { key: 'peers', className: 'dsh-pet-lan-peers' }, [
        h('div', { key: 'title', className: 'dsh-pet-lan-label' }, t('peers')),
        peers.length === 0
          ? h('p', { key: 'empty', className: 'dsh-pet-lan-muted' }, t('noPeers'))
          : peers.map((peer) => h(PeerRow, {
            key: peer.node,
            peer,
            t,
            onWave: (target) => {
              void store.wave(target.node)
            },
          })),
      ])

      return h('div', { className: 'dsh-pet-lan-section' }, [header, fields, status, list])
    }

    /** Inline stylesheet (idempotent; a stale copy from an earlier apply is replaced). */
    const CSS = [
      '.dsh-pet-lan-layer{position:fixed;inset:0;pointer-events:none;z-index:2147482000}',
      '.dsh-pet-lan-pet{position:fixed;pointer-events:auto;cursor:pointer;user-select:none;-webkit-user-select:none;',
      'transition:right .6s ease,bottom .6s ease,left .6s ease,top .6s ease;will-change:right,bottom,left,top;',
      'filter:drop-shadow(0 6px 10px rgba(2,6,23,.18));outline:none;touch-action:manipulation}',
      '.dsh-pet-lan-pet:focus-visible .dsh-pet-lan-tag{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}',
      '.dsh-pet-lan-tag{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:3px;display:inline-flex;',
      'align-items:center;gap:5px;padding:1px 8px;border-radius:999px;white-space:nowrap;max-width:180px;overflow:hidden;',
      'background:var(--dsw-alias-bg-overlay,rgba(15,23,42,.86));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.35));',
      'color:var(--dsw-alias-label-secondary,#cbd5e1);font-size:11px;line-height:1.6;box-shadow:0 2px 8px rgba(2,6,23,.28);pointer-events:none;',
      'backdrop-filter:blur(6px)}',
      '.dsh-pet-lan-tag-name{overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 auto}',
      '.dsh-pet-lan-bubble{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% + 22px);z-index:2;',
      'display:flex;flex-direction:column;align-items:center;gap:4px;max-width:min(240px,70vw);padding:5px 10px;',
      'border-radius:10px;background:rgba(255,255,255,.94);color:#2b2b2b;font-size:12px;line-height:1.45;',
      'box-shadow:0 3px 12px rgba(2,6,23,.22);pointer-events:none;word-break:break-word;text-align:center}',
      '.dsh-pet-lan-bubble::after{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);',
      'border:6px solid transparent;border-top-color:rgba(255,255,255,.94);border-bottom:none}',
      '.dsh-pet-lan-bubble-img{display:block;max-width:120px;max-height:90px;border-radius:6px}',
      '.dsh-pet-lan-bubble-text{white-space:pre-wrap}',
      '.dsh-pet-lan-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:0 0 auto;display:inline-block}',
      '.dsh-pet-lan-box{position:relative;display:flex;align-items:flex-end;justify-content:center;pointer-events:none;transform-origin:50% 100%}',
      '.dsh-pet-lan-box.is-squash{animation:dsh-pet-lan-squash .42s cubic-bezier(.22,.8,.3,1)}',
      '@keyframes dsh-pet-lan-squash{0%{transform:scale(1,1)}18%{transform:scale(1.18,.68)}42%{transform:scale(.92,1.1)}64%{transform:scale(1.06,.96)}82%{transform:scale(.98,1.02)}100%{transform:scale(1,1)}}',
      '.dsh-pet-lan-wave{pointer-events:auto;flex:0 0 auto;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;padding:0 1px;cursor:pointer;opacity:.9}',
      '.dsh-pet-lan-wave:hover{opacity:1;transform:scale(1.15)}',
      '.dsh-pet-lan-video{display:block;max-width:none;pointer-events:none;object-fit:contain}',
      '.dsh-pet-lan-avatar{display:flex;align-items:center;justify-content:center;border-radius:50%;pointer-events:none;',
      'background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.75));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.35));',
      'box-shadow:0 4px 12px rgba(2,6,23,.3)}',
      '.dsh-pet-lan-toasts{position:fixed;z-index:2147483600;display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none}',
      '.dsh-pet-lan-toast{max-width:min(320px,60vw);padding:6px 12px;border-radius:12px;font-size:12px;line-height:1.5;',
      'background:var(--dsw-alias-bg-overlay,rgba(15,23,42,.92));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.4));',
      'color:var(--dsw-alias-label-primary,#e2e8f0);box-shadow:0 4px 14px rgba(2,6,23,.32);',
      'animation:dsh-pet-lan-pop .22s ease-out}',
      '@keyframes dsh-pet-lan-pop{from{opacity:0;transform:translateY(6px) scale(.96)}to{opacity:1;transform:none}}',
      '.dsh-pet-lan-section{display:flex;flex-direction:column;gap:18px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#e2e8f0)}',
      '.dsh-pet-lan-head{display:flex;flex-direction:column;gap:6px}',
      '.dsh-pet-lan-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#e2e8f0)}',
      '.dsh-pet-lan-muted{margin:0;color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-pet-lan-small{font-size:12px}',
      '.dsh-pet-lan-fields{display:flex;flex-direction:column;gap:14px;max-width:520px}',
      '.dsh-pet-lan-field{display:flex;flex-direction:column;gap:6px}',
      '.dsh-pet-lan-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#94a3b8)}',
      '.dsh-pet-lan-input{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;font:inherit;',
      'background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.6));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.35));',
      'color:var(--dsw-alias-label-primary,#e2e8f0);outline:none}',
      '.dsh-pet-lan-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-pet-lan-input-narrow{max-width:160px}',
      '.dsh-pet-lan-check{display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer}',
      '.dsh-pet-lan-check input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-pet-lan-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsh-pet-lan-button{font:inherit;font-size:12px;padding:6px 14px;border-radius:8px;cursor:pointer;',
      'background:var(--dsw-alias-bg-layer-2,rgba(30,41,59,.7));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.4));',
      'color:var(--dsw-alias-label-primary,#e2e8f0)}',
      '.dsh-pet-lan-button:hover{border-color:var(--dsw-alias-border-l2,rgba(148,163,184,.7))}',
      '.dsh-pet-lan-button-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}',
      '.dsh-pet-lan-button-small{padding:3px 10px}',
      '.dsh-pet-lan-status{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.4));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.25))}',
      '.dsh-pet-lan-status-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-pet-lan-error{margin:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;word-break:break-all}',
      '.dsh-pet-lan-peers{display:flex;flex-direction:column;gap:8px}',
      '.dsh-pet-lan-peer{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(15,23,42,.35));border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.22))}',
      '.dsh-pet-lan-peer-main{flex:1 1 auto;min-width:0}',
      '.dsh-pet-lan-peer-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-pet-lan-peer-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#94a3b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '@media (prefers-reduced-motion: reduce){.dsh-pet-lan-pet{transition:none}.dsh-pet-lan-toast{animation:none}}',
    ].join('\n')

    /** Insert the plugin stylesheet once and return its remover. */
    function installStyles() {
      const existing = document.querySelector('style[data-plugin-css="dsh-pet-lan/style.css"]')
      if (existing !== null) existing.remove()
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-pet-lan'
      tag.dataset.pluginCss = 'dsh-pet-lan/style.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposeStyles = installStyles()
        ctx.effect(() => () => disposeStyles(), 'dsh-pet-lan: styles')
        ctx.effect(() => releaseStore, 'dsh-pet-lan: polling keepalive')

        // Locale is optional: without it the UI falls back to the browser's
        // language (zh/en), never to raw keys.
        let t = /^zh/i.test(navigator.language || '') ? zhT : enT
        try {
          const locale = ctx.get('locale', false)
          if (locale !== undefined && typeof locale.register === 'function') {
            ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-pet-lan: dictionaries')
            if (typeof locale.bind === 'function') t = locale.bind(NS)
          }
        } catch (error) {
          console.warn('[dsh-pet-lan] locale unavailable: ' + String(error && error.message ? error.message : error))
        }

        // Remote pets live in the frame-wide floating layer: it is click-through
        // by design, and each sprite opts back into pointer events.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'pet-lan',
          order: 1001,
        }, function PetLanOverlay() {
          return h(LanOverlay, { t })
        }))

        // One settings page: the LAN knobs plus the live peer list.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'pet-lan',
          order: 135,
          label: () => t('nav'),
        }, function PetLanSettings() {
          return h(SettingsSection, { t })
        }))
      },
    }
  },
})
