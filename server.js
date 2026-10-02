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

// ---------- イベント定義 ----------
// self: 押した人 / others: 他の全員 / all: 全員(押した人含む)に付与する効果
// bad:true の効果は「バリア🛡」で防げる
const EVENTS = {
  // --- 押した人に起こる ---
  speedup:  { mark: '⚡', text: '靴が光った! 12秒間ダッシュ力アップ', self: [{ k: 'speed', v: 1.8, d: 12000, label: '⚡ダッシュ' }] },
  slow:     { mark: '🐌', text: '足が急に重くなった… 10秒間スロー', self: [{ k: 'speed', v: 0.4, d: 10000, label: '🐌鈍足', bad: 1 }] },
  reverse:  { mark: '🙃', text: '操作が逆になった! 10秒間', self: [{ k: 'invert', d: 10000, label: '🙃操作反転', bad: 1 }] },
  fisheye:  { mark: '👁', text: '視界が歪む! 10秒間の超広角', self: [{ k: 'fov', v: 130, d: 10000, label: '👁超広角', bad: 1 }] },
  zoom:     { mark: '🔭', text: '望遠鏡モード! 10秒間ズームしっぱなし', self: [{ k: 'fov', v: 28, d: 10000, label: '🔭望遠', bad: 1 }] },
  quake:    { mark: '📳', text: '地震だ! 8秒間画面が揺れる', self: [{ k: 'shake', d: 8000, label: '📳地震', bad: 1 }] },
  fog:      { mark: '🌫', text: '濃い霧が立ちこめた! 12秒間', self: [{ k: 'fog', d: 12000, label: '🌫濃霧', bad: 1 }] },
  tiny:     { mark: '🐭', text: '体が縮んだ! 12秒間ネズミの視点', self: [{ k: 'eye', v: 0.55, d: 12000, label: '🐭縮小' }] },
  giant:    { mark: '🦒', text: '体が巨大化! 12秒間 高い視点で部屋を見渡せる', self: [{ k: 'eye', v: 4.2, d: 12000, label: '🦒巨大化' }] },
  rainbow:  { mark: '🌈', text: '世界が虹色に染まった! 10秒間', self: [{ k: 'filter', v: 'rainbow', d: 10000, label: '🌈虹色', bad: 1 }] },
  negative: { mark: '🎞', text: '色が反転した! 10秒間', self: [{ k: 'filter', v: 'negative', d: 10000, label: '🎞色反転', bad: 1 }] },
  blur:     { mark: '😵‍💫', text: '視界がぼやけた! 8秒間', self: [{ k: 'filter', v: 'blur', d: 8000, label: '😵ぼやけ', bad: 1 }] },
  flash:    { mark: '📸', text: 'カメラのフラッシュで目がくらんだ!', self: [{ k: 'flash', d: 3500, bad: 1 }] },
  spin:     { mark: '💫', text: '目が回る〜! 4秒間 勝手にぐるぐる回転', self: [{ k: 'spin', d: 4000, label: '💫回転', bad: 1 }] },
  shield:   { mark: '🛡', text: 'バリア獲得! 次の悪いイベントを1回だけ無効化', self: [{ k: 'shield' }] },

  // --- 全員 / 他の人に起こる ---
  blackoutAll: { mark: '🔌', text: '全員停電! 5秒間みんな真っ暗', all: [{ k: 'dark', d: 5000, label: '🌑暗闇', bad: 1 }] },
  freezeAll:   { mark: '🥶', text: '寒波襲来! 全員が3秒間凍りついた', all: [{ k: 'freeze', d: 3000, label: '❄凍結', bad: 1 }] },
  blindOthers: { mark: '🕶', text: 'まぶしい光! 押した人以外の全員が5秒間真っ暗', others: [{ k: 'dark', d: 5000, label: '🌑暗闇', bad: 1 }] },

  // --- 特殊 (関数で処理) ---
  swap:     { mark: '🔄', text: '全員の位置がシャッフルされた!' },
  gather:   { mark: '🧲', text: '磁石が作動! 全員が押した人の周りに集められた' },
  scatter:  { mark: '💥', text: '爆発! 全員がバラバラに吹き飛んだ' },
  timeAdd:  { mark: '⏳', text: '砂時計をひっくり返した! 残り時間 +30秒' },
  timeCut:  { mark: '⌛', text: '時計が早送りに… 残り時間 -30秒' },
  cleaner:  { mark: '🧹', text: 'お掃除ロボ登場!' },
  crystal:  { mark: '🔮', text: '水晶玉が輝く… ヒントが2つ同時に明かされた' },
  clown:    { mark: '🤡', text: 'ピエロがささやく「出口はね…」(本当かウソかは不明)' },
  snipe:    { mark: '🎯', text: '指名凍結!' },
  thermo:   { mark: '🌡', text: '温度計が反応! 押した人だけに出口までの距離が見えた' },
  compass:  { mark: '🧭', text: '羅針盤が動く! 押した人だけに出口の方角が見えた' },
  gamble:   { mark: '🎰', text: 'ギャンブルボタン!' },
};
const EVENT_KEYS = Object.keys(EVENTS);

// ボタン数に応じた内訳: 出口1 + ヒント10% + 凍結8% + 暗闇6% + ワープ6% + ハズレ15% + 残りは新イベント
function makePool(n) {
  const h = Math.round(n * 0.10), f = Math.round(n * 0.08);
  const d = Math.round(n * 0.06), w = Math.round(n * 0.06), none = Math.round(n * 0.15);
  const rest = Math.max(0, n - 1 - h - f - d - w - none);
  const ev = []; let bag = [];
  while (ev.length < rest) { if (!bag.length) bag = shuffle([...EVENT_KEYS]); ev.push(bag.pop()); }
  return [
    'exit',
    ...Array(h).fill('hint'), ...Array(f).fill('freeze'),
    ...Array(d).fill('dark'), ...Array(w).fill('warp'),
    ...Array(none).fill('none'),
    ...ev,
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
    p.frozenUntil = 0; p.shield = false;
    spawns[p.id] = [p.x, p.z];
  });
  const L = room.level;
  bcast(room, { t: 'start', remain: GAME_TIME, spawns, n: L.n, cols: L.cols, rows: L.rows, half: L.half, sx: L.sx });

  setRemain(room, GAME_TIME);
  room.ticker = setInterval(() => {
    bcast(room, {
      t: 'players',
      list: [...room.players.values()].map(p => ({ id: p.id, x: p.x, y: p.y || 0, z: p.z, ry: p.ry })),
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
function genHint(room, e = room.exitId, record = true) {
  const { cols, rows, per, n } = room.level;
  const num = e + 1;
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

  const fresh = record ? cands.filter(h => !room.hintsGiven.has(h)) : cands;
  const pool = fresh.length ? fresh : cands;
  const h = pool[Math.floor(Math.random() * pool.length)];
  if (record) room.hintsGiven.add(h);
  return h;
}

// ボタンの3D位置 (クライアントの配置と同じ計算)
const WALL_N = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]];
const WALL_ROT = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
function btnPos(L, i) {
  const w = Math.floor(i / L.per), k = i % L.per, c = k % L.cols, r = Math.floor(k / L.cols);
  const n = WALL_N[w], th = WALL_ROT[w], off = (c - (L.cols - 1) / 2) * L.sx;
  return { x: -n[0] * L.half + Math.cos(th) * off, z: -n[2] * L.half - Math.sin(th) * off, y: 1.7 + r * 2.3 };
}

function setRemain(room, ms) {
  room.endsAt = Date.now() + ms;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endGame(room, null), ms);
}

const DIRS8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
const MARKS = { exit: '🚪', hint: '💡', freeze: '❄', dark: '🌑', warp: '🌀', none: '・' };

function handlePress(room, p, id) {
  if (room.phase !== 'playing') return;
  if (!Number.isInteger(id) || id < 0 || id >= room.level.n) return;
  if (room.pressed.has(id)) return;
  const now = Date.now();
  if (p.frozenUntil > now) return;

  room.pressed.add(id);
  const L = room.level;
  const type = room.types[id];
  const ev = EVENTS[type];
  const out = { t: 'pressed', id, by: p.id, name: p.name, type,
                mark: ev ? ev.mark : (MARKS[type] || ''), text: ev ? ev.text : '',
                fx: {}, hints: [], auto: [] };
  const all = [...room.players.values()];
  const others = all.filter(q => q.id !== p.id);
  const half = L.half - 2;

  // 効果を付与 (悪い効果はバリアで防げる)
  const give = (target, fx) => {
    const list = (out.fx[target.id] = out.fx[target.id] || []);
    if (fx.bad && target.shield) {
      target.shield = false; list.push({ k: 'shieldbreak' }); return;
    }
    if (fx.k === 'freeze') target.frozenUntil = Math.max(target.frozenUntil, now + fx.d);
    if (fx.k === 'shield') target.shield = true;
    list.push(fx);
  };
  const teleport = (target, x, z) => {
    target.x = Math.max(-half, Math.min(half, x)); target.z = Math.max(-half, Math.min(half, z));
    give(target, { k: 'tp', x: target.x, z: target.z });
  };

  switch (type) {
    case 'exit': out.text = '出口だ!! 扉が開いた!'; break;
    case 'hint': out.hints.push({ text: genHint(room) }); out.text = 'ヒントが見つかった'; break;
    case 'freeze': give(p, { k: 'freeze', d: 5000, label: '❄凍結', bad: 1 }); out.text = '床が凍りついた! 5秒間動けない'; break;
    case 'dark': give(p, { k: 'dark', d: 6000, label: '🌑暗闇', bad: 1 }); out.text = '照明が落ちた! 6秒間なにも見えない'; break;
    case 'warp': teleport(p, rand(-half, half), rand(-half, half)); out.text = '足元が光り、どこかへワープした!'; break;
    case 'none': out.text = '……なにも起こらなかった'; break;
    default: {
      // 付与型イベント
      if (ev.self) ev.self.forEach(f => give(p, f));
      if (ev.others) others.forEach(q => ev.others.forEach(f => give(q, f)));
      if (ev.all) all.forEach(q => ev.all.forEach(f => give(q, f)));

      // 特殊イベント
      switch (type) {
        case 'swap': {
          const pos = shuffle(all.map(q => [q.x, q.z]));
          all.forEach((q, i) => teleport(q, pos[i][0], pos[i][1]));
          break;
        }
        case 'gather':
          all.forEach(q => { if (q.id !== p.id) teleport(q, p.x + rand(-1.8, 1.8), p.z + rand(-1.8, 1.8)); });
          break;
        case 'scatter':
          all.forEach(q => teleport(q, rand(-half, half), rand(-half, half)));
          break;
        case 'timeAdd': { const r = Math.max(0, room.endsAt - now) + 30000; setRemain(room, r); out.time = r; break; }
        case 'timeCut': { const r = Math.max(15000, Math.max(0, room.endsAt - now) - 30000); setRemain(room, r); out.time = r; break; }
        case 'cleaner': {
          const duds = [];
          room.types.forEach((t, i) => { if (t === 'none' && !room.pressed.has(i)) duds.push(i); });
          const pick = shuffle(duds).slice(0, 3);
          pick.forEach(i => room.pressed.add(i));
          out.auto = pick;
          out.text = pick.length ? `お掃除ロボ登場! ハズレボタン${pick.length}個を片付けた(${pick.map(i => i + 1).join('・')}番)` : 'お掃除ロボ登場! …しかし掃除するものがなかった';
          break;
        }
        case 'crystal':
          out.hints.push({ text: genHint(room) }, { text: genHint(room) });
          break;
        case 'clown': {
          let fake = Math.floor(Math.random() * L.n);
          if (fake === room.exitId) fake = (fake + 1 + Math.floor(Math.random() * (L.n - 1))) % L.n;
          out.hints.push({ text: genHint(room, fake, false), unsure: true });
          break;
        }
        case 'snipe': {
          if (!others.length) { out.text = '指名凍結! …しかし他に誰もいなかった'; break; }
          const t = others[Math.floor(Math.random() * others.length)];
          give(t, { k: 'freeze', d: 6000, label: '❄凍結', bad: 1 });
          out.text = `指名凍結! ${t.name} が6秒間凍りついた`;
          break;
        }
        case 'thermo': {
          const e = btnPos(L, room.exitId);
          const dist = Math.hypot(e.x - p.x, e.y - 1.7, e.z - p.z);
          const temp = dist < 5 ? '🔥激アツ' : dist < 10 ? '♨熱い' : dist < 15 ? '😐ぬるい' : '🧊冷たい';
          give(p, { k: 'note', text: `🌡 出口まで約${Math.round(dist)}m(${temp})` });
          break;
        }
        case 'compass': {
          const e = btnPos(L, room.exitId);
          const ang = Math.atan2(e.x - p.x, -(e.z - p.z));
          const dir = DIRS8[(Math.round(ang / (Math.PI / 4)) + 8) % 8];
          give(p, { k: 'note', text: `🧭 押した場所から見て、出口は【${dir}】の方向` });
          break;
        }
        case 'gamble': {
          if (Math.random() < 0.5) {
            out.hints.push({ text: genHint(room) }, { text: genHint(room) });
            out.text = '🎰 大当たり!! ヒントが2つ出た';
          } else {
            give(p, { k: 'freeze', d: 8000, label: '❄凍結', bad: 1 });
            out.text = '🎰 ハズレ… 8秒間凍りついた';
          }
          break;
        }
      }
    }
  }

  // バリアが身代わりになった場合の注記
  const broke = Object.values(out.fx).some(l => l.some(f => f.k === 'shieldbreak'));
  if (broke) out.text += ' (🛡バリアが悪い効果を防いだ!)';
  out.shielded = p.shield ? [p.id] : [];

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
        p.y = Math.max(0, Math.min(30, Number(m.y) || 0));
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
