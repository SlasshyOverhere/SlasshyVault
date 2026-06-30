const WORKER_VERSION = 1;
const ALLOWED_PATH = /^\/r\/([A-Z0-9]{4,8})$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, version: WORKER_VERSION }), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }
    const m = url.pathname.match(ALLOWED_PATH);
    if (!m) return new Response("not found", { status: 404 });
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const roomCode = m[1];
    const id = env.ROOM.idFromName(roomCode);
    const stub = env.ROOM.get(id);
    return stub.fetch(req);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.peers = new Map();
    this.syncState = null;
    this.hostClientId = null;
    this.started = false;
    this.lastActivity = Date.now();
  }

  async fetch(req) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener("message", (ev) => this.onMessage(server, ev));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(socket, ev) {
    let msg;
    try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data)); }
    catch { return; }
    this.lastActivity = Date.now();
    switch (msg.t) {
      case "hello": return this.handleHello(socket, msg);
      case "profile": return this.handleProfile(socket, msg);
      case "leave": return this.handleLeave(socket);
      case "state": return this.handleState(socket, msg);
      case "cmd": return this.handleCommand(socket, msg);
      case "chat": return this.handleChat(socket, msg);
      case "ready": return this.handleReady(socket, msg);
      case "host-leaving": return this.handleHostLeaving(socket);
      case "claim-host": return this.handleClaimHost(socket, msg);
      case "start": return this.handleStart(socket);
      case "ping": return this.send(socket, { t: "pong" });
    }
  }

  handleReady(socket, msg) {
    const peer = this.peers.get(socket);
    if (!peer) return;
    peer.ready = !!msg.ready;
    this.broadcast({ t: "participant-ready", clientId: peer.clientId, ready: peer.ready });
  }

  handleClaimHost(socket, msg) {
    const peer = this.peers.get(socket);
    if (!peer) return;
    if (this.hostClientId === peer.clientId && !msg.fresh) return;
    this.hostClientId = peer.clientId;
    this.broadcast({ t: "host", hostClientId: this.hostClientId });
    if (msg.fresh) {
      this.started = false;
      this.broadcast({ t: "started", started: false });
      for (const p of this.peers.values()) p.ready = false;
    }
  }

  handleStart(socket) {
    const peer = this.peers.get(socket);
    if (!peer || this.hostClientId !== peer.clientId) return;
    this.started = true;
    this.broadcast({ t: "started", started: true });
  }

  handleHostLeaving(socket) {
    const peer = this.peers.get(socket);
    if (!peer || this.hostClientId !== peer.clientId) return;
    this.broadcast({ t: "host-leaving", from: peer.clientId, name: peer.name, at: Date.now() });
    this.reassignHost(peer.clientId);
  }

  reassignHost(excludeClientId) {
    let next = null;
    for (const p of this.peers.values()) {
      if (excludeClientId && p.clientId === excludeClientId) continue;
      if (!next || p.joinedAt < next.joinedAt) next = p;
    }
    this.hostClientId = next ? next.clientId : null;
    this.broadcast({ t: "host", hostClientId: this.hostClientId });
  }

  handleHello(socket, msg) {
    if (!msg.clientId) {
      this.send(socket, { t: "error", code: "missing_client_id", message: "clientId required" });
      socket.close(1008, "missing_client_id");
      return;
    }
    const name = (msg.name || "Guest").toString().slice(0, 32);
    const peer = { socket, clientId: msg.clientId, name, joinedAt: Date.now(), ready: false, lastStateAt: 0 };
    for (const [s, p] of this.peers) {
      if (p.clientId === msg.clientId && s !== socket) {
        try { s.close(1000, "replaced"); } catch {}
        this.peers.delete(s);
      }
    }
    this.peers.set(socket, peer);
    const becameHost = !this.hostClientId;
    if (becameHost) this.hostClientId = peer.clientId;
    const participants = Array.from(this.peers.values()).map(p => ({ id: p.clientId, name: p.name, joinedAt: p.joinedAt, ready: p.ready }));
    this.send(socket, { t: "joined", room: "", participants, state: this.syncState, hostClientId: this.hostClientId, started: this.started });
    this.broadcast({ t: "participant-joined", participant: { id: peer.clientId, name: peer.name, joinedAt: peer.joinedAt, ready: false } }, socket);
    if (becameHost) this.broadcast({ t: "host", hostClientId: this.hostClientId }, socket);
  }

  handleProfile(socket, msg) {
    const peer = this.peers.get(socket);
    if (!peer) return;
    if (typeof msg.name === "string" && msg.name.trim()) peer.name = msg.name.slice(0, 32);
    this.broadcast({ t: "participant-profile", participant: { id: peer.clientId, name: peer.name } });
  }

  handleLeave(socket) {
    const peer = this.peers.get(socket);
    if (!peer) return;
    this.peers.delete(socket);
    this.broadcast({ t: "participant-left", clientId: peer.clientId, name: peer.name });
    if (this.hostClientId === peer.clientId) this.reassignHost();
    try { socket.close(1000, "left"); } catch {}
  }

  handleState(socket, msg) {
    const peer = this.peers.get(socket);
    if (!peer || !msg.state) return;
    const incoming = msg.state;
    if (typeof incoming.positionSeconds !== "number" || !isFinite(incoming.positionSeconds) || incoming.positionSeconds < 0) return;
    if (typeof incoming.updatedAt !== "number" || !isFinite(incoming.updatedAt)) return;
    if (typeof incoming.playing !== "boolean") return;
    if (typeof incoming.updatedBy !== "string" || incoming.updatedBy !== peer.clientId) return;
    const isHostWrite = this.hostClientId != null && peer.clientId === this.hostClientId;
    if (this.hostClientId != null && !isHostWrite) return;
    const now = Date.now();
    if (!isHostWrite) {
      if (now - peer.lastStateAt < 500) return;
      if (this.syncState && incoming.updatedAt < this.syncState.updatedAt - 2000) return;
    }
    peer.lastStateAt = now;
    const stamped = { ...incoming, hostClientId: this.hostClientId };
    this.syncState = stamped;
    this.broadcast({ t: "state", state: stamped, srvAt: now }, socket);
  }

  handleCommand(socket, msg) {
    const peer = this.peers.get(socket);
    if (!peer || !msg.command) return;
    const c = msg.command;
    if (c.action !== "play" && c.action !== "pause" && c.action !== "seek") return;
    if (c.action === "seek" && (typeof c.positionSeconds !== "number" || !isFinite(c.positionSeconds) || c.positionSeconds < 0)) return;
    if (!this.hostClientId || peer.clientId === this.hostClientId) return;
    for (const [s, p] of this.peers) {
      if (p.clientId === this.hostClientId) {
        this.send(s, { t: "cmd", from: peer.clientId, command: c });
        return;
      }
    }
  }

  handleChat(socket, msg) {
    const peer = this.peers.get(socket);
    if (!peer) return;
    const text = (msg.text || "").toString().trim().slice(0, 500);
    if (!text) return;
    this.broadcast({ t: "chat", from: peer.clientId, name: peer.name, text, at: Date.now() });
  }

  onClose(socket) {
    const peer = this.peers.get(socket);
    if (!peer) return;
    this.peers.delete(socket);
    this.broadcast({ t: "participant-left", clientId: peer.clientId, name: peer.name });
    if (this.hostClientId === peer.clientId) this.reassignHost();
    if (this.peers.size === 0 && Date.now() - this.lastActivity > 6 * 60 * 60 * 1000) {
      this.syncState = null; this.hostClientId = null; this.started = false;
    }
  }

  send(socket, msg) { try { socket.send(JSON.stringify(msg)); } catch {} }
  broadcast(msg, except) {
    const payload = JSON.stringify(msg);
    for (const [s] of this.peers) { if (s === except) continue; try { s.send(payload); } catch {} }
  }
}
