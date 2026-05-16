/**
 * lt-logger.js — Logger central de errores cliente
 * ───────────────────────────────────────────────────────────────────────────
 * 2026-05-09 — agregado para Sprint 0. Resuelve el problema de los 268+
 * empty `catch(e){}` en dashboard.html que ocultan errores RLS, conflictos
 * multi-usuario y timeouts. Antes el dev no podía debuggear el sistema
 * porque los errores nunca llegaban: ni a la UI, ni a la consola, ni al server.
 *
 * Uso:
 *   LT_Log.error('scope', 'mensaje', { extra: 'data' })
 *   LT_Log.warn (...)
 *   LT_Log.info (...)
 *   LT_Log.uiError(scope, e, 'mensaje user-friendly')   ← console + toast
 *
 * Backend opcional: si window.__supabaseClient está disponible, los errores
 * de severidad 'error' se envían a la tabla `client_errors` (creada en el
 * SQL de Sprint 0). Si no existe la tabla, se silencia el insert sin romper.
 *
 * IMPORTANTE: este logger es additive y NO se llama desde el flujo de
 * evaluaciones. Solo donde se reemplazan empty catches.
 * ───────────────────────────────────────────────────────────────────────────
 */
(function (global) {
  'use strict';

  var BUFFER       = [];     // últimos N errores en memoria (debug en consola)
  var BUFFER_MAX   = 50;
  var REMOTE_QUEUE = [];     // queue para enviar al server
  var REMOTE_FLUSHING = false;
  var REMOTE_DISABLED = false; // si la tabla no existe, no insistir

  function _now() { return new Date().toISOString(); }

  function _sessionMeta() {
    var u = global.LT_CurrentUser || null;
    var p = global.LT_CurrentProfile || null;
    return {
      uid:   u ? u.id : null,
      email: u ? u.email : null,
      role:  p ? p.role : null,
      club:  global.LT_ACTIVE_CLUB_ID || null,
      url:   global.location ? global.location.href : null,
      ua:    global.navigator ? global.navigator.userAgent.slice(0, 200) : null,
    };
  }

  function _push(level, scope, msg, extra) {
    var entry = {
      ts:    _now(),
      level: level,
      scope: scope || 'app',
      msg:   String(msg || ''),
      extra: extra || null,
      meta:  _sessionMeta(),
    };
    BUFFER.push(entry);
    if (BUFFER.length > BUFFER_MAX) BUFFER.shift();

    // Console output con formato consistente
    var prefix = '[LT/' + entry.scope + ']';
    if (level === 'error')      console.error(prefix, msg, extra || '');
    else if (level === 'warn')  console.warn (prefix, msg, extra || '');
    else                        console.log  (prefix, msg, extra || '');

    // Solo errores van al server
    if (level === 'error') _enqueueRemote(entry);
    return entry;
  }

  function _normalizeExtra(e) {
    // Si recibimos un Error / objeto, sacar lo importante
    if (!e) return null;
    if (e instanceof Error) {
      return { name: e.name, message: e.message, stack: (e.stack || '').slice(0, 2000) };
    }
    if (typeof e === 'object') {
      try { return JSON.parse(JSON.stringify(e)); } catch (_) { return { toString: String(e) }; }
    }
    return { value: String(e) };
  }

  function _enqueueRemote(entry) {
    if (REMOTE_DISABLED) return;
    REMOTE_QUEUE.push(entry);
    // Debounce: agrupar inserts cada 2s
    if (!REMOTE_FLUSHING) {
      REMOTE_FLUSHING = true;
      setTimeout(_flushRemote, 2000);
    }
  }

  async function _flushRemote() {
    REMOTE_FLUSHING = false;
    if (REMOTE_DISABLED || !REMOTE_QUEUE.length) return;
    var sc = global.__supabaseClient;
    if (!sc) return; // sin cliente, mantener en memoria

    var batch = REMOTE_QUEUE.slice(0, 25); // máx 25 por insert
    var rows = batch.map(function (e) {
      return {
        level:      e.level,
        scope:      e.scope,
        message:    e.msg,
        extra:      e.extra,
        meta:       e.meta,
        client_ts:  e.ts,
      };
    });

    try {
      var res = await sc.from('client_errors').insert(rows);
      if (res.error) {
        // Tabla no existe (42P01) o RLS la bloquea → desactivar definitivo
        var code = res.error.code || '';
        if (code === '42P01' || code === '42501' || /relation .* does not exist/i.test(res.error.message || '')) {
          REMOTE_DISABLED = true;
          console.warn('[LT/logger] tabla client_errors no disponible — logging remoto desactivado');
          return;
        }
        // Otro error: dejar la queue como está
        console.warn('[LT/logger] insert client_errors falló:', res.error.message);
        return;
      }
      // OK: remover los enviados
      REMOTE_QUEUE.splice(0, batch.length);
      // Si quedaron más, agendar otro flush
      if (REMOTE_QUEUE.length) {
        REMOTE_FLUSHING = true;
        setTimeout(_flushRemote, 2000);
      }
    } catch (err) {
      console.warn('[LT/logger] flush exception:', err && err.message);
    }
  }

  // Toast UI: solo dispara si hay window.toast() en scope (admin/dashboard lo definen)
  function _toast(msg, kind) {
    try {
      if (typeof global.toast === 'function') global.toast(msg, kind || 'error');
    } catch (_) {}
  }

  global.LT_Log = {
    error: function (scope, msg, extra) { return _push('error', scope, msg, _normalizeExtra(extra)); },
    warn:  function (scope, msg, extra) { return _push('warn',  scope, msg, _normalizeExtra(extra)); },
    info:  function (scope, msg, extra) { return _push('info',  scope, msg, _normalizeExtra(extra)); },

    // Helper para reemplazar `catch(e){}`: loggea + opcional toast user-facing
    uiError: function (scope, err, userMsg) {
      _push('error', scope, userMsg || (err && err.message) || 'error', _normalizeExtra(err));
      if (userMsg) _toast(userMsg, 'error');
    },

    // Wrapper para promesas: .catch(LT_Log.catch('scope'))
    catch: function (scope, userMsg) {
      return function (err) {
        _push('error', scope, userMsg || (err && err.message) || 'error', _normalizeExtra(err));
        if (userMsg) _toast(userMsg, 'error');
      };
    },

    // Debug: ver el buffer en consola
    dump: function () { return BUFFER.slice(); },

    // Forzar flush remoto (útil antes de unload)
    flush: function () { return _flushRemote(); },
  };

  // Capturar errores no manejados globalmente
  global.addEventListener('error', function (ev) {
    if (!ev || !ev.error) return;
    _push('error', 'window.onerror', ev.message || 'unhandled error', _normalizeExtra(ev.error));
  });
  global.addEventListener('unhandledrejection', function (ev) {
    _push('error', 'unhandledrejection', (ev.reason && ev.reason.message) || 'unhandled promise rejection', _normalizeExtra(ev.reason));
  });

  // Flush al cerrar
  global.addEventListener('beforeunload', function () { _flushRemote(); });

})(window);
