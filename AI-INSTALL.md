# 交给 AI 的安装说明（dsh-pet-lan）

你收到的是 **DSH 桌宠联机插件** 的压缩包。目标：装进当前电脑的 DSH profile，
房间名设为 **Kunpo**、UDP 端口设为 **41234**，让这台电脑和同事的桌宠互相可见。

> 只支持 **Windows 上的 DSH 桌面应用 / dsh web**，并且必须已经装好
> **`dsh-pet` 0.3.7**（不是 `@linxin666/dsh-pet` 0.4.x）且桌宠可见。

## 0. 先检查环境（不要跳过）

```powershell
node --version
$env:DSH_PROFILE
$env:DSH_PROFILE_DIR
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-pet\package.json"
```

- **Node 必须是可用的**（`node --version` 有输出）。没有 Node 就先装 Node LTS；
  不要拿 DSH 的 Electron 当 node 用。
- **profile**：桌面应用一般是 `desktop`；如果 `$env:DSH_PROFILE` 是别的值（如 `web`），
  下面所有命令加 `--profile <那个值>`。
- **dsh-pet**：上面的 `Test-Path` 必须是 `True`。没有就先装 `dsh-pet@0.3.7`
  （插件页搜索 dsh-pet，或 `plugin_manager install_bundle target="dsh-pet@0.3.7"`），
  装好并确认桌宠可见后再继续，否则联机插件没有可广播的桌宠。
- **权限**：需要写 `%USERPROFILE%\.dsh` 和 profile 目录；如果当前是 ask 模式，
  先向用户申请文件/命令权限，不要绕过审批。

## 1. 解压

把 zip 解压到临时目录，得到 `dsh-pet-lan` 文件夹（里面有 `scripts\install.mjs`）。

## 2. 安装（二选一）

### A. 当前 Agent 有 `plugin_manager` 工具（推荐，免重启）

```powershell
node "<解压目录>\dsh-pet-lan\scripts\install.mjs" --room Kunpo --port 41234 --no-register
```

然后调用：

```
plugin_manager action=install_bundle target="%USERPROFILE%\.dsh\plugins\dsh-pet-lan"
```

### B. 没有 `plugin_manager`（需要用户重启 DSH）

```powershell
node "<解压目录>\dsh-pet-lan\scripts\install.mjs" --room Kunpo --port 41234
```

脚本会自动：

1. 复制到 `%USERPROFILE%\.dsh\plugins\dsh-pet-lan`（固定位置，之后不要移动/删除）；
2. 写 `%USERPROFILE%\.dsh\dsh-pet-lan.json`：`room=Kunpo`、`port=41234`、`mode=desktop`；
3. 注册到 profile（依赖 + bundle 选择 + `node_modules` 目录链接），
   `package.json` 备份为 `package.json.dsh-pet-lan.bak`；
4. 给 `dsh-pet` 打实时状态补丁（动画 / 气泡 / 表情包），原文件备份为 `*.dsh-pet-lan.bak`。

脚本幂等，可重复运行；`--dry-run` 只打印；`--no-patch` 跳过补丁。

## 3. 防火墙

第一次运行 Windows 可能弹 UDP 41234 的提示，选 **专用网络** 允许。
如果已经点了取消，管理员 PowerShell 执行：

```powershell
New-NetFirewallRule -DisplayName "DSH Pet LAN" -Direction Inbound -Protocol UDP -LocalPort 41234 -Action Allow -Profile Private
```

没有管理员权限就问用户是否允许；不要静默跳过这一步，否则对方看不到这台机器。

## 4. 重启 / 验证

- 走 A（plugin_manager）：通常已经生效；让用户刷新页面即可。
- 走 B：**请用户重启 DSH**，不要自己重启（会中断当前会话）。

重启/刷新后验证：

1. **设置 → 桌宠联机**：房间 `Kunpo`、端口 `41234`、显示方式「桌面窗口」；
2. `%USERPROFILE%\.dsh\dsh-pet-lan.status.json`：
   `"udpReady": true`、`"desktopReady": true`、`"lastError": null`；
3. 同一房间的同事应该出现在「局域网里的桌宠」列表里；
4. 桌面上出现对方的桌宠小窗，可以拖动。

## 5. 常见失败

| 现象 | 处理 |
| --- | --- |
| `node` 不是内部或外部命令 | 安装 Node LTS，或让用户提供 `node.exe` 路径；不要用 Electron 代替 |
| `dsh-pet 0.3.7 is not installed` | 先装 `dsh-pet@0.3.7`，确认桌宠出现 |
| profile 不对 / 装完没效果 | 用 `--profile web` 或 `$env:DSH_PROFILE` 的值重跑 |
| `mklink` 失败 / 权限不足 | 用管理员 PowerShell，或让用户批准文件权限 |
| 端口被占用 | 设置页换一个端口，两台电脑保持一致 |
| `desktopReady: false` | 确认 `%USERPROFILE%\.dsh\electron\electron.exe` 存在（桌宠桌面模式会下载）；缺失时插件会退回浏览器浮层 |
| 看不到对方 | 两台电脑房间名、端口一致；同一局域网；防火墙放行 UDP；访客 Wi-Fi 的 AP 隔离会阻断 |

## 6. 回滚

- 移除 bundle：插件页移除 `dsh-pet-lan`；或从 profile `package.json` 的
  `dependencies` / `dsh.profile.bundles` 删掉 `dsh-pet-lan`；
- 删 `%USERPROFILE%\.dsh\plugins\dsh-pet-lan` 与 `dsh-pet-lan*.json`；
- dsh-pet 的 4 个文件可用同名 `*.dsh-pet-lan.bak` 还原。

## 给用户的发送模板（复制给同事的 AI）

```text
这是 DSH 桌宠联机插件压缩包。请先读包里的 AI-INSTALL.md，然后：

1. 检查 node 可用、当前 DSH profile、已安装 dsh-pet 0.3.7；
2. 解压到临时目录，运行：
   node "<解压目录>\dsh-pet-lan\scripts\install.mjs" --room Kunpo --port 41234
   （如果你有 plugin_manager 工具，改用 --no-register，再 install_bundle
   target="%USERPROFILE%\.dsh\plugins\dsh-pet-lan"，可免重启）
3. 如果需要重启 DSH 才能生效，先问我，不要自行重启；
4. 完成后检查设置 → 桌宠联机：房间 Kunpo、端口 41234、显示方式桌面窗口，
   以及 %USERPROFILE%\.dsh\dsh-pet-lan.status.json 里 udpReady/desktopReady 为 true。
```
