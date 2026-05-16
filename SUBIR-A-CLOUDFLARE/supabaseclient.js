/**
 * supabaseClient.js — Líbero Táctico
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️  CONFIGURA AQUÍ TUS CREDENCIALES:
 *     https://supabase.com → tu proyecto → Project Settings → API
 *
 * 🔒 SEGURIDAD: Este archivo se sirve al navegador de cada visitante.
 *     NUNCA pongas aquí la `service_role` key — daría acceso admin a cualquiera.
 *     Solo `anon` key + URL del proyecto. Las operaciones privilegiadas
 *     (reset password, delete user, push masivo saltando RLS) deben vivir
 *     en Supabase Edge Functions o Netlify Functions con env vars del servidor.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SUPABASE_URL      = "https://jurtjxpobuhenfcyafcc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1cnRqeHBvYnVoZW5mY3lhZmNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4MjgwMzIsImV4cCI6MjA5MDQwNDAzMn0.dF_Dd0jYC67cGWED7FLOkmQD49d_s5UB6raYJyUUtCo";

// ── Guardia: credenciales sin configurar ─────────────────────────────────────
(function validateConfig() {
  if (SUPABASE_URL === "TU_URL" || SUPABASE_ANON_KEY === "TU_ANON_KEY") {
    console.warn(
      "[LT] ⚠️  Configura SUPABASE_URL y SUPABASE_ANON_KEY en supabaseClient.js\n" +
      "    Ve a: https://supabase.com → tu proyecto → Project Settings → API"
    );
  }
})();

// ── Crear cliente Supabase ───────────────────────────────────────────────────
// Requiere el CDN cargado ANTES: cdn.jsdelivr.net/npm/@supabase/supabase-js@2
const __supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:     true,   // mantiene sesión en localStorage
    autoRefreshToken:   true,   // renueva el JWT automáticamente
    detectSessionInUrl: true,   // captura tokens en URL (magic link / OAuth)
  },
  realtime: {
    // Throttle: ningún cliente puede emitir más de 5 eventos/seg.
    // Multi-tenant: con 30 clubes × 10 users = 300 conexiones, sin throttle
    // un usuario haciendo edits rápidos puede saturar el canal del club.
    params: { eventsPerSecond: 5 }
  }
});

// ── Cache de sesión en memoria ──────────────────────────────────────────────
// ANTES: cada llamada a sc.auth.getSession() pegaba al storage layer + decode JWT
// (en dashboard.html se llamaba 5 veces — diag, admin init, inbox, sync, etc.).
// Con un solo usuario activo navegando cada apertura de panel reabría auth IO.
// AHORA: mantenemos el último session.user que vio el listener y lo servimos
// instantáneo desde memoria. Auth fires SIGNED_IN/INITIAL_SESSION/TOKEN_REFRESHED/
// SIGNED_OUT, así que el cache nunca queda viejo.
var _ltSessionCache = null;
var _ltSessionReady = false;

// ── Mantener el JWT del Realtime sincronizado con el de Auth ────────────────
// Sin esto: cuando autoRefreshToken renueva el JWT (cada ~1h), el WebSocket
// de Realtime queda con el token viejo → Supabase lo cierra → CHANNEL_ERROR.
// Solución: cada vez que Auth emite TOKEN_REFRESHED/SIGNED_IN, le pasamos el
// access_token nuevo al Realtime client.
__supabaseClient.auth.onAuthStateChange(function(event, session) {
  // Mantener cache fresco para todas las transiciones que tocan la sesión.
  if (event === 'SIGNED_OUT') {
    _ltSessionCache = null;
  } else if (session) {
    _ltSessionCache = session;
  }
  _ltSessionReady = true;

  if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && session && session.access_token) {
    try { __supabaseClient.realtime.setAuth(session.access_token); }
    catch (e) { console.warn('[supabase] realtime.setAuth fallo:', e && e.message); }
  }
});

// Helper público: getSession() pero sin round-trip si ya tenemos la sesión
// cacheada por el listener. La PRIMERA llamada (antes de INITIAL_SESSION) sí
// hace el await real y popula el cache. Después: hit en memoria.
window.LT_GetCachedSession = async function() {
  if (_ltSessionReady) return _ltSessionCache;
  try {
    var r = await __supabaseClient.auth.getSession();
    _ltSessionCache = (r && r.data && r.data.session) || null;
    _ltSessionReady = true;
    return _ltSessionCache;
  } catch (e) {
    return null;
  }
};

// Invalidación manual (útil tras login/logout programático).
window.LT_InvalidateSession = function() {
  _ltSessionCache = null;
  _ltSessionReady = false;
};

// Exponer globalmente para que auth.js y otros módulos lo consuman
window.__supabaseClient = __supabaseClient;
