const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  DEFAULT_STATE,
  isSupabaseConfigured,
  mergeState,
  sanitizePublicState,
  fetchStateFromSupabase,
  pushStateToSupabase
} = require('./lib/data');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const sessions = new Map();
let stateWriteQueue = Promise.resolve();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* ------------------------------------------------------------------------
   PERSISTENCIA: FICHERO LOCAL (modo desarrollo / sin Supabase)
   ------------------------------------------------------------------------ */
function readStateFromFile() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return mergeState(DEFAULT_STATE, JSON.parse(raw));
  } catch (err) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function writeStateToFile(state) {
  try {
    const merged = state ? mergeState(DEFAULT_STATE, state) : JSON.parse(JSON.stringify(DEFAULT_STATE));
    fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error guardando estado:', err);
    return false;
  }
}

/* ------------------------------------------------------------------------
   RESOLUCIÓN DEL ORIGEN DE DATOS
   ------------------------------------------------------------------------ */
function useSupabase() {
  return isSupabaseConfigured();
}

async function getState() {
  if (useSupabase()) {
    return fetchStateFromSupabase();
  }
  return readStateFromFile();
}

async function saveState(state) {
  const incoming = JSON.parse(JSON.stringify(state || {}));

  // Preservar credenciales de administrador del estado persistido actual
  // cuando el cliente envía el estado anonimizado (sin adminUser/adminPass).
  if (incoming.settings) {
    try {
      const current = await getState();
      const curSettings = current.settings || {};
      const inSettings = incoming.settings;
      if (!inSettings.adminUser) inSettings.adminUser = curSettings.adminUser;
      if (!inSettings.adminPass) inSettings.adminPass = curSettings.adminPass;
      incoming.settings = inSettings;
    } catch (err) {
      // Si no se puede leer el estado actual, se conservan los valores por defecto
      if (!incoming.settings.adminUser) incoming.settings.adminUser = DEFAULT_STATE.settings.adminUser;
      if (!incoming.settings.adminPass) incoming.settings.adminPass = DEFAULT_STATE.settings.adminPass;
    }
  }

  if (useSupabase()) {
    return pushStateToSupabase(incoming);
  }
  return writeStateToFile(incoming);
}

async function resetState() {
  if (useSupabase()) {
    return pushStateToSupabase(DEFAULT_STATE);
  }
  return writeStateToFile(DEFAULT_STATE);
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  return token;
}

function isAdminRequest(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}

function sendJson(res, status, body) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function queueStateWrite(operation) {
  stateWriteQueue = stateWriteQueue.then(operation, operation);
  return stateWriteQueue;
}

/* ------------------------------------------------------------------------
   HELPERS HTTP
   ------------------------------------------------------------------------ */
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (err) { resolve(null); }
    });
  });
}

/* ------------------------------------------------------------------------
   APLICACIÓN
   ------------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let reqPath = urlObj.pathname;

  // ---- REST API: Estado persistente ----
  if (reqPath.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (reqPath === '/api/state' && req.method === 'GET') {
      try {
        const state = await getState();
        const publicState = sanitizePublicState(state);
        return sendJson(res, 200, publicState);
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    if (reqPath === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const state = await getState();
        const settings = state.settings || {};
        // En producción las credenciales pueden definirse como variables de
        // entorno, sin exponerlas ni guardarlas en el repositorio.
        const adminUser = process.env.ADMIN_USER || settings.adminUser;
        const adminPass = process.env.ADMIN_PASS || settings.adminPass;
        const user = (body && body.user ? String(body.user) : '').trim();
        const pass = (body && body.pass ? String(body.pass) : '').trim();

        if (user && pass && user === adminUser && pass === adminPass) {
          return sendJson(res, 200, { ok: true, token: createSession(user) });
        }
        res.writeHead(401);
        return res.end(JSON.stringify({ ok: false, error: 'Credenciales incorrectas' }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    if (reqPath === '/api/state' && req.method === 'POST') {
      if (!isAdminRequest(req)) return sendJson(res, 401, { error: 'Sesión administrativa requerida' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object') {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Cuerpo JSON inválido' }));
      }
      try {
        const ok = await queueStateWrite(() => saveState(body));
        res.writeHead(ok ? 200 : 500);
        return res.end(JSON.stringify({ ok }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    if (reqPath === '/api/reset' && req.method === 'POST') {
      if (!isAdminRequest(req)) return sendJson(res, 401, { error: 'Sesión administrativa requerida' });
      try {
        const ok = await queueStateWrite(() => resetState());
        res.writeHead(ok ? 200 : 500);
        return res.end(JSON.stringify({ ok }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    if (reqPath === '/api/vote' && req.method === 'POST') {
      const body = await readBody(req);
      const username = String(body && body.username || '').trim();
      const electionId = String(body && body.electionId || '').trim();
      const candidateId = String(body && body.candidateId || '').trim();
      if (!username || !electionId || !candidateId) return sendJson(res, 400, { success: false, message: 'Datos de votación incompletos.' });

      try {
        const result = await queueStateWrite(async () => {
          const state = await getState();
          const election = (state.elections || []).find((item) => item.id === electionId);
          if (!election) return { success: false, message: 'La elección especificada no existe.' };
          if (election.status !== 'Abierta') return { success: false, message: 'La elección no se encuentra abierta.' };
          const voter = (state.eligibleVoters || []).find((item) => String(item.robloxUser).trim().toLowerCase() === username.toLowerCase());
          if (!voter) return { success: false, message: 'Usuario no registrado en el censo electoral general.' };
          const candidate = (state.candidates || []).find((item) => item.id === candidateId && item.electionId === electionId);
          if (!candidate) return { success: false, message: 'El candidato seleccionado no pertenece a esta elección.' };
          if ((state.votes || []).some((item) => item.electionId === electionId && String(item.username).trim().toLowerCase() === username.toLowerCase())) {
            return { success: false, message: 'Este ciudadano ya registró su voto en esta elección.' };
          }
          const voteCount = (state.votes || []).filter((item) => item.electionId === electionId).length;
          const voterNumber = String(voteCount + 1).padStart(3, '0');
          const vote = { id: `vt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, electionId, candidateId, username, voterNumber, timestamp: new Date().toISOString(), hash: `CNE-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${voterNumber}` };
          state.votes = [...(state.votes || []), vote];
          const electionIndex = state.elections.findIndex((item) => item.id === electionId);
          state.elections[electionIndex] = { ...election, eligibleCount: (state.eligibleVoters || []).length, votesCount: voteCount + 1 };
          const ok = await saveState(state);
          if (!ok) throw new Error('No fue posible guardar el voto');
          return { success: true, voterNumber, voteRecord: vote, election };
        });
        return sendJson(res, result.success ? 201 : 400, result);
      } catch (err) {
        return sendJson(res, 500, { success: false, message: 'No fue posible registrar el voto. Intente nuevamente.' });
      }
    }

    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'Not Found' }));
  }

  // ---- Static files ----
  if (reqPath === '/') reqPath = '/index.html';

  // Solo se exponen los recursos que necesita el navegador. Así no quedan
  // accesibles archivos internos como data/state.json, .git o el código del API.
  const publicPath = /^(?:\/(?:index|admin)\.html|\/(?:css|js|assets)\/)/;
  if (!publicPath.test(reqPath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }

  const filePath = path.resolve(ROOT, '.' + reqPath);

  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('403 Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });

    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` SISTEMA ELECTORAL PEREIRA ROLEPLAY - DEV SERVER       `);
  console.log(` Interfaz Ciudadana: http://localhost:${PORT}/index.html `);
  console.log(` Panel Administrativo: http://localhost:${PORT}/admin.html`);
  console.log(` Persistencia: ${useSupabase() ? 'SUPABASE (Postgres)' : DATA_FILE}`);
  console.log(`=======================================================`);
});
