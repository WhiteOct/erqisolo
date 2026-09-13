# 二气传说 · 联机中继（Node 版）

与 `relay/`（Cloudflare 版）**同一套协议**，前端 `site/js/net.js` 只改一行地址就能切换。
单文件 `server.js`，唯一依赖是 `ws`。

> 为什么会有这一份：Cloudflare 的 `*.workers.dev` 在国内部分网络被墙，
> 而 Node 版可以放在 Render / Koyeb / 自己的服务器上，用它们自带的 `https/wss` 证书。

## 部署到 Render（免费，约 5 分钟）

1. **把本目录放进 GitHub 仓库**（可以就放在你现在那个站点的仓库里，例如 `relay-node/`；
   GitHub Pages 只会用 `site/` 目录，多一个文件夹不影响）
2. 打开 https://dashboard.render.com → 用 **GitHub 账号登录**（这个授权走 github.com，没有本地回调问题）
3. **New +** → **Web Service** → 选你的仓库 → Connect
4. 填写：
   | 项 | 值 |
   |---|---|
   | Name | `erqi-relay` |
   | **Region** | **Singapore**（离国内最近，延迟最低） |
   | **Root Directory** | `relay-node` |
   | Runtime | `Node` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |
   | Health Check Path | `/health` |
5. **Create Web Service** → 等第一次构建完成（约 1~3 分钟）
6. 拿到地址后，浏览器先打开 `https://erqi-relay-xxxx.onrender.com`
   - 应看到中文页面「联机中继运行正常」→ ✅
   - 再打开 `…/health` → 应返回 `{"ok":true,...}`

然后把前端地址改成：

```js
// site/js/net.js
const RELAY_URL = 'wss://erqi-relay-xxxx.onrender.com/ws';
```

### 临时试用（不改代码）
在页面网址后加参数即可（会被记住并写进邀请链接）：

```
https://你的页面/?relay=wss://erqi-relay-xxxx.onrender.com/ws
```
或在浏览器控制台执行一次：`ERQI_NET.setRelay('wss://erqi-relay-xxxx.onrender.com/ws')`

### 免费层须知
- 实例**闲置 15 分钟后休眠**，休眠后**第一次连接要等 20~60 秒**才会被唤醒（页面会停在「正在创建房间…」，属正常）。
  想避免：随便找个免费的定时 ping 服务（例如 UptimeRobot）每 10 分钟访问一次 `/health` 即可常驻。
- 我们的客户端每 20 秒发一次心跳，所以连接建立后**不会**因为闲置被断开。

## 本地运行 / 自己服务器

```bash
cd relay-node
npm install
npm start                     # 默认 http://127.0.0.1:8787
PORT=8080 npm start           # 自定义端口（Render 会用 env PORT）
```

自己服务器上跑的话，用 nginx/caddy 反代并配好证书（必须 `wss://`，因为游戏页面在 HTTPS 上，混用 `ws://` 会被浏览器拦）：

```nginx
location /ws {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header X-Forwarded-For $remote_addr;
}
```

## 自测（不需要联网、不需要账号）

```bash
npm test                                   # 27 项：真起服务 + 真 WebSocket 客户端
node _test_front_to_node_relay.mjs         # 17 项：真实游戏页面 ↔ 本中继（真 socket，逐回合对账）
```

## 协议
与 Cloudflare 版完全一致，见 `../relay/README.md` 的消息表。要点：
- 建房 `?create=1&name=…&dlc2022=1&dlc2023=1&timeout=60`，加入 `?code=XXXXXX&name=…`
- 出招只提交自己的招；**双方都提交后才同时揭晓**（`round`），服务端不透露先提交者的选择
- 每回合双方互报状态哈希，不一致则广播 `desync`
- 出招超时由**客户端**自动出招；服务端 5 秒粒度兜底（用恒定可用的「攒气」）
- 掉线 60s 宽限，超时判负；`sync` 拉历史续打；再战需双方各点一次
- 房间 TTL：大厅 10 分钟无人加入 / 结束后 5 分钟；单进程最多 500 个房间
- 不存 IP、不存账号；昵称只存在内存里的房间对象中，房间销毁即消失
