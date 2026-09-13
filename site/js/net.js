/**
 * 二气传说 · 联机传输适配器（房间码中继）
 * ------------------------------------------------------------------
 * 只负责「连接 / 收发 / 断线重连 / 心跳」，不含任何游戏规则。
 * 部署中继后把下面的 RELAY_URL 换成你的地址即可（形如 wss://erqi-relay.xxx.workers.dev/ws）。
 * 没配置时 isConfigured() 返回 false，页面会让联机入口提示「联机服务未配置」，单人模式不受影响。
 */
(function () {
  const RELAY_URL = '';   // ← 填入你的中继地址（Render 部署后形如 wss://erqi-relay-xxxx.onrender.com/ws）
  //   也可以不改这里，用网址参数临时指定：你的页面/?relay=wss://xxx.onrender.com/ws
  const HEARTBEAT_MS = 20000;     // 心跳间隔
  const MAX_RETRY = 5;            // 断线自动重连次数（指数退避）

  // 中继地址的三层解析（方便部署后立刻自测，不用等改代码）：
  //   1) URL 参数：            https://你的页面/?relay=wss://xxx.workers.dev/ws
  //   2) localStorage 覆盖：   控制台执行 ERQI_NET.setRelay('wss://xxx.workers.dev/ws')
  //   3) 上面的 RELAY_URL 常量：正式发布用这个
  function resolveRelayUrl() {
    try {
      const q = new URLSearchParams((typeof location !== 'undefined' && location.search) || '').get('relay');
      if (q && /^wss?:\/\//i.test(q)) return q;
    } catch (e) {}
    try {
      const s = localStorage.getItem('erqi.relay');
      if (s && /^wss?:\/\//i.test(s)) return s;
    } catch (e) {}
    return RELAY_URL;
  }
  function setRelay(url) {
    try { url ? localStorage.setItem('erqi.relay', url) : localStorage.removeItem('erqi.relay'); } catch (e) {}
    return resolveRelayUrl();
  }

  function isConfigured() { return /^wss?:\/\/\S+/i.test(resolveRelayUrl()); }

  // 建立一条到中继的连接。返回的对象只暴露 send / close / on / onState / state
  function createNet() {
    let ws = null, hb = null, retryTimer = null, retry = 0, closedByUs = false;
    let handlers = {};
    const net = {
      seat: 0, code: '', status: 'idle', ready: false, error: '', settings: null, lastSync: 0,
      name: '',
      on(fn) { handlers.msg = fn; return net; },
      onState(fn) { handlers.state = fn; return net; },
      state() {
        return {
          status: net.status, code: net.code, seat: net.seat, ready: net.ready,
          error: net.error, retry, configured: isConfigured(), relay: resolveRelayUrl(),
        };
      },
      emit() { if (handlers.state) handlers.state(net.state()); },
      setStatus(s, err) { net.status = s; if (err !== undefined) net.error = err; net.emit(); },
      send(obj) {
        if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; } }
        return false;
      },
      url(qs) { const base = resolveRelayUrl(); return base + (base.indexOf('?') >= 0 ? '&' : '?') + qs; },
      connect(opts) {
        opts = opts || {};
        closedByUs = false;
        net.name = opts.name || '';
        net.setStatus(retry ? 'reconnecting' : 'connecting');
        const qs = opts.create
          ? 'create=1&name=' + encodeURIComponent(net.name) +
            '&dlc2022=' + (opts.dlc2022 ? 1 : 0) + '&dlc2023=' + (opts.dlc2023 ? 1 : 0) +
            '&timeout=' + (opts.timeoutSec || 60)
          : 'code=' + encodeURIComponent((opts.code || '').toUpperCase()) + '&name=' + encodeURIComponent(net.name);
        try { ws = new WebSocket(net.url(qs)); }
        catch (e) { net.setStatus('error', '无法建立连接'); return net; }

        ws.onopen = () => {
          retry = 0;
          net.setStatus('open');
          clearInterval(hb);
          hb = setInterval(() => net.send({ t: 'ping' }), HEARTBEAT_MS);
          if (opts.resume) net.send({ t: 'sync' });   // 重连成功后拉取历史续打
        };
        ws.onmessage = (ev) => {
          let msg = null;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          if (!msg || !msg.t) return;
          if (msg.t === 'created' || msg.t === 'joined') {
            net.code = msg.code; net.seat = msg.seat; net.settings = msg.settings || null;
            net.setStatus('lobby');
          } else if (msg.t === 'start') {
            net.setStatus('playing'); net.ready = false;
          } else if (msg.t === 'room') {
            net.code = msg.code;
          } else if (msg.t === 'err') {
            net.error = msg.code;
            if (msg.code === 'NO_ROOM' || msg.code === 'ROOM_FULL' || msg.code === 'ROOM_ENDED' ||
                msg.code === 'BAD_CODE' || msg.code === 'CODE_TAKEN') net.setStatus('error', msg.code);
          }
          if (handlers.msg) handlers.msg(msg);
        };
        ws.onclose = () => {
          clearInterval(hb);
          if (closedByUs) { net.setStatus('closed'); return; }
          if (retry >= MAX_RETRY) { net.setStatus('error', '连接已断开'); return; }
          retry++;
          const wait = Math.min(8000, 1000 * Math.pow(2, retry - 1));
          net.setStatus('reconnecting');
          retryTimer = setTimeout(() => net.connect(Object.assign({}, opts, { resume: !!net.code })), wait);
        };
        ws.onerror = () => { /* onclose 会跟进处理 */ };
        return net;
      },
      close() {
        closedByUs = true;
        clearInterval(hb); clearTimeout(retryTimer);
        if (ws) { try { ws.close(); } catch (e) {} }
        ws = null;
        net.setStatus('closed');
      },
    };
    return net;
  }

  globalThis.ERQI_NET = { createNet, isConfigured, setRelay, relayUrl: resolveRelayUrl, RELAY_URL };
})();
