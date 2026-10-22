# dsh-pet-lan · 桌宠联机

给已安装的 **`dsh-pet` 0.3.7** 加一个局域网联机层：同一 Wi-Fi / 局域网里，
每个装了本插件的 DSH 都会把自家桌宠广播出去，别人的桌宠会出现在你的桌面上，
**动作、表情包、说的话都会实时同步**，还能互相打招呼、自由拖拽位置。

参考 Bongo Cat 的 *Meowtiplayer* 思路——**不拉群、不登录、没有服务器**：同一房间名的机器自动互相发现。

## 功能

- **UDP 广播发现**：每台 DSH 每 1.5 秒向各网段广播一个 presence 包（默认 UDP `41234`），
  6.5 秒收不到即下线；不需要服务器、账号或外网。
- **实时状态同步**：广播对方**当前动画名、朝向、气泡文字、表情包名**，
  你桌面上的远端桌宠会跟着对方一起动、一起说话、一起发表情包。
- **桌面窗口**：远端桌宠是**透明置顶的小窗口**，不是浏览器浮层；可以**自由拖拽**，
  位置按「对方 + 宠物」记住，重启后仍在原处。
- **同桌宠渲染**：直接复用本机 dsh-pet 的素材；对方用你本机没有的 pet pack 时，
  退化成带名字的爪印徽章，而不是整只消失。
- **打招呼**：点远端桌宠 → 对方屏幕弹「来自 xx 的问候」，**xx 只显示桌宠名**，
  对方自己的桌宠也会说这句话并播一段问候动作。
- **设置页「桌宠联机」**：显示方式（桌面 / 浏览器 / 两者）、房间名、端口、
  在线列表、桌面窗口状态与收发诊断。

## 安装 / 更新

> 需要已安装 **`dsh-pet` 0.3.7**（带 `/dsh-pet-7340` 路由的版本）并且桌宠可见。

### 从插件市场 / npm 安装（普通用户）

1. 先安装并启用 **`dsh-pet@0.3.7`**（市场里搜 `dsh-pet`，或 `dsh plugin --profile web add dsh-pet`）。
2. 在 DSH 的插件市场搜索 `dsh-pet-lan` 安装，或：
   ```powershell
   dsh plugin --profile web add dsh-pet-lan
   ```
   桌面应用把 `web` 换成 `desktop`。
3. 打开 **设置 → 桌宠联机**：设置房间名、端口和显示方式。
4. 想要**实时动作 / 气泡 / 表情包同步**，再运行一次可选补丁：
   ```powershell
   node <插件目录>\scripts\patch-dsh-pet.mjs
   ```
   不跑也能联机，只是对方的宠物会本地随机动作，气泡不会实时同步。

### 交给同事的 AI（团队批量安装）

把 `dsh-pet-lan.zip` 发给同事，附上这句：

> 这是 DSH 桌宠联机插件压缩包。请解压后运行 `dsh-pet-lan\scripts\install.mjs --room Kunpo --port 41234`，
> 它会复制到 `~/.dsh/plugins/dsh-pet-lan`、注册到当前 profile、给 dsh-pet 打实时状态补丁。
> 如果需要重启 DSH，先告诉我，不要自行重启。

AI 也可以直接阅读包内的 [AI-INSTALL.md](AI-INSTALL.md)；脚本支持 `--dry-run`、`--no-register`（配合
`plugin_manager install_bundle` 免重启）、`--profile web` 等参数。

### 手动安装（无市场 / 无 AI）

1. 把 `dsh-pet-lan` 目录放到一个固定位置（例如 `C:\Users\<用户名>\dsh-plugins\dsh-pet-lan`）。
2. DSH 侧边栏 **插件 → 添加插件 → 安装第三方插件**，填该目录的绝对路径，安装。
   （已经装过旧版的话，先移除再安装，或直接替换目录内容后重新加载插件。）
3. **给 dsh-pet 打实时状态补丁**（每台机器一次）：
   ```powershell
   node <dsh-pet-lan 目录>\scripts\patch-dsh-pet.mjs
   ```
   补丁给 dsh-pet 的桌面 helper 和浏览器端加一个很小的状态上报（动画 / 气泡 / 表情包），
   原文件会备份成 `*.dsh-pet-lan.bak`；dsh-pet 升级后需要重跑一次。
   没打补丁也能联机，只是看不到对方的实时动作/气泡。
4. 重启 DSH（或重启桌宠插件 / 刷新页面），让打过补丁的 helper 生效。
5. 两台电脑都打开 **设置 → 桌宠联机**，确认开关打开、房间名和端口一致（默认 `dsh-pet` / `41234`）。

### 显示方式

- **桌面窗口**（默认）：远端桌宠在桌面上的透明小窗里，可拖拽，位置自动保存。
  需要本机已有 Electron（桌宠桌面模式安装时已下载到 `$DSH_HOME/electron`）。
- **浏览器浮层**：远端桌宠显示在 DSH 窗口里（旧的渲染方式），作为没有 Electron 时的回退。
- **桌面 + 浏览器**：两边都显示。

Electron 缺失或桌面 helper 启动失败时，会自动退回浏览器浮层；设置页会显示错误原因。

### Windows 防火墙

首次运行可能弹出防火墙提示：允许 **专用网络的 UDP 入站**（默认端口 41234）。
如果点了取消，用管理员 PowerShell 补一条：

```powershell
New-NetFirewallRule -DisplayName "DSH Pet LAN" -Direction Inbound -Protocol UDP -LocalPort 41234 -Action Allow -Profile Private
```

公司 / 访客 Wi-Fi 常开 **客户端隔离（AP isolation）**，这种网络下设备互相不可见，换手机热点即可。

### 端口 / 房间

- 所有机器端口必须一致（默认 `41234`）；改端口后自动重新监听。
- 房间名相当于分组；换房间名就互相看不到。
- 端口被占用时设置页显示「UDP 未监听」与错误原因，换一个端口即可。

## 工作方式（协议 v1）

```
presence（每 1.5s，广播到每个网段 + 255.255.255.255 + 127.0.0.1）
{
  "v": 1, "t": "presence", "room": "dsh-pet", "node": "<稳定 UUID>",
  "host": "LF-PC", "port": 41234,
  "viewport": { "w": 1600, "h": 900 },
  "pets": [{
    "id": "main", "name": "鲸鲸", "size": 462,
    "assetRoot": "main", "corner": "top-right", "marginX": 24, "marginY": 100,
    "anim": "打瞌睡被惊醒", "facing": "right",
    "bubble": "这一步正在进行中哦", "image": "Ciallo"
  }],
  "sentAt": 1690000000000
}

wave（单播到对方的 IP:port）
{ "v":1, "t":"wave", "room":"dsh-pet", "from":"<node>", "fromName":"鲸鲸",
  "fromHost":"LF-PC", "to":"<对方 node>", "at":1690000000000 }
```

- 每台机器最多广播 5 只桌宠；一个 UDP 包保持在 1400 字节内（超了会先丢气泡/配图等可选字段）。
- 浏览器侧只访问同源的 `/api/pet-lan` JSON 路由（仅回环可访问），不直接暴露给局域网。
- 桌面窗口位置保存在 `$DSH_HOME/dsh-pet-lan.json` 的 `positions` 里，按 `节点/宠物` 记住。

## 实时状态从哪来

- **桌面模式的宠物**：`scripts/patch-dsh-pet.mjs` 给 dsh-pet 的 Electron helper 加了一个
  500ms 去重的上报，写入 `$DSH_HOME/dsh-pet/desktop-live.json`，本插件读取后广播。
- **浏览器模式的宠物**：同一补丁给 `.dsh-pet-root` 加了 `data-anim` / `data-bubble` /
  `data-bubble-image`，本插件的页面端读取后上报给宿主。

## 数据与隐私

- 广播内容：桌宠 id / 名字 / 大小 / 种类 / 位置、窗口尺寸、主机名，以及**当前动画名、气泡文字、表情包名**。
  气泡文字来自碎碎念 / 对话 / 工作状态，**会出现在局域网里**；介意的话把桌宠的碎碎念/工作状态关掉。
- 状态文件：`$DSH_HOME/dsh-pet-lan.json`（配置 + 窗口位置）、
  `$DSH_HOME/dsh-pet-lan.status.json`（诊断）、`$DSH_HOME/dsh-pet/desktop-live.json`（本机实时状态）。
- UDP 是明文、无认证的：同房间的人可以伪造 presence / 打招呼，只影响显示，不写入持久数据。
  只建议在可信局域网使用。

## 卸载

移除 `dsh-pet-lan` bundle；`$DSH_HOME/dsh-pet-lan*.json` 可删。
`scripts/patch-dsh-pet.mjs` 改过的 dsh-pet 文件可用同名 `.dsh-pet-lan.bak` 备份还原；
不还原也不影响桌宠本身。
