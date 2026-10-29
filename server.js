// Cờ Tướng Coach — server nhỏ:
//   1) Phục vụ index.html (có thể đặt mật khẩu chung để chỉ bạn bè vào được)
//   2) Chạy engine Pikafish (UCI) cho nhiều người dùng cùng lúc qua /api/engine
//   3) Proxy gọi Azure AI Foundry (giữ API key phía server, tránh CORS) qua /api/chat
// Chạy:  node server.js   rồi mở http://localhost:8080      (Node.js 18+)
// Cấu hình: config.json (copy từ config.example.json) hoặc biến môi trường:
//   FOUNDRY_URL, FOUNDRY_KEY, FOUNDRY_MODEL, FOUNDRY_AUTH (api-key | bearer)
//   APP_PASSWORD (mật khẩu chung, bỏ trống = không cần đăng nhập), CHAT_LIMIT_PER_HOUR
//   PIKAFISH_PATH, PIKAFISH_NNUE, PIKAFISH_INSTANCES, PIKAFISH_THREADS, PIKAFISH_HASH, PORT
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');

let cfg = {};
const cfgPath = path.join(__dirname, 'config.json');
if (fs.existsSync(cfgPath)) {
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { console.error('config.json lỗi cú pháp:', e.message); process.exit(1); }
}
for (const k of Object.keys(cfg)) if (typeof cfg[k] === 'string' && cfg[k].includes('<')) cfg[k] = ''; // bỏ giá trị mẫu chưa điền
const env = (k, ck, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : (cfg[ck] !== undefined && cfg[ck] !== '' ? cfg[ck] : d));

const URL_ = env('FOUNDRY_URL', 'url', '');
const KEY = env('FOUNDRY_KEY', 'key', '');
const MODEL = env('FOUNDRY_MODEL', 'model', '');
const AUTH = String(env('FOUNDRY_AUTH', 'auth', 'api-key')).toLowerCase();
const PORT = +env('PORT', 'port', 8080);
const HOST = String(env('HOST', 'host', '0.0.0.0'));
// Mật khẩu chung cho cả trang (APP_PASSWORD). accessCode/ACCESS_CODE cũ được dùng làm mật khẩu nếu chưa đặt APP_PASSWORD.
const PASSWORD = String(env('APP_PASSWORD', 'password', '') || env('ACCESS_CODE', 'accessCode', ''));
const CHAT_LIMIT = +env('CHAT_LIMIT_PER_HOUR', 'chatLimitPerHour', 60);
const PIKA_PATH = env('PIKAFISH_PATH', 'pikafishPath', '');
const PIKA_NNUE = env('PIKAFISH_NNUE', 'pikafishNnue', '');
const PIKA_INSTANCES = Math.max(1, +env('PIKAFISH_INSTANCES', 'pikafishInstances', 1));
const PIKA_THREADS = Math.max(1, +env('PIKAFISH_THREADS', 'pikafishThreads', Math.max(1, Math.min(4, os.cpus().length - 1))));
const PIKA_HASH = Math.max(16, +env('PIKAFISH_HASH', 'pikafishHash', 128));

// ===================== Pikafish (UCI) =====================
function walk(dir, depth, out) {
  if (depth < 0 || !fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let s; try { s = fs.statSync(p); } catch (e) { continue; }
    if (s.isDirectory()) walk(p, depth - 1, out); else out.push(p);
  }
  return out;
}
// Tìm file chạy Pikafish trong thư mục ./pikafish (giải nén bản release vào đó)
function findCandidates() {
  if (PIKA_PATH) return [path.resolve(__dirname, PIKA_PATH)];
  const files = walk(path.join(__dirname, 'pikafish'), 3, []);
  const win = process.platform === 'win32', mac = process.platform === 'darwin';
  let c = files.filter((f) => /^pikafish/i.test(path.basename(f)) && !/\.(nnue|txt|md|7z|zip)$/i.test(f));
  c = c.filter((f) => win ? /\.exe$/i.test(f) : !/\.exe$/i.test(f));
  if (!win) {
    const hint = mac ? /mac|osx|darwin|apple/i : /linux/i, other = mac ? /linux|android/i : /mac|osx|darwin|apple|android/i;
    const pref = c.filter((f) => hint.test(f));
    c = pref.length ? pref : c.filter((f) => !other.test(f));
  }
  // Ưu tiên bản tối ưu phổ biến; nếu CPU không hỗ trợ sẽ tự thử bản kế tiếp
  const rank = (f) => {
    const n = path.basename(f).toLowerCase();
    const order = ['avx2', 'bmi2', 'sse41', 'popcnt', 'ssse3', 'x86-64', 'apple', 'armv8'];
    for (let i = 0; i < order.length; i++) if (n.includes(order[i])) return i;
    if (/avx512|vnni|avxvnni/.test(n)) return 20; // hay lỗi trên CPU cũ, thử sau cùng
    return order.length;
  };
  return c.sort((a, b) => rank(a) - rank(b));
}
function findNnue(exe) {
  if (PIKA_NNUE) return path.resolve(__dirname, PIKA_NNUE);
  const near = path.join(path.dirname(exe), 'pikafish.nnue');
  if (fs.existsSync(near)) return near;
  const all = walk(path.join(__dirname, 'pikafish'), 3, []).filter((f) => /\.nnue$/i.test(f));
  return all[0] || '';
}

class UciEngine {
  constructor(exe) { this.exe = exe; this.name = ''; this.listeners = []; this.dead = false; }
  start() {
    return new Promise((resolve, reject) => {
      try { if (process.platform !== 'win32') fs.chmodSync(this.exe, 0o755); } catch (e) { }
      const p = spawn(this.exe, [], { cwd: path.dirname(this.exe) });
      this.proc = p;
      let ok = false;
      const timer = setTimeout(() => { if (!ok) { p.kill(); reject(new Error('không phản hồi lệnh uci')); } }, 15000);
      p.on('error', (e) => { clearTimeout(timer); this.dead = true; reject(e); });
      p.on('exit', (code) => {
        clearTimeout(timer); this.dead = true;
        for (const l of this.listeners.slice()) l('bestmove (none)'); // giải phóng các job đang chờ
        if (!ok) reject(new Error('thoát với mã ' + code + ' (có thể CPU không hỗ trợ bản này)'));
        else if (this.onExit) this.onExit(code);
      });
      p.stdin.on('error', () => { });
      readline.createInterface({ input: p.stdout }).on('line', (line) => {
        if (line.startsWith('id name ')) this.name = line.slice(8);
        for (const l of this.listeners.slice()) l(line);
      });
      this.waitFor((l) => l === 'uciok').then(async () => {
        const nnue = findNnue(this.exe);
        if (nnue) {
          // Engine đọc stdin dạng byte thô nên đường dẫn có dấu (vd "Cờ tướng") sẽ bị hỏng → dùng đường dẫn tương đối so với cwd của engine
          const rel = path.relative(path.dirname(this.exe), nnue) || path.basename(nnue);
          if (/[^\x20-\x7e]/.test(rel)) console.warn('  ⚠ đường dẫn NNUE chứa ký tự không ASCII, engine có thể không nạp được:', rel);
          this.send('setoption name EvalFile value ' + rel);
        }
        this.send('setoption name Threads value ' + PIKA_THREADS);
        this.send('setoption name Hash value ' + PIKA_HASH);
        this.send('isready');
        await this.waitFor((l) => l === 'readyok');
        // thử tìm nhanh để chắc chắn file mạng NNUE nạp được
        this.send('position startpos'); this.send('go depth 1');
        await this.waitFor((l) => l.startsWith('bestmove'));
        if (this.dead) return;
        ok = true; clearTimeout(timer); resolve(this);
      });
      this.send('uci');
    });
  }
  send(cmd) { if (!this.dead) this.proc.stdin.write(cmd + '\n'); }
  waitFor(pred, onLine) {
    return new Promise((resolve) => {
      const l = (line) => {
        if (onLine) onLine(line);
        if (pred(line) || this.dead) { const i = this.listeners.indexOf(l); if (i >= 0) this.listeners.splice(i, 1); resolve(line); }
      };
      this.listeners.push(l);
    });
  }
  // Chạy một lượt phân tích (mỗi engine chỉ chạy 1 job một lúc — Pool đảm bảo điều này)
  async analyse(job) {
    if (this.dead) throw new Error('Pikafish đã dừng');
    const multipv = Math.max(1, Math.min(10, job.multipv | 0 || 1));
    this.send('setoption name MultiPV value ' + multipv);
    this.send('isready'); await this.waitFor((l) => l === 'readyok');
    let fen = String(job.fen || '').trim().replace(/[^A-Za-z0-9/ \-]/g, '');
    if (fen.split(/\s+/).length < 3) fen += ' - - 0 1';
    const moves = (Array.isArray(job.moves) ? job.moves : []).filter((m) => /^[a-i][0-9][a-i][0-9]$/.test(m)).slice(0, 600);
    this.send('position fen ' + fen + (moves.length ? ' moves ' + moves.join(' ') : ''));
    const lines = {};
    let go = 'go';
    if (job.depth) go += ' depth ' + Math.max(1, Math.min(30, job.depth | 0));
    if (job.movetime || !job.depth) go += ' movetime ' + Math.max(50, Math.min(5000, job.movetime | 0 || 1000));
    this.send(go);
    const best = await this.waitFor((l) => l.startsWith('bestmove'), (line) => {
      if (!line.startsWith('info ') || line.indexOf(' pv ') < 0 || line.indexOf(' score ') < 0) return;
      if (/ (lowerbound|upperbound)/.test(line)) return;
      const t = line.split(' ');
      const get = (k) => { const i = t.indexOf(k); return i >= 0 ? t[i + 1] : null; };
      const si = t.indexOf('score');
      lines[+(get('multipv') || 1)] = { depth: +get('depth'), scoreType: t[si + 1], score: +t[si + 2], pv: t.slice(t.indexOf('pv') + 1) };
    });
    if (this.dead) throw new Error('Pikafish đã dừng giữa chừng');
    const list = Object.keys(lines).sort((a, b) => a - b).map((k) => lines[k]).filter((x) => x.pv.length);
    return { bestmove: best.split(' ')[1], lines: list };
  }
}

// Nhóm nhiều tiến trình Pikafish để nhiều người chơi cùng lúc.
// Mỗi người (clientId) chỉ có tối đa 1 job: job mới của cùng người sẽ dừng job cũ của chính họ.
class Pool {
  constructor() { this.engines = []; this.waiting = []; this.running = new Map(); this.exe = null; this.name = ''; this.error = ''; }
  async init() {
    const cands = findCandidates();
    if (!cands.length) { this.error = 'Không tìm thấy Pikafish (giải nén bản release vào thư mục ./pikafish)'; return; }
    for (const exe of cands) {
      try {
        const e = await new UciEngine(exe).start();
        this.exe = exe; this.name = e.name; this.add(e);
        console.log('✓ Pikafish:', e.name, '—', path.relative(__dirname, exe));
        break;
      } catch (err) { console.log('  thử', path.relative(__dirname, exe), '→ lỗi:', err.message); }
    }
    if (!this.exe) { this.error = 'Không chạy được bản Pikafish nào (xem log server)'; return; }
    for (let i = 1; i < PIKA_INSTANCES; i++) {
      try { this.add(await new UciEngine(this.exe).start()); } catch (err) { console.log('  không mở thêm được Pikafish:', err.message); break; }
    }
    console.log(`  ${this.engines.length} tiến trình × ${PIKA_THREADS} luồng, hash ${PIKA_HASH}MB`);
  }
  add(e) {
    e.reserved = false;
    e.onExit = () => {
      console.log('⚠ Một tiến trình Pikafish dừng, khởi động lại…');
      this.engines = this.engines.filter((x) => x !== e);
      setTimeout(() => new UciEngine(this.exe).start().then((n) => { this.add(n); this.pump(); }).catch((err) => console.log('  khởi động lại lỗi:', err.message)), 1000);
    };
    this.engines.push(e);
  }
  ready() { return this.engines.length > 0; }
  pump() {
    while (this.waiting.length) {
      const free = this.engines.find((e) => !e.reserved && !e.dead);
      if (!free) return;
      const w = this.waiting.shift();
      free.reserved = true; w.resolve(free);
    }
  }
  acquire(clientId) {
    return new Promise((resolve, reject) => { this.waiting.push({ clientId, resolve, reject }); this.pump(); });
  }
  release(e) { e.reserved = false; this.pump(); }
  async analyse(job, clientId) {
    const cur = this.running.get(clientId);
    if (cur) cur.send('stop');
    this.waiting = this.waiting.filter((w) => { if (w.clientId === clientId) { w.reject(new Error('superseded')); return false; } return true; });
    if (this.waiting.length > 20) throw new Error('Server đang bận, thử lại sau ít giây');
    const e = await this.acquire(clientId);
    this.running.set(clientId, e);
    try { return await e.analyse(job); }
    finally { if (this.running.get(clientId) === e) this.running.delete(clientId); this.release(e); }
  }
}
const pool = new Pool();

// ===================== Đăng nhập bằng mật khẩu chung =====================
const SECRET = crypto.createHash('sha256').update('cotuong|' + PASSWORD).digest('hex');
const TOKEN = crypto.createHmac('sha256', SECRET).update('ok').digest('hex');
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function authed(req) { return !PASSWORD || safeEq(parseCookies(req).ct_auth || '', TOKEN); }
const loginFails = new Map(); // ip -> {n, until}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function loginPage(msg) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cờ Tướng Coach</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14161a;color:#e8e6e1;font-family:system-ui,sans-serif}
form{background:#1d2026;border:1px solid #323844;border-radius:14px;padding:24px;width:min(340px,calc(100% - 32px));display:flex;flex-direction:column;gap:12px}
h1{margin:0;font-size:20px}h1 span{color:#e0a64a}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #323844;background:#252931;color:inherit}
button{background:#e0a64a;border-color:#e0a64a;color:#1b1408;font-weight:600;cursor:pointer}.e{color:#e87a5a;font-size:14px}</style></head>
<body><form method="post" action="/login"><h1>Cờ Tướng <span>Coach</span></h1><div style="color:#9aa0aa;font-size:14px">Nhập mật khẩu để vào chơi</div>
<input type="password" name="password" placeholder="Mật khẩu" autofocus required>${msg ? `<div class="e">${msg}</div>` : ''}<button>Vào chơi</button></form></body></html>`;
}

// ===================== Giới hạn số lần hỏi AI (chống tốn tiền Foundry) =====================
const hits = new Map();
function rateLimited(ip, key, max, windowMs) {
  if (!max) return false;
  const now = Date.now(), k = ip + '|' + key;
  let arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(k, arr); return true; }
  arr.push(now); hits.set(k, arr);
  if (hits.size > 5000) for (const [kk, v] of hits) if (!v.length || now - v[v.length - 1] > 3600e3) hits.delete(kk);
  return false;
}

// ===================== HTTP =====================
function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) { reject(new Error('Body quá lớn')); req.destroy(); } });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}
async function readJson(req) { const raw = await readRaw(req); return JSON.parse(raw || '{}'); }

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url === '/healthz') return send(res, 200, { ok: true });

    if (url === '/login' && req.method === 'POST') {
      const ip = clientIp(req), f = loginFails.get(ip);
      if (f && f.until > Date.now()) return send(res, 429, loginPage('Sai quá nhiều lần, thử lại sau 1 phút.'), 'text/html; charset=utf-8');
      const pw = new URLSearchParams(await readRaw(req)).get('password') || '';
      if (PASSWORD && safeEq(pw, PASSWORD)) {
        loginFails.delete(ip);
        const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
        return send(res, 302, '', 'text/plain', { Location: '/', 'Set-Cookie': `ct_auth=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}` });
      }
      const n = (f ? f.n : 0) + 1;
      loginFails.set(ip, { n, until: n >= 5 ? Date.now() + 60e3 : 0 });
      return send(res, 401, loginPage('Sai mật khẩu.'), 'text/html; charset=utf-8');
    }
    if (url === '/logout') return send(res, 302, '', 'text/plain', { Location: '/', 'Set-Cookie': 'ct_auth=; Path=/; Max-Age=0' });

    if (!authed(req)) {
      if (url.startsWith('/api/')) return send(res, 401, { error: { message: 'Chưa đăng nhập' } });
      return send(res, 200, loginPage(''), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url === '/api/health') {
      return send(res, 200, {
        server: true, auth: !!PASSWORD, configured: !!(URL_ && KEY), model: MODEL || null,
        pikafish: pool.ready(), pikafishName: pool.name || null, pikafishError: pool.ready() ? null : pool.error
      });
    }
    if (req.method === 'POST' && url === '/api/engine') {
      if (!pool.ready()) return send(res, 503, { error: { message: pool.error || 'Pikafish chưa sẵn sàng' } });
      if (rateLimited(clientIp(req), 'engine', 120, 60e3)) return send(res, 429, { error: { message: 'Gọi engine quá nhanh, thử lại sau ít giây.' } });
      const job = await readJson(req);
      const cid = String(req.headers['x-client-id'] || clientIp(req)).slice(0, 64);
      try { return send(res, 200, await pool.analyse(job, cid)); }
      catch (e) { return send(res, e.message === 'superseded' ? 409 : 503, { error: { message: e.message } }); }
    }
    if (req.method === 'POST' && url === '/api/chat') {
      if (!URL_ || !KEY) return send(res, 500, { error: { message: 'Server chưa cấu hình FOUNDRY_URL / FOUNDRY_KEY.' } });
      if (rateLimited(clientIp(req), 'chat-min', 30, 60e3)) return send(res, 429, { error: { message: 'Hỏi AI quá nhanh, thử lại sau ít giây.' } });
      if (rateLimited(clientIp(req), 'chat-hour', CHAT_LIMIT, 3600e3)) return send(res, 429, { error: { message: `Đã hỏi AI quá ${CHAT_LIMIT} lần trong 1 giờ, nghỉ chút rồi hỏi tiếp nhé.` } });
      const body = await readJson(req);
      const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-12)
        .map((m) => ({ role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user', content: String(m.content || '').slice(0, 12000) }));
      // Endpoint .../responses dùng Responses API (tham số 'input'), còn lại là Chat Completions ('messages')
      const payload = /\/responses(\?|$)/.test(URL_) ? { input: msgs } : { messages: msgs };
      if (MODEL) payload.model = MODEL;
      const headers = { 'Content-Type': 'application/json' };
      if (AUTH === 'bearer') headers.Authorization = 'Bearer ' + KEY; else headers['api-key'] = KEY;
      const r = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(payload) });
      return send(res, r.status, await r.text());
    }
    send(res, 404, { error: { message: 'Not found' } });
  } catch (e) {
    send(res, 500, { error: { message: 'Server lỗi: ' + e.message } });
  }
});

pool.init().finally(() => {
  server.listen(PORT, HOST, () => {
    console.log(`Cờ Tướng Coach: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (!pool.ready()) console.log('⚠ ' + pool.error + ' — vẫn chơi được bằng engine JS tích hợp.');
    console.log(URL_ && KEY ? `→ Foundry: ${URL_}${MODEL ? ' (model ' + MODEL + ')' : ''}` : '⚠ Chưa cấu hình Foundry — vẫn chơi được, chỉ thiếu phần AI giải thích sâu.');
    console.log(PASSWORD ? '🔒 Bật mật khẩu chung (APP_PASSWORD)' : '🔓 Không đặt mật khẩu — ai có link cũng vào được');
  });
});
const shutdown = () => { for (const e of pool.engines) { try { e.proc.kill(); } catch (x) { } } process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
