/* ==========================================================================
   CONSEJO NACIONAL ELECTORAL - PEREIRA ROLEPLAY
   API endpoint: POST /api/reset
   Restablece el estado por defecto en Supabase
   ========================================================================== */

const { DEFAULT_STATE, pushStateToSupabase } = require('../lib/data');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Método no permitido' }));
  }

  try {
    await pushStateToSupabase(DEFAULT_STATE);
    return res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: err.message }));
  }
};
