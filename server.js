// ボタンルーム脱出 - ゲームサーバー (Node.js + ws)
// 起動: npm install && npm start  → http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const GAME_TIME = 5 * 60e3;  // 制限時間 5分
const WALL_NAMES = ['北', '東', '南', '西'];

// ボタン数の段階 (1面あたり cols × rows、4面なので合計 = cols*rows*4)
const SIZES = {
  s:  { cols: 4,  rows: 2 },   //  32個
  m:  { cols: 6,  rows: 3 },   //  72個
  l:  { cols: 8,  rows: 4 },   // 128個
  xl: { cols: 10, rows: 5 },   // 200個
};

function makeLevel(key) {
  const { cols, rows } = SIZES[key] || SIZES.s;
  const per = cols * rows, n = per * 4;
  const sx = cols <= 4 ? 4 : 2.8;                       // ボタンの横間隔
  const half = Math.max(10, cols * sx / 2 + 1.2);       // 部屋の半幅
  return { cols, rows, per, n, sx, half };
}

// 出口1 + ヒント19% + 凍結19% + 暗闇12.5% + ワープ12.5% + 残りハズレ
function makePool(n) {
  const h = Math.round(n * 0.19), f = Math.round(n * 0.19);
  const d = Math.round(n * 0.125), w = Math.round(n * 0.125);
  const none = n - 1 - h - f - d - w;
  return [
    'exit',
    ...Array(h).fill('hint'), ...Array(f).fill('freeze'),
    ...Array(d).fill('dark'), ...Array(w).fill('warp'),
    ...Array(none).fill('none'),
  ];
}

// ---------- HTTP (静的配信) ----------
const server = http.createServer((req, res) => {
  const file = path.join(__dirname, 'public', 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); res.end('error'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ---------- ユーティリティ ----------
const rooms = new Map();
let nextId = 1;

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const bcast = (room, o) => { for (const p of room.players.values()) send(p.ws, o); };
const rand = (a, b) => a + Math.random() * (b - a);
const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const genCode = () => {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
  return rooms.has(s) ? genCode() : s;
};

function newRoom(code) {
  return {
    code, phase: 'lobby', host: null, players: new Map(),
    level: null, types: [], exitId: -1, pressed: new Set(), hintsGiven: new Set(),
    timer: null, ticker: null, endsAt: 0,
  };
}

function lobbyInfo(room) {
  return {
    t: 'lobby', room: room.code, host: room.host,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, slot: p.slot })),
  };
}

// ---------- ゲーム進行 ----------
function startGame(room, sizeKey) {
  room.phase = 'playing';
  room.level = makeLevel(sizeKey);
  room.types = shuffle(makePool(room.level.n));
  room.exitId = room.types.indexOf('exit');
  room.pressed = new Set();
  room.hintsGiven = new Set();
  room.endsAt = Date.now() + GAME_TIME;

  const list = [...room.players.values()];
  const spawns = {};
  list.forEach((p, i) => {
    const a = (i / list.length) * Math.PI * 2;
    p.x = Math.cos(a) * 2.5; p.z = Math.sin(a) * 2.5; p.ry = 0;
    p.frozenUntil = 0;
    spawns[p.id] = [p.x, p.z];
  });
  const L = room.level;
  bcast(room, { t: 'start', remain: GAME_TIME, spawns, n: L.n, cols: L.cols, rows: L.rows, half: L.half, sx: L.sx });

  room.timer = setTimeout(() => endGame(room, null), GAME_TIME);
  room.ticker = setInterval(() => {
    bcast(room, {
      t: 'players',
      list: [...room.players.values()].map(p => ({ id: p.id, x: p.x, z: p.z, ry: p.ry })),
    });
  }, 100);
}

function endGame(room, winner) {
  if (room.phase !== 'playing') return;
  room.phase = 'ended';
  clearTimeout(room.timer); clearInterval(room.ticker);
  bcast(room, {
    t: 'end', exitId: room.exitId,
    winner: winner ? { id: winner.id, name: winner.name } : null,
  });
}

// 出口について本当のことだけを言うヒントを作る
function genHint(room) {
  const { cols, rows, per, n } = room.level;
  const e = room.exitId, num = e + 1;
  const w = Math.floor(e / per), k = e % per, c = k % cols, r = Math.floor(k / cols);
  const pick = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const cands = [];
  for (let x = 0; x < 4; x++) if (x !== w) cands.push(`出口は【${WALL_NAMES[x]}の壁】にはない`);
  cands.push(`出口は【${WALL_NAMES[w]}の壁】か【${WALL_NAMES[(w + 2) % 4]}の壁】のどちらかにある`);
  // 段 (下から / 上から)
  if (r + 1 <= rows - 1) cands.push(`出口は壁の【下から${pick(r + 1, rows - 1)}段目以内】にある`);
  const tr = rows - 1 - r;
  if (tr + 1 <= rows - 1) cands.push(`出口は壁の【上から${pick(tr + 1, rows - 1)}段目以内】にある`);
  // 列 (壁を正面から見て 左から / 右から)
  if (c + 1 <= cols - 1) cands.push(`出口は壁を正面から見て【左から${pick(c + 1, cols - 1)}列目以内】にある`);
  const tc = cols - 1 - c;
  if (tc + 1 <= cols - 1) cands.push(`出口は壁を正面から見て【右から${pick(tc + 1, cols - 1)}列目以内】にある`);
  // 番号
  cands.push(`出口の番号は【${num % 2 === 0 ? '偶数' : '奇数'}】`);
  cands.push(`出口の番号は【${num % 3 === 0 ? '3の倍数' : '3の倍数ではない'}】`);
  const half = Math.floor(n / 2);
  cands.push(`出口の番号は【${num <= half ? half + '以下' : (half + 1) + '以上'}】`);
  const span = Math.ceil(n / 4);
  const lo = Math.max(1, num - pick(0, span)), hi = Math.min(n, lo + span);
  cands.push(`出口の番号は【${lo}〜${hi}番】の間にある`);

  const fresh = cands.filter(h => !room.hintsGiven.has(h));
  const pool = fresh.length ? fresh : cands;
  const h = pool[Math.floor(Math.random() * pool.length)];
  room.hintsGiven.add(h);
  return h;
}

function handlePress(room, p, id) {
  if (room.phase !== 'playing') return;
  if (!Number.isInteger(id) || id < 0 || id >= room.level.n) return;
  if (room.pressed.has(id)) return;
  const now = Date.now();
  if (p.frozenUntil > now) return;

  room.pressed.add(id);
  const type = room.types[id];
  const out = { t: 'pressed', id, by: p.id, name: p.name, type, text: '', dur: 0 };

  switch (type) {
    case 'exit': out.text = '出口だ!! 扉が開いた!'; break;
    case 'hint': out.text = genHint(room); break;
    case 'freeze': out.dur = 5000; p.frozenUntil = now + 5000; out.text = '床が凍りついた! 5秒間動けない'; break;
    case 'dark': out.dur = 6000; out.text = '照明が落ちた! 6秒間なにも見えない'; break;
    case 'warp': {
      const R = room.level.half - 2; p.x = rand(-R, R); p.z = rand(-R, R);
      out.to = [p.x, p.z]; out.text = '足元が光り、どこかへワープした!'; break;
    }
    default: out.text = '……なにも起こらなかった';
  }
  bcast(room, out);
  if (type === 'exit') endGame(room, p);
}

function removePlayer(ws) {
  const p = ws.player; if (!p) return;
  const room = p.room;
  room.players.delete(p.id);
  ws.player = null;
  if (room.players.size === 0) {
    clearTimeout(room.timer); clearInterval(room.ticker);
    rooms.delete(room.code);
    return;
  }
  if (room.host === p.id) room.host = room.players.keys().next().value;
  bcast(room, lobbyInfo(room));
  if (room.phase === 'playing') bcast(room, { t: 'left', id: p.id, name: p.name });
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const p = ws.player;

    if (m.t === 'join') {
      if (p) return;
      let code = String(m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (!code) code = genCode();
      let room = rooms.get(code);
      if (!room) { room = newRoom(code); rooms.set(code, room); }
      if (room.phase !== 'lobby') { send(ws, { t: 'error', msg: 'そのルームはゲーム中です' }); return; }
      if (room.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', msg: 'ルームが満員です(最大5人)' }); return; }

      const used = new Set([...room.players.values()].map(x => x.slot));
      let slot = 0; while (used.has(slot)) slot++;
      const name = String(m.name || '').trim().slice(0, 12) || `Player${slot + 1}`;
      const np = { id: nextId++, ws, name, slot, room, x: 0, z: 0, ry: 0, frozenUntil: 0 };
      ws.player = np;
      room.players.set(np.id, np);
      if (!room.host) room.host = np.id;
      send(ws, { t: 'joined', id: np.id });
      bcast(room, lobbyInfo(room));
      return;
    }

    if (!p) return;
    const room = p.room;

    if (m.t === 'start' && room.host === p.id && room.phase === 'lobby') startGame(room, m.size);
    else if (m.t === 'again' && room.host === p.id && room.phase === 'ended') {
      room.phase = 'lobby'; bcast(room, lobbyInfo(room));
    }
    else if (m.t === 'move' && room.phase === 'playing') {
      if (Number.isFinite(m.x) && Number.isFinite(m.z)) {
        const lim = (room.level ? room.level.half : 10) - 0.5;
        p.x = Math.max(-lim, Math.min(lim, m.x));
        p.z = Math.max(-lim, Math.min(lim, m.z));
        p.ry = Number(m.ry) || 0;
      }
    }
    else if (m.t === 'press') handlePress(room, p, m.id);
  });

  ws.on('close', () => removePlayer(ws));
  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`ボタンルーム脱出 起動: http://localhost:${PORT}`);
});
