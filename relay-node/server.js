/**
 * 二气传说 · 联机中继（Node 版，单文件）
 * ============================================================================
 * 与 relay/worker.js（Cloudflare 版）**同一套协议**，前端 site/js/net.js 只改一行地址即可切换。
 * 职责完全相同：房间码 → 房间、座位、暂存双方出招、双方都提交才揭晓、掉线宽限、
 *              超时兜底、房间 TTL、历史与状态哈希。服务端不跑游戏规则（联机无随机，两端本地结算）。
 *
 * 本地运行：  node server.js            （默认 http://127.0.0.1:8787）
 * 生产部署：  Render / Koyeb / 自己的服务器（见 README.md），监听 process.env.PORT
 * 依赖：      ws（唯一依赖，npm install 即可）
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 去掉易混的 0 O 1 I L
const CODE_LEN = 6;
const LOBBY_TTL_MS = 10 * 60 * 1000;   // 建房后一直没人加入
const OVER_TTL_MS = 5 * 60 * 1000;     // 对局结束后保留
const GRACE_MS = 60 * 1000;            // 掉线宽限
const MAX_HISTORY = 200;               // 历史回合上限
const MAX_ROOMS = 500;                 // 单进程房间上限（防止内存被刷爆）
const TICK_MS = 5000;                  // 定时器粒度
const KNOWN_MOVES = new Set(['charge', 'save', 'drain', 'enter', 'li', 'slash', 'trislash', 'wave', 'hammer',
  'gun', 'thunder', 'blade', 'mudslide', 'sneak', 'like', 'c42', 'do', 'pray', 'ldef', 'xdef', 'walk',
  'selfknife', 'exit', 'ji']);
const AUTO_MOVE = 'charge';            // 服务端兜底自动出招：攒气恒定可用

const now = () => Date.now();
const genCode = () => {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
};
const normCode = s => {
  const t = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return t.length === CODE_LEN ? t : '';
};

const STATUS_HTML = ts => `<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>二气传说 · 联机中继（Node 版）</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#070a18;color:#edf1ff;font-family:"Microsoft YaHei",system-ui,sans-serif;text-align:center;padding:24px}
 .card{max-width:440px} h1{font-size:22px;margin:0 0 8px}
 .ok{display:inline-block;width:10px;height:10px;border-radius:50%;background:#35c98b;margin-right:8px}
 p{color:#9aa3c8;font-size:14px;line-height:1.8;margin:8px 0}
 code{background:#242a4c;padding:2px 6px;border-radius:5px;font-size:13px} a{color:#5b96ff}
</style>
<div class="card">
  <h1><span class="ok"></span>联机中继运行正常</h1>
  <p>二气传说 · 房间码联机服务（Node 版）</p>
  <p>这是给游戏页面用的 WebSocket 服务；直接打开本页＝一切正常。</p>
  <p>健康检查：<a href="/health">/health</a> · 服务器时间 <code>${new Date().toISOString()}</code></p>
</div></html>`;

// ────────────────────────────── 房间 ──────────────────────────────
class Room {
  constructor(code) {
    this.code = code;
    this.sockets = new Map();   // seat -> ws
    this.doc = {
      code, createdAt: now(), status: 'lobby',
      settings: { dlc2022: true, dlc2023: true, timeoutSec: 60 },
      players: [
        { seat: 0, name: '玩家1', ready: false, connected: false },
        { seat: 1, name: '对手', ready: false, connected: false },
      ],
      round: 1, pending: { 0: null, 1: null }, deadline: null, graceUntil: null, overAt: null,
      history: [],
    };
  }
  send(seat, obj) {
    const ws = this.sockets.get(seat);
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
  }
  broadcast(obj, exceptSeat) {
    for (const [seat] of this.sockets) if (seat !== exceptSeat) this.send(seat, obj);
  }
  empty() { return this.sockets.size === 0; }
  roomView() {
    const d = this.doc;
    return {
      t: 'room', code: d.code, status: d.status, settings: d.settings, round: d.round,
      players: d.players.map(p => ({ seat: p.seat, name: p.name, ready: p.ready, connected: p.connected })),
    };
  }
  resolvePending() {
    const d = this.doc;
    const m0 = d.pending[0], m1 = d.pending[1];
    const entry = { round: d.round, moves: [m0.moveId, m1.moveId], auto: [!!m0.auto, !!m1.auto], hashes: [null, null], at: now() };
    d.history.push(entry);
    if (d.history.length > MAX_HISTORY) d.history.shift();
    d.pending = { 0: null, 1: null };
    d.round += 1;
    d.deadline = d.status === 'playing' ? now() + d.settings.timeoutSec * 1000 : null;
    this.broadcast({ t: 'round', round: entry.round, moves: entry.moves, auto: entry.auto });
    return entry;
  }
  // 与 Cloudflare 版逐条对齐的消息分发
  handle(ws, msg) {
    const d = this.doc;
    const seat = ws.__seat;
    const me = (seat === 0 || seat === 1) ? d.players[seat] : null;
    if (me) me.connected = true;
    switch (msg.t) {
      case 'ping': this.send(seat, { t: 'pong', at: now() }); return;
      case 'ready': {
        if (!me) return;
        me.ready = true;
        this.broadcast(this.roomView());
        if (d.status === 'lobby' && d.players[0].ready && d.players[1].ready && d.players[1].connected) {
          d.status = 'playing'; d.round = 1; d.pending = { 0: null, 1: null };
          d.deadline = now() + d.settings.timeoutSec * 1000;
          d.players.forEach(p => { p.ready = false; });
          this.broadcast({ t: 'start', round: 1, settings: d.settings, seats: [{ mp: 0, field: false, li: 0, ji: 0 }, { mp: 0, field: false, li: 0, ji: 0 }] });
        }
        return;
      }
      case 'move': {
        if (!me || d.status !== 'playing') { this.send(seat, { t: 'err', code: 'NOT_PLAYING' }); return; }
        if (!KNOWN_MOVES.has(msg.moveId)) { this.send(seat, { t: 'err', code: 'BAD_MOVE' }); return; }
        if (d.pending[seat]) { this.send(seat, { t: 'err', code: 'ALREADY_MOVED' }); return; }
        d.pending[seat] = { moveId: msg.moveId, auto: !!msg.auto, viaDo: !!msg.viaDo };
        this.broadcast({ t: 'locked', seat }, seat);
        if (d.pending[0] && d.pending[1]) this.resolvePending();
        else if (!d.deadline) d.deadline = now() + d.settings.timeoutSec * 1000;
        return;
      }
      case 'hash': {
        if (!me) return;
        const e = d.history.find(h => h.round === msg.round);
        if (e && typeof msg.h === 'string') {
          e.hashes[seat] = msg.h.slice(0, 64);
          const other = 1 - seat;
          if (e.hashes[other] && e.hashes[other] !== e.hashes[seat]) this.broadcast({ t: 'desync', round: msg.round, hashes: e.hashes });
        }
        return;
      }
      case 'sync': {
        this.send(seat, {
          t: 'sync', code: d.code, status: d.status, settings: d.settings, round: d.round,
          history: d.history, pending: { me: d.pending[seat] || null }, players: this.roomView().players, deadline: d.deadline,
        });
        return;
      }
      case 'rematch': {
        if (!me) return;
        me.ready = true;
        this.broadcast(this.roomView());
        if (d.players[0].ready && d.players[1].ready && d.players[0].connected && d.players[1].connected) {
          d.status = 'playing'; d.round = 1; d.pending = { 0: null, 1: null };
          d.history = []; d.overAt = null; d.graceUntil = null;
          d.deadline = now() + d.settings.timeoutSec * 1000;
          d.players.forEach(p => { p.ready = false; });
          this.broadcast({ t: 'start', round: 1, rematch: true, settings: d.settings, seats: [{ mp: 0, field: false, li: 0, ji: 0 }, { mp: 0, field: false, li: 0, ji: 0 }] });
        }
        return;
      }
      case 'end': {
        if (!me) return;
        d.status = 'over'; d.overAt = now();
        this.broadcast({ t: 'ended', reason: msg.reason || 'finished', winnerSeat: typeof msg.winnerSeat === 'number' ? msg.winnerSeat : null });
        return;
      }
      case 'leave': { this.dropSeat(seat); return; }
      default: this.send(seat, { t: 'err', code: 'UNKNOWN_TYPE' });
    }
  }
  dropSeat(seat) {
    const d = this.doc;
    if (seat !== 0 && seat !== 1) return;
    const me = d.players[seat];
    if (me) { me.connected = false; me.ready = false; }
    this.broadcast({ t: 'peer', seat, connected: false, graceLeft: Math.round(GRACE_MS / 1000) });
    if (d.status === 'playing') d.graceUntil = now() + GRACE_MS;
  }
  // 周期检查：出招超时兜底 / 掉线宽限判负 / 房间生命周期
  tick() {
    const d = this.doc, t = now();
    if (d.status === 'playing' && d.deadline && t >= d.deadline) {
      for (const seat of [0, 1]) {
        if (!d.pending[seat]) {
          d.pending[seat] = { moveId: AUTO_MOVE, auto: true };
          this.broadcast({ t: 'notice', kind: 'timeout', seat });
        }
      }
      this.resolvePending();
      return true;
    }
    if (d.status === 'playing' && d.graceUntil && t >= d.graceUntil) {
      const gone = d.players.find(p => !p.connected);
      d.status = 'over'; d.overAt = t;
      this.broadcast({ t: 'ended', reason: 'peer-left', winnerSeat: gone ? 1 - gone.seat : null });
      return true;
    }
    if (d.status === 'lobby' && t - d.createdAt > LOBBY_TTL_MS) return 'destroy';
    if (d.status === 'over' && d.overAt && t - d.overAt > OVER_TTL_MS) return 'destroy';
    return false;
  }
}

// ────────────────────────────── 中继服务 ──────────────────────────────
export function createRelay(opts = {}) {
  const rooms = new Map();
  const rateMap = new Map();
  const allow = (key, limit = 30, windowMs = 60 * 1000) => {
    const t = now(), rec = rateMap.get(key);
    if (!rec || t - rec.start > windowMs) { rateMap.set(key, { start: t, n: 1 }); return true; }
    rec.n++; return rec.n <= limit;
  };

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, ts: now(), service: 'erqi-relay-node', rooms: rooms.size }));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(STATUS_HTML());
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('erqi-relay-node: use /ws');
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'anon').split(',')[0].trim();
    if (!allow('ws:' + ip)) { ws.send(JSON.stringify({ t: 'err', code: 'RATE_LIMITED' })); ws.close(1008, 'rate'); return; }
    const isCreate = url.searchParams.get('create') === '1';
    const code = isCreate ? '' : normCode(url.searchParams.get('code'));
    const name = String(url.searchParams.get('name') || '').slice(0, 12) || '对手';
    const reject = (codeStr) => { try { ws.send(JSON.stringify({ t: 'err', code: codeStr })); } catch (e) {} ws.close(1000, codeStr); };

    if (!isCreate && !code) return reject('BAD_CODE');

    let room = null, seat = -1;
    if (isCreate) {
      if (rooms.size >= MAX_ROOMS) return reject('SERVER_FULL');
      let candidate = genCode();
      for (let i = 0; i < 5 && rooms.has(candidate); i++) candidate = genCode();
      room = new Room(candidate);
      rooms.set(candidate, room);
      seat = 0;
      room.doc.players[0].name = name;
      room.doc.settings.dlc2022 = url.searchParams.get('dlc2022') !== '0';
      room.doc.settings.dlc2023 = url.searchParams.get('dlc2023') !== '0';
      room.doc.settings.timeoutSec = Math.min(300, Math.max(15, Number(url.searchParams.get('timeout') || 60)));
    } else {
      room = rooms.get(code);
      if (!room) return reject('NO_ROOM');
      if (room.doc.players[1].connected || room.sockets.has(1)) return reject('ROOM_FULL');
      if (room.doc.status === 'over') return reject('ROOM_ENDED');
      seat = 1;
      room.doc.players[1].name = name;
      room.doc.graceUntil = null;
    }
    ws.__seat = seat;
    room.doc.players[seat].connected = true;
    room.sockets.set(seat, ws);

    if (seat === 0) {
      ws.send(JSON.stringify({ t: 'created', code: room.code, seat, settings: room.doc.settings }));
    } else {
      ws.send(JSON.stringify({ t: 'joined', code: room.code, seat, settings: room.doc.settings }));
    }
    room.broadcast(room.roomView());

    ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(String(raw)); } catch (e) { try { ws.send(JSON.stringify({ t: 'err', code: 'BAD_JSON' })); } catch (e2) {} return; }
      if (!msg || !msg.t) return;
      try { room.handle(ws, msg); } catch (e) { /* 单条消息异常不影响房间 */ }
    });
    ws.on('close', () => {
      if (room.sockets.get(seat) === ws) room.sockets.delete(seat);
      room.dropSeat(seat);
    });
    ws.on('error', () => { /* close 会跟进 */ });
  });

  // 周期任务：超时兜底 / 宽限判负 / 房间回收
  const ticker = setInterval(() => {
    for (const [code, room] of rooms) {
      const r = room.tick();
      if (r === 'destroy' || (room.empty() && room.doc.status !== 'playing')) {
        for (const [, ws] of room.sockets) { try { ws.close(1000, 'room-expired'); } catch (e) {} }
        rooms.delete(code);
      }
    }
    // 限流窗口清理
    const t = now();
    for (const [k, v] of rateMap) if (t - v.start > 5 * 60 * 1000) rateMap.delete(k);
  }, TICK_MS);
  if (ticker.unref) ticker.unref();

  return {
    httpServer, wss, rooms,
    listen(port) { return new Promise(res => httpServer.listen(port, () => res(httpServer.address().port))); },
    close() { clearInterval(ticker); try { wss.close(); } catch (e) {} try { httpServer.close(); } catch (e) {} },
  };
}

// 直接运行（node server.js）时才监听端口
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const PORT = Number(process.env.PORT || 8787);
  const relay = createRelay();
  relay.listen(PORT).then(p => {
    console.log('二气传说 · 联机中继（Node 版）已启动');
    console.log('  本地地址     ws://127.0.0.1:' + p + '/ws');
    console.log('  健康检查     http://127.0.0.1:' + p + '/health');
    console.log('  前端请把 site/js/net.js 的 RELAY_URL 指到 ws(s)://<你的域名>/ws');
  });
}
