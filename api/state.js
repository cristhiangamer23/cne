/* ==========================================================================
   CONSEJO NACIONAL ELECTORAL - PEREIRA ROLEPLAY
   API endpoint: GET / POST /api/state
   Persistencia en Supabase (Postgres)
   ========================================================================== */

const { fetchStateFromSupabase, pushStateToSupabase } = require('../lib/data');

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

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    // ---- GET: leer estado completo ----
    if (req.method === 'GET') {
      const state = await fetchStateFromSupabase();
      return res.end(JSON.stringify(state));
    }

    // ---- POST: guardar estado completo ----
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'Cuerpo JSON inválido' }));
      }
      await pushStateToSupabase(body);
      return res.end(JSON.stringify({ ok: true }));
    }
  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: err.message }));
  }

  res.statusCode = 405;
  return res.end(JSON.stringify({ error: 'Método no permitido' }));
};
