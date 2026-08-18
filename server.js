const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, 'index.html');

const rooms = new Map();
const LOGFILE = path.join(ROOT, 'server-events.log');
const RAW_FRAMES_LOG = path.join(ROOT, 'raw-frames.log');
function slog(obj) {
  try {
    fs.appendFileSync(LOGFILE, JSON.stringify({ ts: Date.now(), ...obj }) + '\n');
  } catch (e) {
    console.error('[SLOG-ERR]', String(e));
  }
}

function normalizeRoomCode(value) {
  const cleaned = String(value || 'PANGE-1').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10);
  return cleaned || 'PANGE-1';
}

function sanitizeName(value) {
  return String(value || 'Guest').trim().replace(/\s+/g, ' ').slice(0, 12) || 'Guest';
}

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { code, players: new Map(), aiCount: 0, host: null, gameStarted: false, gameData: null, roundReady: new Set() };
    rooms.set(code, room);
  }
  return room;
}

function broadcastRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  const players = Array.from(room.players.values()).map(player => ({ name: player.name }));
  const hostName = room.host && room.players.has(room.host) ? room.players.get(room.host).name : (players[0] ? players[0].name : '');
  const payload = {
    type: 'roomState',
    code,
    players,
    aiCount: room.aiCount || 0,
    hostName,
    gameStarted: !!room.gameStarted,
    gameData: room.gameData || null
  };
  const message = JSON.stringify(payload);
  for (const ws of room.players.keys()) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

function removeClient(ws) {
  const roomCode = ws.roomCode;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  room.players.delete(ws);
  room.roundReady = room.roundReady || new Set();
  const realPlayers = Array.isArray(room.gameData && room.gameData.realPlayers) ? room.gameData.realPlayers : [];
  for (const name of Array.from(room.roundReady)) {
    if (realPlayers.indexOf(name) === -1) room.roundReady.delete(name);
  }
  if (room.host === ws) {
    room.host = room.players.keys().next().value || null;
  }
  if (room.players.size === 0) {
    rooms.delete(roomCode);
    return;
  }
  broadcastRoom(roomCode);
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost');

  // Test-only graceful shutdown endpoint (local only)
  if (reqUrl.pathname === '/__shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid }));
    // allow response to flush
    setTimeout(() => process.exit(0), 50);
    return;
  }

  const safePath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
  const filePath = path.join(ROOT, safePath);

  if (filePath.startsWith(ROOT) === false) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (reqUrl.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, pid: process.pid, rooms: Array.from(rooms.keys()) }));
            return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };

    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      // raw message log for debugging play broadcasts
      try { console.log('[SERVER-RX]', String(data).slice(0,400)); } catch(e) {}
      try {
        // write an unconditional raw frame copy for deterministic debugging
        fs.appendFileSync(RAW_FRAMES_LOG, Date.now() + ' ' + String(data).replace(/\n/g,'\\n').slice(0,2000) + '\n');
      } catch(e) { console.error('[RAW-FRAMES-LOG-ERR]', String(e)); }
      try { slog({ event: '[SERVER-RX-RAW]', raw: String(data).slice(0,1000) }); } catch(e) {}
      const msg = JSON.parse(String(data));
      if (msg && msg.type === 'join') {
        const roomCode = normalizeRoomCode(msg.room);
        const room = getRoom(roomCode);
        if (room.gameStarted) return;
        const name = sanitizeName(msg.name);
        ws.roomCode = roomCode;
        if (!room.host) room.host = ws;
        room.players.set(ws, { name, id: Date.now() + Math.random() });
        const joinLog = { event: '[JOIN]', room: roomCode, player: name, totalPlayers: room.players.size, hostSet: !!room.host, players: Array.from(room.players.values()).map(p => p.name) };
        console.log(joinLog);
        try { slog(joinLog); } catch(e){}
        broadcastRoom(roomCode);
      }
      if (msg && msg.type === 'setLobby') {
        const roomCode = normalizeRoomCode(msg.room);
        const room = rooms.get(roomCode);
        if (!room || ws !== room.host || room.gameStarted) return;
        const aiCount = Math.max(0, Math.min(8 - room.players.size, Number(msg.aiCount) || 0));
        room.aiCount = aiCount;
        broadcastRoom(roomCode);
      }
      if (msg && msg.type === 'startGame') {
        const roomCode = normalizeRoomCode(msg.room);
        const room = rooms.get(roomCode);
        if (!room || ws !== room.host) return;
        const names = Array.isArray(msg.names) ? msg.names.slice(0, 8).map(name => sanitizeName(name)) : [];
        const realPlayers = Array.isArray(msg.realPlayers) ? msg.realPlayers.slice(0, 8).map(name => sanitizeName(name)) : Array.from(room.players.values()).map(player => sanitizeName(player.name)).slice(0, 8);
        const totalPlayers = Math.max(2, Math.min(8, Number(msg.totalPlayers) || names.length || room.players.size || 2));
        const seed = Number(msg.seed) || ((Date.now() * 214013 + Math.random() * 100000) >>> 0);
        room.gameStarted = true;
        room.gameData = {
          names,
          realPlayers,
          totalPlayers,
          mode: msg.mode || 'mixed',
          aiCount: Number(msg.aiCount) || 0,
          aiDifficulty: String(msg.aiDifficulty || 'medium'),
          seed,
          startedAt: Date.now()
        };
        room.roundReady = new Set();
        const recipients = [];
        for (const client of room.players.keys()) {
          if (client.readyState === client.OPEN) {
            const name = room.players.get(client) && room.players.get(client).name ? room.players.get(client).name : 'unknown';
            recipients.push({ name, isHost: client === room.host });
          }
        }
        const matchLog = { event: '[MATCH_START]', room: roomCode, realPlayers: realPlayers.slice(), names: names.slice(), recipients, emitMode: 'room.players.keys() inclusive loop' };
        console.log(matchLog);
        try { slog(matchLog); } catch(e){}
        for (const client of room.players.keys()) {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({
              type: 'startGame',
              room: roomCode,
              names,
              realPlayers,
              totalPlayers,
              aiCount: Number(msg.aiCount) || 0,
              aiDifficulty: String(msg.aiDifficulty || 'medium'),
              mode: msg.mode || 'mixed',
              seed
            }));
          }
        }
      }
      if (msg && msg.type === 'playerPrediction') {
        const roomCode = normalizeRoomCode(msg.room);
        const room = rooms.get(roomCode);
        if (!room || !room.gameData) return;
        const slot = Number(msg.slot);
        const value = msg.value;
        const predLog = { event: '[SERVER-PLAYER-PRED]', room: roomCode, slot, value, from: msg.player || 'unknown' };
        console.log(predLog);
        try { slog(predLog); } catch(e){}
        // Broadcast prediction to all clients in room (forward original payload)
        for (const client of room.players.keys()) {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({ type: 'playerPrediction', room: roomCode, slot, value, pred: msg.pred, predTurn: msg.predTurn, player: msg.player || '' }));
          }
        }
        return;
      }
      if (msg && msg.type === 'playerPlay') {
        const roomCode = normalizeRoomCode(msg.room);
        const room = rooms.get(roomCode);
        if (!room || !room.gameData) return;
        const slot = Number(msg.slot);
        const ev = msg.ev;
        const playLog = { event: '[SERVER-PLAYER-PLAY]', room: roomCode, slot, ev, from: msg.player || 'unknown', trickLen: Array.isArray(msg.trick) ? msg.trick.length : null };
        console.log(playLog);
        try { slog(playLog); } catch(e){}
        for (const client of room.players.keys()) {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({ type: 'playerPlay', room: roomCode, slot, ci: msg.ci, card: msg.card, ev: ev, trick: msg.trick, cur: msg.cur, player: msg.player || '', __mid: msg.__mid }));
          }
        }
        return;
      }
      if (msg && msg.type === 'roundReady') {
        const roomCode = normalizeRoomCode(msg.room);
        const room = rooms.get(roomCode);
        if (!room || !room.gameData) return;
        room.roundReady = room.roundReady || new Set();
        const realPlayers = Array.isArray(room.gameData.realPlayers) ? room.gameData.realPlayers.slice() : [];
        const playerName = sanitizeName(msg.playerName || msg.name || '');
        const slot = Number(msg.slot);
        const candidate = realPlayers[slot] || playerName;
        if (!candidate) return;
        if (realPlayers.indexOf(candidate) !== -1) room.roundReady.add(candidate);
        else if (playerName) room.roundReady.add(playerName);
        const readyPlayers = realPlayers.filter(name => room.roundReady.has(name));
        const allReady = realPlayers.length > 0 && readyPlayers.length === realPlayers.length;
        console.log('[READY]', { room: roomCode, readyPlayers: readyPlayers.slice(), totalRealPlayers: realPlayers.length, allReady });
        if (allReady) room.roundReady.clear();
        for (const client of room.players.keys()) {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({
              type: 'roundReadyState',
              room: roomCode,
              realPlayers,
              readyPlayers,
              allReady,
              totalRealPlayers: realPlayers.length
            }));
          }
        }
      }
    } catch (error) {
      // ignore malformed packets
    }
  });

  ws.on('close', () => removeClient(ws));
  ws.on('error', (err) => { console.error('[WS-ERROR]', String(err)); try { slog({ event: '[WS-ERROR]', err: String(err) }); } catch(e){} });
});

server.listen(PORT, () => {
  console.log(`Pange's Pili room server running on http://localhost:${PORT}`);
});
