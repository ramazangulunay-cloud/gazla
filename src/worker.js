// GAZLA! — Cloudflare Worker + Durable Object oda sunucusu
// Her oda adı bir Durable Object'e eşlenir. Oyuncular WebSocket ile bağlanır ve
// "presence" (anlık durum) yamalarını gönderir; sunucu bunları birleştirip odadaki herkese dağıtır.
import { DurableObject } from 'cloudflare:workers';

const MAX_PEERS = 12;
const MAX_MSG = 8000;          // bayt
const RATE = 60;               // saniyede en fazla mesaj (oyuncu başı)
const HEAVY = ['s', 'it', 'u']; // yarış sırasında her karede değişen alanlar (eke yazılmaz)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket bekleniyordu', { status: 426 });
      const room = (url.searchParams.get('room') || '').toLowerCase();
      if (!/^[a-z0-9-]{1,40}$/.test(room)) return new Response('Geçersiz oda', { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      return stub.fetch(req);
    }
    if (url.pathname === '/health') return new Response('ok');
    return env.ASSETS.fetch(req);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.peers = new Map(); // id -> { ws, p, tok, last }
    // Hibernasyondan uyanınca oyuncuları eklerinden geri kur
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.id) this.peers.set(a.id, { ws, p: a.p || {}, tok: RATE, last: Date.now() });
    }
    // "ping" → "pong" otomatik yanıt: odayı uyandırmadan bağlantıyı canlı tutar
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req) {
    const url = new URL(req.url);
    const quick = url.searchParams.get('quick') === '1';
    let id = (url.searchParams.get('id') || '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
    if (id.length < 6) id = Math.random().toString(36).slice(2, 12);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    // aynı kimlikle yeniden bağlanan oyuncunun eski bağlantısını kapat
    const old = this.peers.get(id);
    if (old) { try { old.ws.close(4000, 'yeniden bağlandı'); } catch (e) { } this.peers.delete(id); }
    const busy = [...this.peers.values()].some(x => x.p && x.p.rid);
    if (this.peers.size >= MAX_PEERS || (quick && busy)) {
      server.send(JSON.stringify({ t: 'full', busy }));
      server.close(4001, 'dolu');
      return new Response(null, { status: 101, webSocket: client });
    }
    const keep = old ? old.p : {};
    this.peers.set(id, { ws: server, p: keep, tok: RATE, last: Date.now() });
    server.serializeAttachment({ id, p: light(keep) });
    const list = [];
    for (const [pid, x] of this.peers) if (pid !== id) list.push({ id: pid, p: x.p, a: Date.now() - x.last });
    server.send(JSON.stringify({ t: 'hello', you: id, peers: list, max: MAX_PEERS }));
    this.broadcast({ t: 'join', id }, id);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    const a = ws.deserializeAttachment(); if (!a) return;
    const me = this.peers.get(a.id); if (!me || me.ws !== ws) return;
    if (typeof msg !== 'string' || msg.length > MAX_MSG) return;
    // jeton kovası hız sınırı
    const now = Date.now();
    me.tok = Math.min(RATE, me.tok + (now - me.last) / 1000 * RATE);
    me.last = now;
    if (me.tok < 1) return;
    me.tok -= 1;
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    if (!m || m.t !== 'p' || typeof m.d !== 'object' || m.d === null || Array.isArray(m.d)) return;
    let lightChanged = false;
    for (const [k, v] of Object.entries(m.d)) {
      if (k.length > 8) continue;
      if (v === null) delete me.p[k]; else me.p[k] = v;
      if (!HEAVY.includes(k)) lightChanged = true;
    }
    if (lightChanged) { try { ws.serializeAttachment({ id: a.id, p: light(me.p) }); } catch (e) { } }
    this.broadcast({ t: 'p', id: a.id, d: m.d }, a.id);
  }

  async webSocketClose(ws) { this.drop(ws); }
  async webSocketError(ws) { this.drop(ws); }

  drop(ws) {
    const a = ws.deserializeAttachment(); if (!a) return;
    const me = this.peers.get(a.id);
    if (me && me.ws === ws) { this.peers.delete(a.id); this.broadcast({ t: 'leave', id: a.id }, a.id); }
    try { ws.close(1000, 'bye'); } catch (e) { }
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const [pid, x] of this.peers) {
      if (pid === except) continue;
      try { x.ws.send(s); } catch (e) { }
    }
  }
}

function light(p) {
  const o = {};
  for (const k in p) if (!HEAVY.includes(k)) o[k] = p[k];
  const s = JSON.stringify(o);
  return s.length < 1800 ? o : { n: o.n, rdy: o.rdy, rid: o.rid };
}
