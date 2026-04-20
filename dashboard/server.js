import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/home/splgames02/nanoclaw/store/messages.db';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
const NANOCLAW_DIR = process.env.NANOCLAW_DIR || '/home/splgames02/nanoclaw';

// Load better-sqlite3 from NanoClaw's node_modules
const Database = require(path.join(NANOCLAW_DIR, 'node_modules/better-sqlite3'));

if (!DASHBOARD_TOKEN) {
  console.warn('[WARN] DASHBOARD_TOKEN not set — running without authentication (internal use only)');
}

// Open DB read-only
const db = new Database(DB_PATH, { readonly: true });
db.pragma('busy_timeout = 5000');

// Known JIDs
const JIDS = ['dc:1494232366900842526', 'dc2:1494232366900842526'];
const JID_PLACEHOLDER = JIDS.map(() => '?').join(',');

// ─── Auth ────────────────────────────────────────────────────────────────────

function checkAuth(req) {
  if (!DASHBOARD_TOKEN) return true;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7) === DASHBOARD_TOKEN;
  }
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token') === DASHBOARD_TOKEN;
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function jsonResponse(res, data, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization',
  });
  res.end(JSON.stringify(data));
}

function errorResponse(res, message, code = 500) {
  jsonResponse(res, { error: message, code }, code);
}

// ─── API: /api/status ─────────────────────────────────────────────────────────

function handleStatus(req, res) {
  const groups = db.prepare(
    'SELECT jid, name, folder, trigger_pattern, is_main FROM registered_groups'
  ).all();

  const bots = groups.map((group) => {
    const lastMsg = db.prepare(
      'SELECT timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1'
    ).get(group.jid);

    let containerRunning = false;
    let containerName = null;
    try {
      const folderSlug = group.folder.replace(/_/g, '-');
      const output = execSync(
        `docker ps --filter name=nanoclaw-${folderSlug} --format "{{.Names}}"`,
        { timeout: 5000 }
      ).toString().trim();
      if (output) {
        containerRunning = true;
        containerName = output.split('\n')[0];
      }
    } catch {}

    return {
      name: group.name,
      jid: group.jid,
      folder: group.folder,
      trigger: group.trigger_pattern,
      isMain: !!group.is_main,
      containerRunning,
      containerName,
      lastActivity: lastMsg?.timestamp || null,
    };
  });

  jsonResponse(res, { bots });
}

// ─── API: /api/messages ───────────────────────────────────────────────────────

function handleMessages(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const preview = url.searchParams.get('preview') === '1';

  const messages = db.prepare(`
    SELECT m.id, m.chat_jid, m.sender, m.sender_name, m.content,
           m.timestamp, m.is_from_me, m.is_bot_message,
           rg.name AS bot_name
    FROM messages m
    LEFT JOIN registered_groups rg ON m.chat_jid = rg.jid
    WHERE m.chat_jid IN (${JID_PLACEHOLDER})
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(...JIDS, limit);

  const result = messages.map((m) => ({
    ...m,
    content: preview ? m.content.slice(0, 100) : m.content,
    is_from_me: !!m.is_from_me,
    is_bot_message: !!m.is_bot_message,
  }));

  jsonResponse(res, { messages: result });
}

// ─── API: /api/tasks ──────────────────────────────────────────────────────────

function handleTasks(req, res) {
  let tasks = [];
  try {
    tasks = db.prepare(`
      SELECT id, group_folder, prompt, schedule_type, schedule_value, next_run, status
      FROM scheduled_tasks
      WHERE status != 'completed'
      ORDER BY next_run ASC
      LIMIT 20
    `).all();
    tasks = tasks.map((t) => ({
      ...t,
      prompt: t.prompt && t.prompt.length > 80
        ? t.prompt.slice(0, 80) + '...'
        : t.prompt || '',
    }));
  } catch {}

  jsonResponse(res, { tasks });
}

// ─── API: /api/pipeline ───────────────────────────────────────────────────────

function handlePipeline(req, res) {
  // 1) Try explicit DB state
  let stage = null;
  try {
    const row = db.prepare(
      "SELECT value FROM router_state WHERE key = 'pipeline_stage'"
    ).get();
    if (row) stage = row.value;
  } catch {}

  let confident = !!stage;
  const inferredFrom = stage ? 'db' : 'keyword';

  // 2) Keyword fallback
  if (!stage) {
    try {
      const recentText = db.prepare(`
        SELECT content FROM messages
        WHERE chat_jid IN (${JID_PLACEHOLDER})
        ORDER BY timestamp DESC LIMIT 30
      `).all(...JIDS).map((m) => m.content.toLowerCase()).join(' ');

      if (recentText.includes('구현') || recentText.includes('코드 작성')) {
        stage = 'implementing';
        confident = true;
      } else if (recentText.includes('승인')) {
        stage = 'approved';
        confident = true;
      } else if (recentText.includes('리뷰')) {
        stage = 'review';
        confident = true;
      } else if (recentText.includes('설계')) {
        stage = 'design';
        confident = true;
      } else {
        stage = 'unknown';
        confident = false;
      }
    } catch {
      stage = 'unknown';
    }
  }

  const stageOrder = ['idle', 'design', 'review', 'approved', 'implementing'];
  const stageLabels = {
    idle: '대기', design: '설계문서 작성', review: '리뷰 중',
    approved: '승인', implementing: '구현 중', unknown: '알 수 없음',
  };
  const currentIdx = stageOrder.indexOf(stage);

  const stages = stageOrder.map((id, idx) => ({
    id,
    label: stageLabels[id],
    status: id === stage ? 'active' : currentIdx > idx ? 'done' : 'pending',
  }));

  jsonResponse(res, {
    currentStage: stage,
    confident,
    inferredFrom,
    fallback: !confident,
    stages,
  });
}

// ─── API: /api/logs/stream ────────────────────────────────────────────────────

// Strip ANSI escape codes
function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').replace(/\x1B\]/g, '');
}

function spawnStream(cmd, args, res) {
  const send = (line) => {
    const clean = stripAnsi(line);
    if (!clean.trim()) return;
    try { res.write(`data: ${JSON.stringify({ line: clean })}\n\n`); } catch {}
  };

  let proc;
  try {
    proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    send(`[실행 실패: ${e.message}]`);
    res.end();
    return null;
  }

  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) send(line);
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', (e) => send(`[오류: ${e.message}]`));

  return proc;
}

function handleLogsStream(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const source = url.searchParams.get('source') || 'nanoclaw';
  const folder = url.searchParams.get('folder') || '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (line) => {
    const clean = stripAnsi(line);
    if (!clean.trim()) return;
    try { res.write(`data: ${JSON.stringify({ line: clean })}\n\n`); } catch {}
  };

  let proc = null;

  // Heartbeat
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(hb); }
  }, 15000);

  if (source === 'nanoclaw') {
    // Tail the NanoClaw host log
    const logFile = path.join(NANOCLAW_DIR, 'logs/nanoclaw.log');
    if (!fs.existsSync(logFile)) { send('[nanoclaw.log 없음]'); res.end(); return; }
    proc = spawnStream('tail', ['-n', '100', '-f', logFile], res);

  } else if (source === 'container') {
    // Find running container via docker ps
    const folderSlug = folder.replace(/_/g, '-');
    let containerName = null;
    try {
      containerName = execSync(
        `docker ps --filter name=nanoclaw-${folderSlug} --format "{{.Names}}" | head -1`,
        { timeout: 5000 }
      ).toString().trim();
    } catch {}

    if (containerName) {
      // Stream live docker logs
      send(`[컨테이너 연결: ${containerName}]`);
      proc = spawnStream('docker', ['logs', '--tail', '80', '-f', containerName], res);
    } else {
      // Container not running — show last summary log file
      const logsDir = path.join(NANOCLAW_DIR, 'groups', folder, 'logs');
      let logFile = null;
      try {
        const files = fs.readdirSync(logsDir)
          .filter(f => f.startsWith('container-')).sort();
        if (files.length) logFile = path.join(logsDir, files[files.length - 1]);
      } catch {}

      if (logFile) {
        send(`[컨테이너 미실행 — 마지막 로그: ${path.basename(logFile)}]`);
        proc = spawnStream('tail', ['-n', '100', '-f', logFile], res);
      } else {
        send(`[컨테이너(${folder}) 미실행, 로그 없음]`);
        res.end();
        clearInterval(hb);
        return;
      }
    }
  } else {
    send('[알 수 없는 source]');
    res.end();
    clearInterval(hb);
    return;
  }

  req.on('close', () => {
    clearInterval(hb);
    try { proc?.kill(); } catch {}
  });
}

// ─── Main server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization',
    });
    res.end();
    return;
  }

  // Serve index.html
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch {
      errorResponse(res, 'index.html not found', 404);
    }
    return;
  }

  // API routes
  if (url.pathname.startsWith('/api/')) {
    if (!checkAuth(req)) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }
    try {
      if (url.pathname === '/api/status') handleStatus(req, res);
      else if (url.pathname === '/api/messages') handleMessages(req, res);
      else if (url.pathname === '/api/tasks') handleTasks(req, res);
      else if (url.pathname === '/api/pipeline') handlePipeline(req, res);
      else if (url.pathname === '/api/logs/stream') handleLogsStream(req, res);
      else errorResponse(res, 'Not Found', 404);
    } catch (err) {
      console.error(err);
      errorResponse(res, err.message, 500);
    }
    return;
  }

  errorResponse(res, 'Not Found', 404);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ NanoClaw Dashboard → http://127.0.0.1:${PORT}`);
  if (!DASHBOARD_TOKEN) {
    console.warn('⚠️  No DASHBOARD_TOKEN set — unauthenticated (internal use only)');
  }
});
