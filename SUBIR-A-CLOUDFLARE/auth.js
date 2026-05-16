/**
 * auth.js — Líbero Táctico
 * ─────────────────────────────────────────────────────────────────
 * Módulo de autenticación reutilizable en todo el sistema.
 * Requiere que supabaseClient.js esté cargado ANTES que este archivo.
 *
 * USO EN PÁGINAS PROTEGIDAS:
 *   dashboard.html  → LT_Auth.requireAuth()
 *   admin.html      → LT_Auth.requireAdminAuth()
 *
 * VARIABLES GLOBALES que expone:
 *   window.LT_Auth          → objeto con todas las funciones
 *   window.LT_CurrentUser   → user de Supabase Auth (después de requireAuth)
 *   window.LT_CurrentProfile → fila de profiles { role, full_name, email }
 */

(function (global) {

  // ── Cliente interno ────────────────────────────────────────────────────────
  function _client() {
    var c = global.__supabaseClient;
    if (!c) throw new Error("[LT_Auth] supabaseClient no encontrado. Carga supabaseClient.js primero.");
    return c;
  }

  // ── Paths de redirección ───────────────────────────────────────────────────
  var PATHS = {
    login:     "login.html",
    dashboard: "dashboard.html",
    admin:     "admin.html",
  };

  function _redirectTo(page) {
    console.log("[LT_Auth] ↳ Redirigiendo a:", page);
    global.location.replace(page);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // getSession
  // Obtiene la sesión activa. Retorna null si no hay sesión o si hay error.
  // ═══════════════════════════════════════════════════════════════════════════
  async function getSession() {
    try {
      var r = await _client().auth.getSession();
      if (r.error) {
        console.error("[LT_Auth] getSession error:", r.error.message);
        return null;
      }
      var s = r.data.session || null;
      console.log("[LT_Auth] getSession →", s ? "activa (" + s.user.email + ")" : "sin sesión");
      return s;
    } catch (err) {
      console.error("[LT_Auth] getSession excepción:", err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // getCurrentUser
  // Obtiene el usuario autenticado actual. Retorna null si no hay sesión.
  // ═══════════════════════════════════════════════════════════════════════════
  async function getCurrentUser() {
    try {
      var r = await _client().auth.getUser();
      if (r.error) {
        if (!r.error.message.includes("missing")) {
          console.error("[LT_Auth] getUser error:", r.error.message);
        }
        return null;
      }
      return r.data.user || null;
    } catch (err) {
      console.error("[LT_Auth] getUser excepción:", err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // getProfile
  // Lee la fila de profiles para un userId.
  // Retorna { role, full_name, email } o null si hay error.
  //
  // ⚠️  DIAGNÓSTICO: si esto retorna null, revisa:
  //     1. Supabase → Authentication → Policies → profiles → ¿existe política SELECT?
  //        Política mínima necesaria:
  //        CREATE POLICY "read_own_profile" ON public.profiles
  //          FOR SELECT USING (auth.uid() = id);
  //     2. Que la fila exista en profiles para ese user id.
  //     3. Que el usuario esté autenticado (token válido).
  // ═══════════════════════════════════════════════════════════════════════════
  async function getProfile(userId) {
    if (!userId) {
      console.error("[LT_Auth] getProfile: userId requerido.");
      return null;
    }
    try {
      var r = await _client()
        .from('profiles')
        .select('role, full_name, email')
        .eq('id', userId)
        .single();

      // ── Error de Supabase / RLS ──────────────────────────────────────────
      if (r.error) {
        console.error(
          "[LT_Auth] getProfile ERROR — message:", r.error.message,
          "| code:", r.error.code,
          "| userId:", userId
        );

        if (r.error.code === '42P01') {
          console.warn("[LT_Auth] ► La tabla 'profiles' no existe. ¿Ejecutaste el schema SQL en Supabase?");
        } else if (r.error.code === 'PGRST116') {
          console.warn("[LT_Auth] ► No hay fila en profiles para userId:", userId, "— ¿se creó el perfil al registrar el usuario?");
        } else if (
          r.error.message.includes('permission denied') ||
          r.error.message.includes('new row') ||
          r.error.code === '42501'
        ) {
          console.warn(
            "[LT_Auth] ► ERROR DE RLS/PERMISOS en profiles.",
            "\n    Solución: ejecutá en Supabase → SQL Editor:",
            "\n    CREATE POLICY \"read_own_profile\" ON public.profiles",
            "\n      FOR SELECT USING (auth.uid() = id);"
          );
        }
        return null;
      }

      if (!r.data) {
        console.warn("[LT_Auth] getProfile: sin datos para userId:", userId);
        return null;
      }

      console.log("[LT_Auth] getProfile OK → role:", r.data.role, "| email:", r.data.email);
      return r.data;

    } catch (err) {
      console.error("[LT_Auth] getProfile excepción inesperada:", err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // requireAuth
  // Para páginas que solo requieren estar logueado (ej: dashboard.html).
  // Oculta la página mientras verifica. Redirige a login si no hay sesión.
  // Después del check → window.LT_CurrentUser y window.LT_CurrentProfile quedan seteados.
  // ═══════════════════════════════════════════════════════════════════════════
  async function requireAuth() {
    document.documentElement.style.visibility = "hidden";
    // FAILSAFE: tras 4s la página se muestra sí o sí.
    var _visSafety = setTimeout(function() {
      console.warn("[LT_Auth] requireAuth failsafe: mostrando página tras 4s");
      document.documentElement.style.visibility = "visible";
    }, 4000);
    try {
      var sessionTO = new Promise(function(res){ setTimeout(function(){ res(null); }, 3000); });
      var session = await Promise.race([getSession(), sessionTO]);
      if (!session) {
        console.log("[LT_Auth] requireAuth: sin sesión (o timeout) → login");
        clearTimeout(_visSafety);
        _redirectTo(PATHS.login);
        return;
      }

      // 1) Intentar profile cacheado primero (instantáneo)
      var cachedProfile = null;
      try {
        var cachedRaw = localStorage.getItem('LT_CachedProfile_' + session.user.id);
        if (cachedRaw) cachedProfile = JSON.parse(cachedRaw);
      } catch(e){}

      // 1b) Fallback: construir profile mínimo desde LT_CachedRole_<email>
      // 2026-05-09 SECURITY (P1.5): se eliminó el fallback hardcoded
      // `liberotactico@gmail.com → admin`. Ese fallback hacía que CUALQUIER
      // usuario que se logueara con ese email obtuviera rol admin client-side,
      // incluso si profiles aún no tenía la fila o si el rol había cambiado.
      // El rol siempre debe venir del server. El bootstrap de admin ya está
      // hardcoded en schema_v3.sql (server-side, RLS-protected).
      if (!cachedProfile && session.user.email) {
        try {
          var emailKey = session.user.email.trim().toLowerCase();
          var cachedRole = localStorage.getItem('LT_CachedRole_' + emailKey);
          if (cachedRole) {
            cachedProfile = { id: session.user.id, email: session.user.email, role: cachedRole, active: true };
            console.log('[LT_Auth] profile reconstruido desde LT_CachedRole:', cachedRole);
          }
        } catch(e){}
      }

      if (cachedProfile) {
        global.LT_CurrentUser    = session.user;
        global.LT_CurrentProfile = cachedProfile;
        clearTimeout(_visSafety);
        document.documentElement.style.visibility = "visible";
        console.log("[LT_Auth] requireAuth OK (cache) | email:", session.user.email, "| role:", cachedProfile.role);
        // Refrescar profile en background (sin bloquear UI)
        getProfile(session.user.id).then(function(fresh){
          if (fresh) {
            global.LT_CurrentProfile = fresh;
            try { localStorage.setItem('LT_CachedProfile_' + session.user.id, JSON.stringify(fresh)); } catch(e){}
          }
        }).catch(function(){});
        return;
      }

      // 2) Sin caché: esperar getProfile con timeout 3s
      var profileTO = new Promise(function(res){ setTimeout(function(){ res(null); }, 3000); });
      var profile = await Promise.race([getProfile(session.user.id), profileTO]);
      global.LT_CurrentUser    = session.user;
      global.LT_CurrentProfile = profile;
      if (profile) {
        try { localStorage.setItem('LT_CachedProfile_' + session.user.id, JSON.stringify(profile)); } catch(e){}
      }

      console.log(
        "[LT_Auth] requireAuth OK | email:", session.user.email,
        "| role:", profile ? profile.role : "⚠️  sin perfil (timeout o RLS)"
      );
      clearTimeout(_visSafety);
      document.documentElement.style.visibility = "visible";

    } catch (err) {
      console.error("[LT_Auth] requireAuth excepción:", err);
      clearTimeout(_visSafety);
      document.documentElement.style.visibility = "visible";
      _redirectTo(PATHS.login);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // requireAdminAuth
  // Para páginas que requieren rol 'admin' (ej: admin.html).
  // Si no hay sesión → login. Si el rol no es admin → dashboard.
  // Maneja el caso edge donde profiles no existe (schema pendiente).
  // ═══════════════════════════════════════════════════════════════════════════
  async function requireAdminAuth() {
    document.documentElement.style.visibility = "hidden";
    try {
      var session = await getSession();
      if (!session) {
        console.log("[LT_Auth] requireAdminAuth: sin sesión → login");
        _redirectTo(PATHS.login + "?next=admin");
        return false;
      }

      var profile = await getProfile(session.user.id);
      global.LT_CurrentUser    = session.user;
      global.LT_CurrentProfile = profile;

      if (!profile) {
        // No se pudo leer el perfil — puede ser problema de RLS o fila faltante.
        // Por seguridad, NO se concede acceso: se redirige al login.
        console.warn("[LT_Auth] requireAdminAuth: no se pudo leer profile para userId:", session.user.id,
          "\n    Posibles causas:",
          "\n    1. La fila en 'profiles' no existe (¿trigger handle_new_user no corrió?).",
          "\n    2. Error de RLS en SELECT de profiles.",
          "\n    3. Schema no ejecutado en Supabase.",
          "\n    → Verifica que el schema SQL fue ejecutado y que existe la fila en profiles.");
        _redirectTo(PATHS.login + "?lt_error=no_profile");
        return false;
      }

      var normalizedRole = profile.role ? profile.role.toString().trim().toLowerCase() : '';
      if (normalizedRole !== 'admin') {
        console.warn("[LT_Auth] requireAdminAuth: rol '" + profile.role + "' no autorizado → dashboard");
        _redirectTo(PATHS.dashboard);
        return false;
      }

      console.log("[LT_Auth] requireAdminAuth OK | email:", session.user.email);
      document.documentElement.style.visibility = "visible";
      return true;

    } catch (err) {
      console.error("[LT_Auth] requireAdminAuth excepción:", err);
      _redirectTo(PATHS.login + "?next=admin");
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // logout
  // Cierra la sesión y redirige al login.
  // Opciones: { silent: true } para no redirigir.
  // ═══════════════════════════════════════════════════════════════════════════
  async function logout(options) {
    options = options || {};
    try {
      console.log("[LT_Auth] Cerrando sesión...");
      var r = await _client().auth.signOut();
      if (r.error) console.error("[LT_Auth] logout error:", r.error.message);
      global.LT_CurrentUser    = null;
      global.LT_CurrentProfile = null;
      if (!options.silent) _redirectTo(PATHS.login);
    } catch (err) {
      console.error("[LT_Auth] logout excepción:", err);
      _redirectTo(PATHS.login);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // loginWithEmail
  // Autentica con email/password y retorna { success, error, user, role }.
  // NO redirige — solo devuelve el resultado.
  //
  // Retorno:
  //   { success: true,  error: null,  user: {...}, role: 'admin'|'analista' }
  //   { success: false, error: "msg", user: null,  role: null }
  // ═══════════════════════════════════════════════════════════════════════════
  async function loginWithEmail(email, password) {
    try {
      if (!email || !password) {
        return { success: false, error: "Email y contraseña son requeridos.", user: null, role: null };
      }

      var emailClean = email.trim().toLowerCase();
      console.log("[LT_Auth] Intentando login:", emailClean);

      var r = await _client().auth.signInWithPassword({
        email:    emailClean,
        password: password,
      });

      if (r.error) {
        var errorMap = {
          "Invalid login credentials":  "Email o contraseña incorrectos.",
          "Email not confirmed":        "Confirmá tu email antes de ingresar.",
          "Too many requests":          "Demasiados intentos. Esperá unos minutos.",
          "User not found":             "No existe una cuenta con ese email.",
          "Invalid email":              "El formato del email no es válido.",
        };
        var msg = errorMap[r.error.message] || r.error.message;
        console.warn("[LT_Auth] Login fallido:", r.error.message);
        return { success: false, error: msg, user: null, role: null };
      }

      console.log("[LT_Auth] Login exitoso — Auth OK:", r.data.user.email);
      console.log("[LT_Auth] Leyendo rol desde profiles...");

      // ── Leer el rol del perfil (con timeout 3s + fallback a caché) ─────────
      var profileTO = new Promise(function(res){ setTimeout(function(){ res(null); }, 3000); });
      var profile = await Promise.race([getProfile(r.data.user.id), profileTO]);

      var role;
      if (profile && profile.role) {
        role = profile.role.toString().trim().toLowerCase();
        console.log("[LT_Auth] Rol obtenido desde DB:", role);
        try {
          localStorage.setItem('LT_CachedRole_' + emailClean, role);
          localStorage.setItem('LT_CachedProfile_' + r.data.user.id, JSON.stringify(profile));
        } catch(e){}
      } else {
        // Fallback 1: rol cacheado del último login exitoso (server era unreachable)
        try {
          var cached = localStorage.getItem('LT_CachedRole_' + emailClean);
          if (cached) {
            role = cached;
            console.warn("[LT_Auth] ⚠️ getProfile lento/falló — usando rol cacheado:", role);
            try {
              var minimalProfile = { id: r.data.user.id, email: emailClean, role: role, active: true };
              localStorage.setItem('LT_CachedProfile_' + r.data.user.id, JSON.stringify(minimalProfile));
            } catch(e){}
            return { success: true, error: null, user: r.data.user, role: role };
          }
        } catch(e){}

        // 2026-05-09 SECURITY (P1.5): se eliminó el fallback hardcoded
        // `liberotactico@gmail.com → admin`. El rol admin tiene que estar en
        // profiles a nivel server (schema_v3.sql ya lo bootstrapea). Si no se
        // puede leer profiles, NO asumir admin desde el cliente — escalación
        // de privilegios trivial.
        //
        // FALLBACK SEGURO: si no se pudo leer el perfil → 'analista'. El
        // usuario NO irá a admin.html. Si era admin, le aparece error claro.
        role = 'analista';
        console.warn(
          "[LT_Auth] ⚠️  No se pudo leer el perfil. Rol por defecto: 'analista'.",
          "\n    Si eres admin y ves este mensaje, revisa:",
          "\n    1. Política RLS de SELECT en la tabla profiles.",
          "\n    2. Que tu fila en profiles tenga role='admin'.",
          "\n    3. Que el bootstrap de schema_v3.sql se haya ejecutado."
        );
      }

      return { success: true, error: null, user: r.data.user, role: role };

    } catch (err) {
      console.error("[LT_Auth] loginWithEmail excepción:", err);
      return { success: false, error: "Error inesperado. Intenta de nuevo.", user: null, role: null };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // loginAndRedirect
  // Wrapper de loginWithEmail que redirige automáticamente según el rol.
  // admin → admin.html | analista → dashboard.html
  // ═══════════════════════════════════════════════════════════════════════════
  async function loginAndRedirect(email, password) {
    var result = await loginWithEmail(email, password);
    if (!result.success) return result;
    if (result.role === 'admin') {
      _redirectTo(PATHS.admin);
    } else {
      _redirectTo(PATHS.dashboard);
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // onAuthStateChange
  // Suscribirse a cambios de sesión (SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, etc.)
  // Retorna el objeto subscription (para poder cancelarlo con .unsubscribe()).
  // ═══════════════════════════════════════════════════════════════════════════
  function onAuthStateChange(callback) {
    var sub = _client().auth.onAuthStateChange(function(event, session) {
      console.log("[LT_Auth] Auth state change:", event, session ? "(" + session.user.email + ")" : "");
      callback(event, session);
    });
    return sub.data.subscription;
  }

  // ── Exponer en window.LT_Auth ──────────────────────────────────────────────
  global.LT_Auth = {
    // Consultas de sesión y perfil
    getSession:         getSession,
    getCurrentUser:     getCurrentUser,
    getProfile:         getProfile,
    // Guards de página
    requireAuth:        requireAuth,
    requireAdminAuth:   requireAdminAuth,
    // Login / Logout
    loginWithEmail:     loginWithEmail,
    loginAndRedirect:   loginAndRedirect,
    logout:             logout,
    // Suscripciones
    onAuthStateChange:  onAuthStateChange,
    // Constantes
    PATHS:              PATHS,
  };

})(window);
