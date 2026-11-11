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
    if (url.pathname === '/sync') {
      // WebSocket'in engellendiği ağlar için HTTP ile senkron (yedek yol)
      if (req.method !== 'POST') return new Response('POST bekleniyordu', { status: 405 });
      const room = (url.searchParams.get('room') || '').toLowerCase();
      if (!/^[a-z0-9-]{1,40}$/.test(room)) return new Response('Geçersiz oda', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
    }
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket bekleniyordu', { status: 426 });
      const room = (url.searchParams.get('room') || '').toLowerCase();
      if (!/^[a-z0-9-]{1,40}$/.test(room)) return new Response('Geçersiz oda', { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      try { return await stub.fetch(req); }
      catch (e) { console.error('ws hata', room, e && e.stack || e); return new Response('Oda hatası: ' + (e && e.message), { status: 500 }); }
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
    try {
      const url = new URL(req.url);
      if (url.pathname === '/sync') return await this.sync(req, url);
      return this.handle(req);
    } catch (e) { console.error('DO hata', e && e.stack || e); throw e; }
  }

  // HTTP oyuncusu: her istekte tam durumunu gönderir, karşılığında diğerlerinin durumunu alır
  async sync(req, url) {
    const now = Date.now();
    const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    for (const [pid, x] of this.peers) if (x.http && now - x.seen > 6000) { this.peers.delete(pid); this.broadcast({ t: 'leave', id: pid }, pid); }
    const id = (url.searchParams.get('id') || '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
    if (id.length < 6) return new Response('kimlik yok', { status: 400 });
    const quick = url.searchParams.get('quick') === '1';
    const body = await req.text();
    if (body.length > MAX_MSG) return new Response('çok büyük', { status: 413 });
    let m = null; try { m = JSON.parse(body); } catch (e) { }
    let me = this.peers.get(id);
    if (url.searchParams.get('bye') === '1') { if (me && me.http) { this.peers.delete(id); this.broadcast({ t: 'leave', id }, id); } return json({ t: 'bye' }); }
    if (me && !me.http) { try { me.ws.close(4000, 'http'); } catch (e) { } this.peers.delete(id); me = null; }
    if (!me) {
      const busy = [...this.peers.values()].some(x => x.p && x.p.rid);
      if (this.peers.size >= MAX_PEERS) return json({ t: 'full', busy });
      me = { http: true, p: {}, tok: RATE, last: now, seen: now, upd: now };
      this.peers.set(id, me);
      this.broadcast({ t: 'join', id }, id);
    }
    me.tok = Math.min(RATE, me.tok + (now - me.last) / 1000 * RATE); me.last = now; me.seen = now;
    if (me.tok >= 1 && m && m.p && typeof m.p === 'object' && !Array.isArray(m.p)) {
      me.tok -= 1;
      const np = {}; for (const [k, v] of Object.entries(m.p)) if (k.length <= 8 && v !== null) np[k] = v;
      const d = { ...np }; let changed = false;
      for (const k in me.p) if (!(k in np)) { d[k] = null; changed = true; }
      if (!changed) changed = JSON.stringify(np) !== JSON.stringify(me.p);
      if (changed) { me.p = np; me.upd = now; this.broadcast({ t: 'p', id, d }, id); }
    }
    const peers = [];
    for (const [pid, x] of this.peers) if (pid !== id) peers.push({ id: pid, p: x.p, a: now - (x.upd || x.last) });
    return json({ t: 'sync', you: id, peers, max: MAX_PEERS });
  }

  handle(req) {
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
    if (this.peers.size >= MAX_PEERS) {
      server.send(JSON.stringify({ t: 'full', busy }));
      server.close(4001, 'dolu');
      return new Response(null, { status: 101, webSocket: client });
    }
    const keep = old ? old.p : {};
    this.peers.set(id, { ws: server, p: keep, tok: RATE, last: Date.now() });
    server.serializeAttachment({ id, p: light(keep) });
    const list = [];
    for (const [pid, x] of this.peers) if (pid !== id) list.push({ id: pid, p: x.p, a: Date.now() - (x.upd || x.last) });
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
    me.upd = now;
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
      if (pid === except || x.http) continue;
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
