/**
 * adminClient.js — Líbero Táctico Admin Panel
 * ─────────────────────────────────────────────────────────────────────────────
 * Lógica completa del panel de administración.
 * Requiere: supabaseClient.js, auth.js cargados antes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ─── Módulos del sistema ───────────────────────────────────────────────────
  var MODULES = ['rendimiento', 'rival', 'scouting', 'evaluacion', 'data', 'recomendaciones'];
  var MODULE_LABELS = {
    rendimiento:    { icon: '📊', label: 'Rendimiento' },
    rival:          { icon: '🔍', label: 'Análisis Rival' },
    scouting:       { icon: '👁',  label: 'Scouting' },
    evaluacion:     { icon: '📋', label: 'Evaluación' },
    data:           { icon: '📈', label: 'Data & Visual.' },
    recomendaciones:{ icon: '💡', label: 'Recomend. CT' },
  };

  // ─── Cotizador — precios base (USD/mes) ───────────────────────────────────
  var COT_MODULE_PRICES = { m1:20, m2:20, m3:25, m4:15, m5:15, m6:25 };
  var COT_SEAT_MULT     = { '3':1.0, '5':1.4, '10':2.2 };
  var COT_PERIOD_DISC   = { '1':0, '3':0, '6':0.05, '12':0.15 };
  var COT_PERIOD_LABELS = { '1':'mensual', '3':'trimestral', '6':'semestral', '12':'anual' };

  // ─── Monedas ───────────────────────────────────────────────────────────────
  var CURRENCIES = {
    USD: { symbol: '$',   name: 'Dólar estadounidense', rate: 1 },
    ARS: { symbol: '$',   name: 'Peso argentino',        rate: 950 },
    CLP: { symbol: '$',   name: 'Peso chileno',          rate: 910 },
    BRL: { symbol: 'R$',  name: 'Real brasileño',        rate: 5.0 },
    EUR: { symbol: '€',   name: 'Euro',                  rate: 0.92 },
    GBP: { symbol: '£',   name: 'Libra esterlina',       rate: 0.79 },
    MXN: { symbol: '$',   name: 'Peso mexicano',         rate: 17.5 },
    COP: { symbol: '$',   name: 'Peso colombiano',       rate: 3900 },
    UYU: { symbol: '$',   name: 'Peso uruguayo',         rate: 38 },
  };

  // ─── Estado global ─────────────────────────────────────────────────────────
  var DB = null;
  var state = {
    clubs:  [],
    users:  [],
    curSection: 'overview',
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ltAdminOps — Puente al endpoint privilegiado del servidor
  // Las operaciones que requieren service_role (crear/borrar auth.users,
  // cambiar password, invitar) pasan por la Edge Function de Supabase
  // 'admin-ops', que valida el JWT del admin y luego usa la service_role key
  // (inyectada por Supabase en la Edge Function, nunca visible al navegador).
  //
  // 2026-05-15 — Migrado de fetch('/api/admin-ops') (Cloudflare Pages Function)
  // a supabase.functions.invoke('admin-ops'). Razón: el sitio quedó deployado
  // como Worker de recursos estáticos en Cloudflare, que no ejecuta functions/.
  // La Edge Function vive en Supabase, independiente del hosting del sitio.
  // ══════════════════════════════════════════════════════════════════════════
  async function ltAdminOps(operation, payload) {
    payload = payload || {};
    var sc = window.__supabaseClient;
    if (!sc) throw new Error('Supabase client no inicializado.');

    // Verificar que haya sesión admin activa
    var sess = null;
    try {
      var s = await sc.auth.getSession();
      sess = s && s.data ? s.data.session : null;
    } catch(e) {}
    if (!sess || !sess.access_token) {
      throw new Error('No hay sesión activa. Iniciá sesión como admin.');
    }

    // Invocar la Edge Function 'admin-ops'. functions.invoke agrega
    // automáticamente el Authorization (JWT de la sesión) y el apikey.
    var data, error;
    try {
      var r = await sc.functions.invoke('admin-ops', {
        body: { operation: operation, payload: payload },
      });
      data  = r.data;
      error = r.error;
    } catch(invokeErr) {
      throw new Error(
        '⚠️ No se pudo contactar la Edge Function admin-ops.\n' +
        'Verificá que esté deployada en Supabase (Edge Functions → admin-ops).\n' +
        'Detalle: ' + (invokeErr && invokeErr.message || invokeErr)
      );
    }

    if (error) {
      // FunctionsHttpError trae el body real en error.context (un Response).
      var serverMsg = '';
      try {
        if (error.context && typeof error.context.json === 'function') {
          var errBody = await error.context.json();
          serverMsg = errBody && (errBody.error || errBody.message);
        }
      } catch(_) {}
      throw new Error(serverMsg || error.message || 'Error en admin-ops');
    }

    // Defensa: la función podría devolver { error } con status 200
    if (data && data.error) throw new Error(data.error);
    return data;
  }
  window.ltAdminOps = ltAdminOps;

  // ══════════════════════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════════════════════
  function init() {
    DB = window.__supabaseClient;
    if (!DB) { console.error('[AdminClient] supabase client no encontrado'); return; }

    updateTopbarDate();
    initSidebarUser();
    calcCotizador();
    loadPersonalization();

    // Fecha default de hoy para trial
    var ts = document.getElementById('trial-start');
    if (ts) ts.value = new Date().toISOString().split('T')[0];

    // Fecha en preview cotizador
    var prevDate = document.getElementById('prev-date');
    if (prevDate) prevDate.textContent = 'Propuesta generada el ' + new Date().toLocaleDateString('es-AR', { day:'2-digit', month:'long', year:'numeric' });

    loadAll();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UI — NAVEGACIÓN Y HELPERS
  // ══════════════════════════════════════════════════════════════════════════
  function showSection(id) {
    // Secciones
    document.querySelectorAll('.section').forEach(function(s){ s.classList.remove('active'); });
    var sec = document.getElementById('sec-' + id);
    if (sec) sec.classList.add('active');

    // Sidebar items
    document.querySelectorAll('.sb-item').forEach(function(btn){ btn.classList.remove('active'); });
    document.querySelectorAll('.sb-item').forEach(function(btn){
      if (btn.getAttribute('onclick') && btn.getAttribute('onclick').indexOf("'" + id + "'") !== -1) {
        btn.classList.add('active');
      }
    });

    // Topbar title
    var titles = {
      overview:         'Overview',
      clubs:            'Clubes',
      modules:          'Módulos',
      users:            'Usuarios',
      access:           'Log de Accesos',
      billing:          'Facturación',
      cotizador:        'Cotizador',
      analytics:        'Analytics',
      trials:           'Períodos de Prueba',
      messages:         'Mensajes',
      export:           'Exportar datos',
      personalization:  'Personalización',
      'cot-config':     'Configurar Cotizador',
    };
    var el = document.getElementById('topbar-title');
    if (el) el.textContent = titles[id] || id;

    state.curSection = id;

    // Lazy load según sección
    if (id === 'access')          loadAuditLog();
    if (id === 'billing')         loadBilling();
    if (id === 'trials')          loadTrials();
    if (id === 'analytics')       { loadAnalytics(); loadAIInsights(); }
    if (id === 'messages')        loadMessages();
    if (id === 'personalization') loadPersonalization();
    if (id === 'cot-config')     loadCotizadorSettings();
    // Cargar settings del cotizador automáticamente al entrar a la sección cotizador
    if (id === 'cotizador')      { if (!_cotConfig) loadCotizadorSettings(); else renderCotizadorPlanSelector(); }

    // Mobile: close sidebar after section change
    if (window.innerWidth <= 768 && typeof ltToggleSidebar === 'function') {
      ltToggleSidebar(false);
    }
    // Scroll content to top on mobile
    if (window.innerWidth <= 768) {
      var contentEl = document.querySelector('.content');
      if (contentEl) contentEl.scrollTo(0, 0);
      window.scrollTo(0, 0);
    }
  }

  function updateTopbarDate() {
    var el = document.getElementById('topbar-date');
    if (!el) return;
    var d = new Date();
    var dias = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
    var meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    el.textContent = dias[d.getDay()] + ' ' + d.getDate() + ' ' + meses[d.getMonth()] + ' ' + d.getFullYear();
  }

  function initSidebarUser() {
    var user = window._adminUser;
    if (!user) return;
    var email = user.email || '';
    var name = (window._adminProfile && window._adminProfile.full_name) || email.split('@')[0];
    var initial = name.charAt(0).toUpperCase();

    var av = document.getElementById('sb-avatar');
    var nm = document.getElementById('sb-user-name');
    var em = document.getElementById('sb-user-email');
    if (av) av.textContent = initial;
    if (nm) nm.textContent = name;
    if (em) em.textContent = email;
  }

  function doLogout() {
    LT_Auth.logout();
  }

  function refreshAll() {
    loadAll();
    toast('Datos actualizados', 'success');
  }

  async function loadAll() {
    loadOverview();
    // Load clubs FIRST so state.clubs is available for renderUsers fallback
    await loadClubs();
    loadModules();
    loadUsers();
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  var _toastTimer = null;
  function toast(msg, type) {
    type = type || 'success';
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = '';

    var icon = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
    var iconSpanA = document.createElement('span');
    iconSpanA.textContent = icon;
    var msgSpanA = document.createElement('span');
    msgSpanA.textContent = msg;
    el.appendChild(iconSpanA);
    el.appendChild(msgSpanA);
    el.className = 'toast ' + type + ' show';

    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function(){
      el.classList.remove('show');
    }, 3500);
  }

  // ── Modales ────────────────────────────────────────────────────────────────
  function openModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('open');

    // Pre-fill club selects on modal open
    if (id === 'modal-user')    populateClubSelects();
    if (id === 'modal-invoice') populateInvoiceClubSelect();
    if (id === 'modal-trial')   populateTrialClubSelect();
    if (id === 'modal-club') {
      // Reset form for new club
      var editId = document.getElementById('club-edit-id');
      if (editId && !editId.value) {
        document.getElementById('modal-club-title').textContent = 'Nuevo club';
        document.getElementById('club-name').value    = '';
        document.getElementById('club-short').value   = '';
        document.getElementById('club-city').value    = '';
        document.getElementById('club-price').value   = '';
        document.getElementById('club-notes').value   = '';
        // Reset logo
        var b64 = document.getElementById('club-logo-b64');
        if (b64) b64.value = '';
        var ph = document.getElementById('logo-upload-placeholder');
        var pv = document.getElementById('logo-upload-preview');
        if (ph) ph.style.display = '';
        if (pv) pv.style.display = 'none';
      }
    }
    if (id === 'modal-user') {
      var uid = document.getElementById('user-edit-id');
      if (uid && !uid.value) {
        document.getElementById('modal-user-title').textContent = 'Nuevo usuario';
        document.getElementById('user-name').value  = '';
        document.getElementById('user-email').value = '';
        document.getElementById('user-email').disabled = false; // siempre habilitado para nuevo usuario
        // Reset role fields to default
        var roleElN = document.getElementById('user-role');
        var roleCustElN = document.getElementById('user-role-custom');
        if (roleElN) roleElN.value = 'analista';
        if (roleCustElN) { roleCustElN.value = ''; roleCustElN.style.display = 'none'; }
        // Reset club to none
        var clubElN = document.getElementById('user-club');
        if (clubElN) clubElN.value = '';
        // Reset club role to default
        var clubRoleElN = document.getElementById('user-club-role');
        var clubRoleCustElN = document.getElementById('user-club-role-custom');
        if (clubRoleElN) clubRoleElN.value = 'analista';
        if (clubRoleCustElN) { clubRoleCustElN.value = ''; clubRoleCustElN.style.display = 'none'; }
        // Reset avatar
        var avatarPrev = document.getElementById('user-avatar-preview');
        var avatarB64 = document.getElementById('user-avatar-b64');
        var badgeElN = document.getElementById('user-club-logo-badge');
        if (avatarPrev) { avatarPrev.src = ''; avatarPrev.style.display = 'none'; }
        if (avatarB64) avatarB64.value = '';
        if (badgeElN) { badgeElN.style.display = 'none'; badgeElN.innerHTML = ''; }
        // Reset password section for new users
        ltResetPwdSection(false);
        // Reset email confirm checkbox (default: acceso inmediato)
        var chk = document.getElementById('user-email-confirm');
        if (chk) chk.checked = true;
      }
    }
  }

  function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
    // Reset hidden IDs
    if (id === 'modal-club') document.getElementById('club-edit-id').value = '';
    if (id === 'modal-user') { document.getElementById('user-edit-id').value = ''; var emailInp = document.getElementById('user-email'); if (emailInp) emailInp.disabled = false; }
    // Clear iframe content to free memory and avoid any style persistence
    if (id === 'modal-cot-preview') {
      var iframe = document.getElementById('cot-preview-content');
      if (iframe) iframe.srcdoc = '';
    }
  }

  // Cerrar modal al hacer click en overlay
  document.addEventListener('click', function(e){
    if (e.target && e.target.classList.contains('modal-overlay')) {
      e.target.classList.remove('open');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // OVERVIEW
  // ══════════════════════════════════════════════════════════════════════════
  async function loadOverview() {
    try {
      // KPIs principales
      // clubsRes: necesitamos las filas para MRR + recientes, pero solo las columnas usadas.
      // usersRes / trialsRes: solo el COUNT — `head:true` evita descargar filas.
      var clubsRes  = await DB.from('clubs')
        .select('id, name, plan_price, plan_currency, created_at, logo_b64, short_name', { count: 'exact' })
        .eq('active', true);
      var usersRes  = await DB.from('profiles').select('id', { count: 'exact', head: true }).neq('role', 'admin');
      var trialsRes = await DB.from('clubs').select('id', { count: 'exact', head: true }).eq('trial', true).eq('active', true);
      var invoicesRes = await DB.from('invoices').select('amount, currency, status');

      var clubs = clubsRes.data || [];
      var totalClubs = clubsRes.count || clubs.length;
      var totalUsers = usersRes.count || 0;
      var totalTrials = trialsRes.count || 0;

      // Leer moneda preferida del localStorage
      var pref = {};
      try { pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch(e){}
      var prefCur = pref.defaultCurrency || 'USD';
      var prefCurData = CURRENCIES[prefCur] || CURRENCIES['USD'];

      // MRR — convertir todo a moneda preferida
      var mrrUSD = clubs.reduce(function(sum, c){
        var price = parseFloat(c.plan_price) || 0;
        var rate  = (CURRENCIES[c.plan_currency] || CURRENCIES['USD']).rate;
        return sum + price / rate; // normalizar a USD
      }, 0);
      var mrrDisp = mrrUSD * prefCurData.rate;

      // Facturación total cobrada
      var invoices = invoicesRes.data || [];
      var totalPaid = invoices.filter(function(i){ return i.status === 'paid'; })
        .reduce(function(s,i){ var r = (CURRENCIES[i.currency]||CURRENCIES['USD']).rate; return s + (parseFloat(i.amount)||0)/r; }, 0);
      var totalPaidDisp = totalPaid * prefCurData.rate;

      // Churn simplificado: clubes inactivos / total
      var inactiveRes = await DB.from('clubs').select('id', { count: 'exact', head: true }).eq('active', false);
      var totalInactive = inactiveRes.count || 0;
      var totalAll = totalClubs + totalInactive;
      var convRate = totalAll > 0 ? Math.round((totalClubs / totalAll) * 100) : 100;

      setText('kpi-clubs', totalClubs);
      setText('kpi-users', totalUsers);
      setText('kpi-mrr', prefCurData.symbol + Math.round(mrrDisp).toLocaleString('es-AR'));
      setText('kpi-mrr-label', 'MRR (' + prefCur + ')');
      setText('kpi-trials', totalTrials);
      setText('kpi-conv', convRate + '%');
      setText('kpi-revenue', prefCurData.symbol + Math.round(totalPaidDisp).toLocaleString('es-AR'));
      setText('sb-clubs-count', totalClubs);
      setText('sb-users-count', totalUsers);

      // Clubes recientes
      var recent = (clubs || []).sort(function(a,b){ return new Date(b.created_at) - new Date(a.created_at); }).slice(0,5);
      renderRecentClubs(recent);

      // Actividad reciente (audit_log)
      var auditRes = await DB.from('audit_log')
        .select('*, profiles(email, full_name)')
        .order('created_at', { ascending: false })
        .limit(8);
      renderRecentActivity(auditRes.data || []);

      // Uso de módulos
      var modRes = await DB.from('club_modules').select('module').eq('enabled', true);
      renderModuleUsageBars(modRes.data || [], totalClubs);

      // Badge overdue
      var overdueRes = await DB.from('invoices').select('id', { count: 'exact', head: true }).eq('status', 'overdue');
      var overdueCount = overdueRes.count || 0;
      var badge = document.getElementById('sb-overdue-count');
      if (badge) {
        badge.style.display = overdueCount > 0 ? 'inline-flex' : 'none';
        badge.textContent = overdueCount;
      }

    } catch(err) {
      console.error('[AdminClient] loadOverview:', err);
    }
  }

  function renderRecentClubs(clubs) {
    var el = document.getElementById('recent-clubs-list');
    if (!el) return;
    if (!clubs.length) { el.innerHTML = '<div class="empty"><div class="empty-icon">🏟</div>Sin clubes aún</div>'; return; }

    el.innerHTML = clubs.map(function(c){
      var planTag = planBadge(c.plan);
      return '<div class="activity-item">' +
        '<div class="activity-dot" style="background:' + (c.active ? 'var(--green)' : 'var(--mut)') + ';box-shadow:' + (c.active ? '0 0 6px var(--green)' : 'none') + '"></div>' +
        '<div class="activity-body">' +
          '<div class="activity-text"><strong>' + esc(c.name) + '</strong> &nbsp;' + planTag + '</div>' +
          '<div class="activity-time">' + fmtDate(c.created_at) + ' · ' + (c.city || c.country || '') + '</div>' +
        '</div>' +
        '<div style="font-family:var(--cond);font-size:10px;color:var(--green);font-weight:600">' + fmtMoney(c.plan_price, c.plan_currency) + '</div>' +
      '</div>';
    }).join('');
  }

  function renderRecentActivity(logs) {
    var el = document.getElementById('recent-activity');
    if (!el) return;
    if (!logs.length) { el.innerHTML = '<div class="empty"><div class="empty-icon">📋</div>Sin actividad registrada</div>'; return; }

    var actionColors = { login:'var(--green)', logout:'var(--mut)', save_data:'var(--cyan)', create_club:'var(--orange)' };
    el.innerHTML = logs.map(function(l){
      var color = actionColors[l.action] || 'var(--txt)';
      var who = l.profiles ? (l.profiles.full_name || l.profiles.email || 'Usuario') : 'Sistema';
      return '<div class="activity-item">' +
        '<div class="activity-dot" style="background:' + color + '"></div>' +
        '<div class="activity-body">' +
          '<div class="activity-text"><strong>' + esc(who) + '</strong> — ' + formatAction(l.action) + '</div>' +
          '<div class="activity-time">' + timeAgo(l.created_at) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderModuleUsageBars(modRecords, totalClubs) {
    var el = document.getElementById('module-usage-bars');
    if (!el) return;

    var counts = {};
    MODULES.forEach(function(m){ counts[m] = 0; });
    modRecords.forEach(function(r){ if (counts[r.module] !== undefined) counts[r.module]++; });

    var maxVal = totalClubs || 1;
    el.innerHTML = MODULES.map(function(m){
      var cnt = counts[m];
      var pct = Math.round((cnt / maxVal) * 100);
      var ml = MODULE_LABELS[m];
      return '<div class="stat-bar-row">' +
        '<div class="stat-bar-label">' + ml.icon + ' ' + ml.label + '</div>' +
        '<div class="stat-bar-track"><div class="stat-bar-fill" style="width:' + pct + '%;background:var(--green)"></div></div>' +
        '<div class="stat-bar-val">' + cnt + '</div>' +
      '</div>';
    }).join('');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CLUBES
  // ══════════════════════════════════════════════════════════════════════════
  async function loadClubs() {
    try {
      var res = await DB.from('clubs').select('*, club_modules(module, enabled)').order('created_at', { ascending: false });
      state.clubs = res.data || [];
      renderClubs(state.clubs);
      populateExportClubSelect();
    } catch(err) {
      console.error('[AdminClient] loadClubs:', err);
    }
  }

  function renderClubs(clubs) {
    var tbody = document.getElementById('clubs-tbody');
    if (!tbody) return;
    if (!clubs.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No hay clubes registrados. ¡Creá el primero!</td></tr>';
      return;
    }
    tbody.innerHTML = clubs.map(function(c){
      var mods = (c.club_modules || []).filter(function(m){ return m.enabled; }).length;
      var status = c.trial
        ? '<span class="tag tag-orange">🎁 Trial</span>'
        : c.active
          ? '<span class="tag tag-green"><span class="dot dot-green"></span> Activo</span>'
          : '<span class="tag tag-mut">Inactivo</span>';
      var logoCell = c.logo_b64
        ? '<img src="' + c.logo_b64 + '" style="width:30px;height:30px;border-radius:6px;object-fit:contain;border:1px solid var(--brd);background:var(--bg3);flex-shrink:0">'
        : '<div style="width:30px;height:30px;border-radius:6px;background:rgba(57,232,112,.08);border:1px solid rgba(57,232,112,.15);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">🏟</div>';
      return '<tr>' +
        '<td><div style="display:flex;align-items:center;gap:9px">' +
          logoCell +
          '<div><strong style="color:var(--wht)">' + esc(c.name) + '</strong>' +
          (c.short_name ? '<div style="font-size:10px;color:var(--mut)">' + esc(c.short_name) + '</div>' : '') +
          '</div></div></td>' +
        '<td>' + planBadge(c.plan) + '</td>' +
        '<td style="text-align:center">' + (c.max_seats || 5) + '</td>' +
        '<td style="text-align:center"><span style="font-family:var(--cond);font-weight:600;color:var(--cyan)">' + mods + '/6</span></td>' +
        '<td>' + status + '</td>' +
        '<td style="font-family:var(--cond);font-weight:600;color:var(--green)">' + fmtMoney(c.plan_price, c.plan_currency) + '</td>' +
        '<td><div class="tbl-actions">' +
          '<button class="btn btn-sm" style="background:rgba(255,156,42,.12);color:#ff9c2a;border-color:rgba(255,156,42,.3)" onclick="enterClubDashboard(\'' + c.id + '\',\'' + esc(c.name) + '\')">⚡ Dashboard</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="editClub(\'' + c.id + '\')">✏️ Editar</button>' +
          '<button class="btn btn-red btn-sm" onclick="deleteClub(\'' + c.id + '\')">🗑</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');
  }

  function filterClubs() {
    var q = (document.getElementById('clubs-search') || {}).value || '';
    q = q.toLowerCase();
    var filtered = q
      ? state.clubs.filter(function(c){ return (c.name||'').toLowerCase().includes(q) || (c.city||'').toLowerCase().includes(q); })
      : state.clubs;
    renderClubs(filtered);
  }

  function editClub(id) {
    var club = state.clubs.find(function(c){ return c.id === id; });
    if (!club) return;

    document.getElementById('club-edit-id').value   = id;
    document.getElementById('modal-club-title').textContent = 'Editar club';
    document.getElementById('club-name').value      = club.name || '';
    document.getElementById('club-short').value     = club.short_name || '';
    document.getElementById('club-city').value      = club.city || '';
    document.getElementById('club-country').value   = club.country || 'Argentina';
    document.getElementById('club-notes').value     = club.notes || '';
    document.getElementById('club-price').value     = club.plan_price || '';

    var cat = document.getElementById('club-cat');
    if (cat) setSelectValue(cat, club.category || 'Primera');
    var plan = document.getElementById('club-plan');
    if (plan) setSelectValue(plan, club.plan || 'basic');
    var seats = document.getElementById('club-seats');
    if (seats) setSelectValue(seats, String(club.max_seats || 5));
    var cur = document.getElementById('club-currency');
    if (cur) setSelectValue(cur, club.plan_currency || 'USD');

    // Logo
    var b64Input = document.getElementById('club-logo-b64');
    if (b64Input) b64Input.value = club.logo_b64 || '';
    if (club.logo_b64) {
      var imgEl = document.getElementById('logo-preview-img');
      var ph = document.getElementById('logo-upload-placeholder');
      var pv = document.getElementById('logo-upload-preview');
      if (imgEl) imgEl.src = club.logo_b64;
      if (ph) ph.style.display = 'none';
      if (pv) pv.style.display = 'flex';
    }

    openModal('modal-club');
  }

  async function saveClub() {
    var id       = (document.getElementById('club-edit-id') || {}).value || '';
    var name     = trim(document.getElementById('club-name'));
    var shortN   = trim(document.getElementById('club-short'));
    var city     = trim(document.getElementById('club-city'));
    var country  = trim(document.getElementById('club-country'));
    var cat      = val(document.getElementById('club-cat'));
    var plan     = val(document.getElementById('club-plan'));
    var seats    = parseInt(val(document.getElementById('club-seats'))) || 5;
    var price    = parseFloat(trim(document.getElementById('club-price'))) || 0;
    var currency = val(document.getElementById('club-currency'));
    var notes    = trim(document.getElementById('club-notes'));
    var logob64  = (document.getElementById('club-logo-b64') || {}).value || null;

    if (!name) { toast('El nombre del club es obligatorio', 'error'); return; }

    var isTrial  = plan === 'trial';
    var trialEnd = null;
    if (isTrial) {
      var d = new Date();
      d.setDate(d.getDate() + 14);
      trialEnd = d.toISOString().split('T')[0];
    }

    var payload = {
      name: name,
      short_name: shortN || null,
      city: city || null,
      country: country || 'Argentina',
      category: cat || 'Primera',
      plan: plan,
      max_seats: seats,
      plan_price: price,
      plan_currency: currency || 'USD',
      notes: notes || null,
      trial: isTrial,
      trial_ends: trialEnd,
      active: true,
    };
    if (logob64) payload.logo_b64 = logob64;

    try {
      var res;
      if (id) {
        res = await DB.from('clubs').update(payload).eq('id', id);
      } else {
        // created_by es opcional — se omite si la columna aún no existe
        // (la acción queda registrada en audit_log de todas formas)
        var adminId = (window._adminUser || {}).id;
        if (adminId) payload.created_by = adminId;
        res = await DB.from('clubs').insert(payload);
        // Si falla por columna faltante, reintenta sin created_by
        if (res.error && res.error.message && res.error.message.includes('created_by')) {
          delete payload.created_by;
          res = await DB.from('clubs').insert(payload);
        }
      }

      if (res.error) throw res.error;

      toast(id ? 'Club actualizado ✓' : 'Club creado ✓', 'success');
      closeModal('modal-club');
      loadClubs();
      loadOverview();

      // Registrar acción
      logAction(id ? 'edit_club' : 'create_club', { club_name: name });

    } catch(err) {
      console.error('[AdminClient] saveClub:', err);
      toast('Error al guardar: ' + (err.message || err), 'error');
    }
  }

  async function deleteClub(id) {
    if (!confirm('¿Eliminar este club? Esta acción no se puede deshacer.')) return;
    try {
      var res = await DB.from('clubs').update({ active: false }).eq('id', id);
      if (res.error) throw res.error;
      toast('Club desactivado', 'success');
      loadClubs();
      loadOverview();
    } catch(err) {
      toast('Error: ' + err.message, 'error');
    }
  }

  function updatePlanPrice() {
    var plan = val(document.getElementById('club-plan'));
    var prices = { trial: 0, basic: 80, pro: 150, enterprise: 250 };
    var inp = document.getElementById('club-price');
    if (inp && prices[plan] !== undefined) inp.value = prices[plan];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MÓDULOS
  // ══════════════════════════════════════════════════════════════════════════
  async function loadModules() {
    try {
      var clubsRes = await DB.from('clubs').select('id, name').eq('active', true).order('name');
      var modsRes  = await DB.from('club_modules').select('club_id, module, enabled');

      var clubs = clubsRes.data || [];
      var mods  = modsRes.data  || [];

      // Indexar: { clubId: { module: enabled } }
      var modMap = {};
      mods.forEach(function(m){
        if (!modMap[m.club_id]) modMap[m.club_id] = {};
        modMap[m.club_id][m.module] = m.enabled;
      });

      renderModulesMatrix(clubs, modMap);
    } catch(err) {
      console.error('[AdminClient] loadModules:', err);
    }
  }

  function renderModulesMatrix(clubs, modMap) {
    var tbody = document.getElementById('modules-tbody');
    if (!tbody) return;
    if (!clubs.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No hay clubes activos</td></tr>';
      return;
    }

    tbody.innerHTML = clubs.map(function(c){
      var cells = MODULES.map(function(mod){
        var enabled = !!(modMap[c.id] && modMap[c.id][mod]);
        return '<td><input type="checkbox" class="chk" ' + (enabled ? 'checked' : '') +
          ' onchange="toggleModule(\'' + c.id + '\',\'' + mod + '\',this.checked)"></td>';
      }).join('');
      return '<tr><td><strong style="color:var(--wht)">' + esc(c.name) + '</strong></td>' + cells + '</tr>';
    }).join('');
  }

  async function toggleModule(clubId, module, enabled) {
    try {
      var res = await DB.from('club_modules').upsert({
        club_id:    clubId,
        module:     module,
        enabled:    enabled,
        enabled_at: new Date().toISOString(),
        enabled_by: (window._adminUser || {}).id,
      }, { onConflict: 'club_id,module' });

      if (res.error) throw res.error;

      var label = MODULE_LABELS[module] ? MODULE_LABELS[module].label : module;
      toast((enabled ? '✅ ' : '🔒 ') + label + (enabled ? ' activado' : ' desactivado'), 'success');
    } catch(err) {
      console.error('[AdminClient] toggleModule:', err);
      toast('Error al cambiar módulo: ' + err.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // USUARIOS
  // ══════════════════════════════════════════════════════════════════════════
  async function loadUsers() {
    try {
      // 2026-05-09 SECURITY (P0.2): la service_role salió del cliente. El admin
      // ya tiene RLS bypass via is_admin() para profiles y club_members, así que
      // usar el cliente normal es suficiente. Solo /auth/v1/admin/users
      // (metadata de email_confirmed_at, last_sign_in_at) requiere service_role
      // legítimamente — ese hop pasa por la Edge Function admin-ops.

      // ── Perfiles ─────────────────────────────────────────────────────────────
      var profilesRes = await DB.from('profiles').select('*').order('created_at', { ascending: false });
      var profiles = profilesRes.data || [];

      // ── Membresías ──────────────────────────────────────────────────────────
      var members = [];
      var membersRes = await DB.from('club_members').select('*, clubs(id, name, short_name, logo_b64)');
      if (!membersRes.error) {
        members = membersRes.data || [];
      } else {
        // logo_b64 puede no existir en schemas viejos — retry sin esa columna
        var membersRes2 = await DB.from('club_members').select('*, clubs(id, name, short_name)');
        members = membersRes2.data || [];
      }

      // ── Datos Auth (email_confirmed_at, invited_at, last_sign_in_at) ────────
      // Vienen via Edge Function admin-ops → /admin/users. Si no está deployada,
      // los campos quedan vacíos pero loadUsers no se rompe (degrada graceful).
      var authUsersMap = {};
      try {
        var authResp = await ltAdminOps('listAuthUsers', { page: 1, perPage: 1000 });
        var authList = (authResp && (authResp.users || authResp)) || [];
        authList.forEach(function(au) { authUsersMap[au.id] = au; });
      } catch (authErr) {
        console.warn('[AdminClient] listAuthUsers via Edge Function falló (degradación graceful):', authErr.message);
      }

      state.users = profiles.map(function(p){
        var mem   = members.find(function(m){ return m.user_id === p.id; });
        var authU = authUsersMap[p.id] || {};
        return Object.assign({}, p, {
          membership:         mem || null,
          email_confirmed_at: authU.email_confirmed_at || null,
          invited_at:         authU.invited_at || null,
          last_sign_in_at:    authU.last_sign_in_at || null,
        });
      });

      renderUsers(state.users);
    } catch(err) {
      console.error('[AdminClient] loadUsers:', err);
    }
  }

  function renderUsers(users) {
    var tbody = document.getElementById('users-tbody');
    if (!tbody) return;
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No hay usuarios registrados</td></tr>';
      return;
    }

    tbody.innerHTML = users.map(function(u){
      var rolTag = roleBadge(u.role);
      var clubData = u.membership && u.membership.clubs ? u.membership.clubs : null;
      // Fallback: if join didn't resolve but we have club_id, look up from state.clubs
      if (!clubData && u.membership && u.membership.club_id) {
        clubData = state.clubs && state.clubs.find(function(c){ return c.id === u.membership.club_id; }) || null;
      }
      var clubCell = clubData
        ? '<div style="display:flex;align-items:center;gap:6px">' +
            ((clubData.logo_b64 || clubData.logo_url)
              ? '<img src="' + (clubData.logo_b64 || clubData.logo_url) + '" style="width:20px;height:20px;border-radius:4px;object-fit:contain;border:1px solid var(--brd)">'
              : '<div style="width:20px;height:20px;border-radius:4px;background:rgba(57,232,112,.08);border:1px solid rgba(57,232,112,.15);display:flex;align-items:center;justify-content:center;font-size:9px">🏟</div>') +
            esc(clubData.name) + '</div>'
        : (u.membership && u.membership.club_id
            ? '<span style="color:var(--orange)" title="Club ID: ' + u.membership.club_id + '">⚠ Club sin nombre (sin join)</span>'
            : '<span style="color:var(--mut)">Sin club</span>');
      var cRole  = u.membership ? roleBadge(u.membership.role) : '—';
      // Estado del usuario
      var status;
      if (u.invited_at && !u.email_confirmed_at) {
        // Invitado vía endpoint invite — aún no hizo clic en el email
        status = '<span class="tag" style="background:rgba(255,156,42,.12);border:1px solid rgba(255,156,42,.3);color:#ff9c2a"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff9c2a;margin-right:5px;vertical-align:middle"></span>Invitado — pendiente</span>';
      } else if (!u.email_confirmed_at) {
        // Creado pero sin confirmar email
        status = '<span class="tag" style="background:rgba(255,217,62,.1);border:1px solid rgba(255,217,62,.3);color:#ffd93e"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ffd93e;margin-right:5px;vertical-align:middle"></span>Sin confirmar</span>';
      } else if (u.email_confirmed_at && !u.last_sign_in_at) {
        // Email confirmado pero nunca ha ingresado — esperando que cambie contraseña
        status = '<span class="tag" style="background:rgba(61,200,245,.1);border:1px solid rgba(61,200,245,.3);color:#3dc8f5"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#3dc8f5;margin-right:5px;vertical-align:middle"></span>Pendiente acceso</span>';
      } else if (!u.active) {
        status = '<span class="tag tag-mut">Inactivo</span>';
      } else {
        status = '<span class="tag tag-green"><span class="dot dot-green"></span> Activo</span>';
      }
      // ── 2026-05-12 Sprint1 C.6 — ya no se muestra password almacenada ──
      // Los passwords NO se persisten. Si el user lo olvida → botón 📧
      // (resendAccessEmail) le manda link de recuperación.
      var pwdCell = '';
      var name   = u.full_name || u.email || '—';
      var init   = name.charAt(0).toUpperCase();
      var avatarEl = u.avatar_b64
        ? '<img src="' + u.avatar_b64 + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid rgba(57,232,112,.3);flex-shrink:0">'
        : '<div style="width:32px;height:32px;border-radius:50%;background:rgba(57,232,112,.1);border:1px solid rgba(57,232,112,.2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--green);flex-shrink:0">' + init + '</div>';

      return '<tr>' +
        '<td><div style="display:flex;align-items:center;gap:10px">' +
          avatarEl +
          '<div>' +
            '<div style="font-weight:600;color:var(--wht)">' + esc(name) + '</div>' +
            '<div style="font-size:10px;color:var(--mut)">' + esc(u.email || '') + '</div>' +
            pwdCell +
          '</div>' +
        '</div></td>' +
        '<td>' + rolTag + '</td>' +
        '<td>' + clubCell + '</td>' +
        '<td>' + cRole + '</td>' +
        '<td>' + status + '</td>' +
        '<td><div class="tbl-actions">' +
          '<button class="btn btn-ghost btn-sm" onclick="editUser(\'' + u.id + '\')" title="Editar">✏️</button>' +
          '<button class="btn btn-sm" style="background:rgba(61,200,245,.1);color:#3dc8f5;border:1px solid rgba(61,200,245,.3)" title="Reenviar email de acceso (reset contraseña)" onclick="resendAccessEmail(\'' + esc(u.email || '') + '\')">📧</button>' +
          (u.active
            ? '<button class="btn btn-sm" style="background:rgba(255,156,42,.12);color:#ff9c2a;border:1px solid rgba(255,156,42,.3)" title="Desactivar" onclick="deactivateUser(\'' + u.id + '\')">⏸</button>'
            : '<button class="btn btn-sm" style="background:rgba(57,232,112,.12);color:#39e870;border:1px solid rgba(57,232,112,.3)" title="Activar" onclick="activateUser(\'' + u.id + '\')">▶</button>') +
          '<button class="btn btn-sm" style="background:rgba(255,62,94,.1);color:#ff3e5e;border:1px solid rgba(255,62,94,.3)" title="Eliminar usuario" onclick="deleteUser(\'' + u.id + '\', \'' + esc(u.email || u.full_name || u.id) + '\')">🗑</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');
  }

  function filterUsers() {
    var q = (document.getElementById('users-search') || {}).value || '';
    q = q.toLowerCase();
    var filtered = q
      ? state.users.filter(function(u){
          return (u.email||'').toLowerCase().includes(q) ||
                 (u.full_name||'').toLowerCase().includes(q);
        })
      : state.users;
    renderUsers(filtered);
  }

  // ── Reenviar email de acceso/recuperación a un usuario ──────────────────────
  async function resendAccessEmail(email) {
    if (!email) { toast('No se encontró el email del usuario.', 'error'); return; }
    if (!confirm('¿Reenviar email de recuperación de contraseña a ' + email + '?')) return;
    try {
      // Enviar reset sin redirectTo — la plantilla usa token_hash y construye su propia URL
      var res = await DB.auth.resetPasswordForEmail(email.toLowerCase());
      if (res.error) throw res.error;
      toast('✅ Email de recuperación enviado a ' + email + '. El usuario recibirá un link para crear su contraseña.', 'success');
    } catch(err) {
      toast('❌ No se pudo enviar el email: ' + (err.message || 'Error desconocido'), 'error');
    }
  }
  window.resendAccessEmail = resendAccessEmail;

  function editUser(id) {
    var user = state.users.find(function(u){ return u.id === id; });
    if (!user) return;

    document.getElementById('user-edit-id').value  = id;
    document.getElementById('modal-user-title').textContent = 'Editar usuario';
    document.getElementById('user-name').value     = user.full_name || '';
    document.getElementById('user-email').value    = user.email || '';
    document.getElementById('user-email').disabled = true; // no cambiar email

    // Avatar
    var avatarB64El = document.getElementById('user-avatar-b64');
    if (avatarB64El) avatarB64El.value = user.avatar_b64 || '';
    var avatarPrev = document.getElementById('user-avatar-preview');
    var avatarPh   = document.getElementById('user-avatar-placeholder');
    if (user.avatar_b64) {
      if (avatarPrev) { avatarPrev.src = user.avatar_b64; avatarPrev.style.display = 'block'; }
      if (avatarPh)   avatarPh.style.display = 'none';
    } else {
      if (avatarPrev) avatarPrev.style.display = 'none';
      if (avatarPh)   avatarPh.style.display   = 'flex';
    }

    populateClubSelects();

    // Set role — if not in predefined list, use 'personalizado' + fill custom input
    var roleEl    = document.getElementById('user-role');
    var roleCustEl = document.getElementById('user-role-custom');
    var storedRole = user.role || 'analista';
    var predefRoles = ['admin','gerente','director','representante','dt','ayudante_tecnico','entrenador_porteros','preparador_fisico','analista','analista_rendimiento','analista_rival','analista_mercado','scout'];
    if (predefRoles.indexOf(storedRole) === -1) {
      setSelectValue(roleEl, 'personalizado');
      if (roleCustEl) { roleCustEl.value = storedRole; roleCustEl.style.display = 'block'; }
    } else {
      setSelectValue(roleEl, storedRole);
      if (roleCustEl) { roleCustEl.style.display = 'none'; }
    }

    // Show club logo badge next to avatar
    var badgeEl = document.getElementById('user-club-logo-badge');
    if (badgeEl) {
      var userClub = state.clubs && state.clubs.find(function(c){ return user.membership && c.id === user.membership.club_id; });
      if (userClub) {
        var cLogo  = userClub.logo || userClub.logo_url || '';
        var cEmoji = userClub.emoji || '🏟';
        var cName  = userClub.name || '';
        badgeEl.style.display = 'flex';
        if (cLogo) {
          badgeEl.innerHTML = '<img src="' + cLogo + '" style="width:100%;height:100%;object-fit:cover" title="' + cName + '">';
        } else {
          badgeEl.title = cName;
          badgeEl.textContent = cEmoji;
        }
      } else {
        badgeEl.style.display = 'none';
        badgeEl.innerHTML = '';
      }
    }

    if (user.membership) {
      setTimeout(function(){
        setSelectValue(document.getElementById('user-club'), user.membership.club_id);
        var clubRoleEl  = document.getElementById('user-club-role');
        var clubRoleCust = document.getElementById('user-club-role-custom');
        var storedCR    = user.membership.role || 'analista';
        if (predefRoles.indexOf(storedCR) === -1 || storedCR === 'director') {
          // director is in club roles list, but not in global list — handle normally
        }
        var allClubRoles = ['director','gerente','representante','dt','ayudante_tecnico','entrenador_porteros','preparador_fisico','analista','analista_rendimiento','analista_rival','analista_mercado','scout'];
        if (allClubRoles.indexOf(storedCR) === -1) {
          setSelectValue(clubRoleEl, 'personalizado');
          if (clubRoleCust) { clubRoleCust.value = storedCR; clubRoleCust.style.display = 'block'; }
        } else {
          setSelectValue(clubRoleEl, storedCR);
          if (clubRoleCust) { clubRoleCust.style.display = 'none'; }
        }
      }, 100);
    }

    // ── 2026-05-12 Sprint1 C.6 — la sección de password ya no muestra el almacenado ──
    // El admin puede SETEAR un nuevo password desde el modal (que va via admin-ops/
    // updatePassword al server con service_role), pero NO leer el actual.
    ltResetPwdSection(true, '');

    openModal('modal-user');
  }

  async function saveUser() {
    var editId   = trim(document.getElementById('user-edit-id'));
    var name     = trim(document.getElementById('user-name'));
    var email    = trim(document.getElementById('user-email'));
    var role     = val(document.getElementById('user-role'));
    if (role === 'personalizado') {
      role = trim(document.getElementById('user-role-custom')) || 'analista';
    }
    var clubId   = val(document.getElementById('user-club'));
    var clubRole = val(document.getElementById('user-club-role'));
    if (clubRole === 'personalizado') {
      clubRole = trim(document.getElementById('user-club-role-custom')) || 'analista';
    }

    if (!email && !editId) { toast('El email es obligatorio', 'error'); return; }

    try {
      if (editId) {
        // ── EDITAR usuario existente ──────────────────────────────────────

        // ¿Cambiar contraseña?
        var newPwdChangeRow = document.getElementById('user-pwd-change-row');
        var newPwdVal = trim(document.getElementById('user-password-new'));
        if (newPwdChangeRow && newPwdChangeRow.style.display !== 'none' && newPwdVal && newPwdVal.length >= 6) {
          var pwdChanged = await ltAdminUpdatePassword(editId, newPwdVal);
          if (!pwdChanged) {
            toast('No se pudo actualizar la contraseña. Verifica la Service Role Key.', 'error');
            // Don't block the rest of the save
          }
        }

        var profileUpd = { role: role };
        if (name) profileUpd.full_name = name;
        var avatarB64 = (document.getElementById('user-avatar-b64') || {}).value || '';
        if (avatarB64) profileUpd.avatar_b64 = avatarB64;
        // ── 2026-05-12 Sprint1 C.6 — NO guardar passwords en DB ──
        // ANTES: admin_temp_password en plain text en profiles → leak garantizado
        // si alguien hace dump o si una RLS se rompe. AHORA: la contraseña se
        // muestra UNA VEZ en el toast al admin (que la copia al portapapeles).
        // Si el user la olvida, el admin puede resetearla con resetPasswordForEmail()
        // o con el endpoint admin-ops/updatePassword.
        var pRes = await DB.from('profiles').update(profileUpd).eq('id', editId);
        // If avatar_b64 column doesn't exist yet in DB, retry without it gracefully
        if (pRes.error && pRes.error.message && pRes.error.message.includes('avatar_b64')) {
          delete profileUpd.avatar_b64;
          pRes = await DB.from('profiles').update(profileUpd).eq('id', editId);
          if (!pRes.error) {
            toast('Foto no guardada — ejecuta la migración SQL para habilitar avatares', 'warning');
          }
        }
        // 2026-05-12 Sprint1 C.6: removido el retry de admin_temp_password — ya no se persiste.
        // If role value not in DB constraint, fall back to 'analista'
        if (pRes.error && pRes.error.message && pRes.error.message.includes('role_check')) {
          profileUpd.role = 'analista';
          pRes = await DB.from('profiles').update(profileUpd).eq('id', editId);
          if (!pRes.error) {
            toast('Rol guardado como "analista" en el sistema — el nombre personalizado se muestra solo en el club', 'warning');
          }
        }
        if (pRes.error) throw pRes.error;

        // Club membership
        if (clubId) {
          var memberPayload = {
            club_id: clubId,
            user_id: editId,
            role:    clubRole,
            active:  true,
          };
          var aId = (window._adminUser || {}).id;
          if (aId) { memberPayload.assigned_by = aId; memberPayload.assigned_at = new Date().toISOString(); }
          var mRes = await DB.from('club_members').upsert(memberPayload, { onConflict: 'club_id,user_id' });
          if (mRes.error && mRes.error.message && (mRes.error.message.includes('assigned_by') || mRes.error.message.includes('assigned_at'))) {
            delete memberPayload.assigned_by; delete memberPayload.assigned_at;
            mRes = await DB.from('club_members').upsert(memberPayload, { onConflict: 'club_id,user_id' });
          }
          // Si el role no pasa el CHECK constraint, mapear al rol básico permitido
          if (mRes.error && mRes.error.message && mRes.error.message.includes('role')) {
            var safeRole = (['dt','analista','scout'].indexOf(clubRole) !== -1) ? clubRole : 'analista';
            memberPayload.role = safeRole;
            mRes = await DB.from('club_members').upsert(memberPayload, { onConflict: 'club_id,user_id' });
            if (!mRes.error) {
              toast('Club asignado (rol guardado como "analista" — ejecuta migration_roles_fix.sql en Supabase para habilitar todos los roles)', 'warning');
            }
          }
          // Si el cliente normal falló por RLS y el admin tiene rol admin
          // correcto, el problema es la policy. Antes había un fallback a
          // service_role desde el browser (P0.2 — eliminado). Ahora propagamos
          // el error claro para que el dev arregle la policy.
          if (mRes.error) throw mRes.error;
        }

        toast('Usuario actualizado ✓', 'success');

      } else {
        // ── CREAR nuevo usuario ───────────────────────────────────────────
        var adminPwd = trim(document.getElementById('user-password'));
        var tempPass = adminPwd || ('LT_' + Math.random().toString(36).slice(2,10).toUpperCase() + '!');
        var emailConfirmChk = document.getElementById('user-email-confirm');
        var accesoInmediato = emailConfirmChk ? emailConfirmChk.checked : true;

        var newUserId = null;

        if (accesoInmediato) {
          // ACCESO INMEDIATO: crear con contraseña confirmada — sin email
          var newUserData = await ltAdminCreateAuthUser(email.toLowerCase(), tempPass, name || email.split('@')[0], true);
          newUserId = newUserData
            ? (newUserData.id || (newUserData.user && newUserData.user.id))
            : null;
        } else {
          // SIN ACCESO INMEDIATO: intentar con admin-ops/inviteUser
          // (proxy seguro a /auth/v1/admin/invite, validando JWT del admin
          // server-side). Si la Edge Function aún no está deployada, fallback
          // a signup normal + email de confirmación.
          var inviteOk = false;
          var inviteApiBody = null;
          try {
            inviteApiBody = await ltAdminOps('inviteUser', {
              email: email.toLowerCase(),
              data: { full_name: name || email.split('@')[0] }
            });
            if (inviteApiBody && inviteApiBody.id) {
              newUserId = inviteApiBody.id;
              tempPass = null;
              inviteOk = true;
            } else {
              console.warn('[AdminClient] inviteUser sin id, usando fallback:', inviteApiBody);
            }
          } catch(invErr) {
            console.warn('[AdminClient] inviteUser excepción, usando fallback:', invErr.message);
          }

          // Fallback: crear usuario como no-confirmado + enviar email de CONFIRMACIÓN DE CUENTA
          if (!inviteOk) {
            var invErrHint = (inviteApiBody && (inviteApiBody.msg || inviteApiBody.error_description || inviteApiBody.message)) || 'Edge Function no disponible';
            console.warn('[AdminClient] inviteUser falló (' + invErrHint + '), usando fallback signup');
            // email_confirm: false → usuario creado en estado "sin confirmar", Supabase no envía nada aún
            var fallbackData = await ltAdminCreateAuthUser(email.toLowerCase(), tempPass, name || email.split('@')[0], false);
            newUserId = fallbackData ? (fallbackData.id || (fallbackData.user && fallbackData.user.id)) : null;
            if (newUserId) {
              try {
                // Enviar email de CONFIRMACIÓN DE CUENTA (plantilla "Confirm signup"), NO de reset
                var resendRes = await DB.auth.resend({ type: 'signup', email: email.toLowerCase() });
                if (resendRes.error) throw resendRes.error;
                console.log('[AdminClient] Email de confirmación de cuenta enviado (fallback)');
              } catch(resendErr) {
                console.warn('[AdminClient] resend signup falló:', resendErr.message);
                // Último recurso
                try { await DB.auth.resetPasswordForEmail(email.toLowerCase()); } catch(e2) {}
              }
            }
            // No almacenar tempPass como admin_temp_password — el usuario creará su propia contraseña
            tempPass = null;
          }
        }

        if (newUserId) {
          // Actualizar profile (el trigger ya lo creó)
          // ── 2026-05-12 Sprint1 C.6 — sin admin_temp_password ──
          // El password NO se persiste. Se muestra una sola vez al admin.
          var newProfileData = {
            id:                 newUserId,
            email:              email.toLowerCase(),
            full_name:          name || email.split('@')[0],
            role:               role,
            active:             true,
          };
          var avatarB64New = (document.getElementById('user-avatar-b64') || {}).value || '';
          if (avatarB64New) newProfileData.avatar_b64 = avatarB64New;
          var profRes = await DB.from('profiles').upsert(newProfileData, { onConflict: 'id' });
          // If role value fails constraint, fallback to 'analista'
          if (profRes.error && profRes.error.message && profRes.error.message.includes('role_check')) {
            newProfileData.role = 'analista';
            profRes = await DB.from('profiles').upsert(newProfileData, { onConflict: 'id' });
          }
          // 2026-05-09 SECURITY (P0.2): se eliminó el fallback service_role
          // desde el browser. Si llegás acá, las RLS no le permiten al admin
          // upsertar profiles — verificar que profiles_insert_self_admin /
          // profiles_update_self_admin contemplen public.is_admin().
          if (profRes.error) {
            console.error('[AdminClient] profile upsert RLS-blocked:', profRes.error.message);
          }

          // Asignar al club
          if (clubId) {
            var newMemberPayload = { club_id: clubId, user_id: newUserId, role: clubRole, active: true };
            var aId2 = (window._adminUser || {}).id;
            if (aId2) newMemberPayload.assigned_by = aId2;
            var nmRes = await DB.from('club_members').upsert(newMemberPayload, { onConflict: 'club_id,user_id' });
            if (nmRes.error && nmRes.error.message && (nmRes.error.message.includes('assigned_by') || nmRes.error.message.includes('assigned_at'))) {
              delete newMemberPayload.assigned_by; delete newMemberPayload.assigned_at;
              nmRes = await DB.from('club_members').upsert(newMemberPayload, { onConflict: 'club_id,user_id' });
            }
            // Si el role no pasa el CHECK constraint, mapear al rol básico
            if (nmRes.error && nmRes.error.message && nmRes.error.message.includes('role')) {
              var safeRoleNew = (['dt','analista','scout'].indexOf(newMemberPayload.role) !== -1) ? newMemberPayload.role : 'analista';
              newMemberPayload.role = safeRoleNew;
              nmRes = await DB.from('club_members').upsert(newMemberPayload, { onConflict: 'club_id,user_id' });
              if (!nmRes.error) toast('Club asignado (rol guardado como "analista" — ejecuta migration_roles_fix.sql en Supabase para todos los roles)', 'warning');
            }
            // 2026-05-09 SECURITY (P0.2): se eliminó el fallback service_role
            // desde el browser. Si el cliente normal falla con admin auth, hay
            // un problema de RLS que hay que arreglar a nivel policy.
            if (nmRes.error) {
              console.error('[AdminClient] club_members insert RLS-blocked:', nmRes.error.message);
              toast('Usuario creado pero no se pudo asignar al club (RLS): ' + nmRes.error.message + '. Asígnalo manualmente.', 'warning');
            }
          }

          // ── Toast final según modo ──────────────────────────────────────
          if (accesoInmediato) {
            // ── 2026-05-12 Sprint1 C.6 — mostrar password una sola vez + auto-copy ──
            // La contraseña NO se persiste en DB. Se copia al portapapeles del admin
            // para que pueda pasársela al user por canal seguro (Signal/Telegram/etc).
            // Si el user la olvida, el admin usa el botón "📧" (resendAccessEmail).
            try {
              if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(tempPass);
              }
            } catch(_) {}
            console.info('[AdminClient] Contraseña temporal (única vez, no se persiste):', tempPass);
            toast('✅ Usuario creado. Contraseña copiada al portapapeles. Esta es la ÚNICA vez que se muestra: ' + tempPass, 'success');
          } else if (inviteOk) {
            // INVITE exitoso: el endpoint /admin/invite envió el email de bienvenida
            toast('✅ Usuario creado. Se envió email de bienvenida a ' + email + ' para que configure su contraseña.', 'success');
          } else {
            // FALLBACK: email de confirmación de cuenta enviado vía resend
            toast('✅ Usuario creado. Se envió email de confirmación de cuenta a ' + email + '. Recibirá un segundo email para crear su contraseña.', 'success');
          }
        } else {
          // No se pudo obtener el ID — el usuario puede haber sido creado en Auth pero sin perfil
          toast('⚠️ Usuario creado en Auth pero no se obtuvo ID. Verifica en la lista de usuarios.', 'warning');
        }
      }

      document.getElementById('user-email').disabled = false;
      closeModal('modal-user');
      loadUsers();

    } catch(err) {
      console.error('[AdminClient] saveUser error completo:', err);
      document.getElementById('user-email').disabled = false;
      var msg = err.message || String(err);
      if (msg.includes('already registered') || msg.includes('already been registered')) msg = 'Ya existe un usuario con ese email.';
      else if (msg.includes('weak') || msg.includes('password')) msg = 'La contraseña es muy débil. Usa al menos 8 caracteres.';
      else if (msg.includes('invalid') && msg.includes('email')) msg = 'El formato del email no es válido.';
      else if (msg.includes('rate') || msg.includes('limit')) msg = 'Demasiadas solicitudes. Espera un momento.';
      toast('Error al crear usuario: ' + msg, 'error');
    }
  }

  async function deactivateUser(id) {
    if (!confirm('¿Desactivar este usuario? Podrás reactivarlo después.')) return;
    try {
      var res = await DB.from('profiles').update({ active: false }).eq('id', id);
      if (res.error) throw res.error;
      // Desactivar membresías
      await DB.from('club_members').update({ active: false }).eq('user_id', id);
      toast('Usuario desactivado', 'success');
      loadUsers();
    } catch(err) {
      toast('Error: ' + err.message, 'error');
    }
  }

  async function activateUser(id) {
    if (!confirm('¿Activar este usuario?')) return;
    try {
      var res = await DB.from('profiles').update({ active: true }).eq('id', id);
      if (res.error) throw res.error;
      await DB.from('club_members').update({ active: true }).eq('user_id', id);
      toast('Usuario activado ✓', 'success');
      loadUsers();
    } catch(err) {
      toast('Error: ' + err.message, 'error');
    }
  }

  async function deleteUser(id, label) {
    if (!confirm('¿ELIMINAR permanentemente a "' + label + '"?\nEsta acción no se puede deshacer.')) return;
    if (!confirm('Confirmación final: se eliminará el usuario y todos sus datos. ¿Continuar?')) return;
    try {
      // 1. Nullificar referencias FK para no romper constraints
      await DB.from('audit_log').update({ user_id: null }).eq('user_id', id);
      await DB.from('clubs').update({ created_by: null }).eq('created_by', id);
      await DB.from('club_modules').update({ enabled_by: null }).eq('enabled_by', id);
      await DB.from('club_members').update({ assigned_by: null }).eq('assigned_by', id);
      await DB.from('messages').update({ from_id: null }).eq('from_id', id);
      await DB.from('messages').update({ to_user_id: null }).eq('to_user_id', id);
      // 2. Eliminar membresías del usuario
      await DB.from('club_members').delete().eq('user_id', id);
      // 3. Eliminar perfil (cascada limpia el resto)
      var delRes = await DB.from('profiles').delete().eq('id', id);
      if (delRes.error) throw delRes.error;
      // 4. Eliminar de auth.users via Edge Function admin-ops (server-side
      //    valida JWT del admin y usa service_role; nunca toca el browser).
      try {
        await ltAdminOps('deleteAuthUser', { userId: id });
      } catch (authErr) {
        // El profile ya fue eliminado en el paso 3; si falla aquí, queda
        // huérfano en auth.users. No es bloqueante (no puede loguearse sin
        // profile por trigger handle_new_user) pero hay que limpiarlo manual.
        console.warn('[AdminClient] deleteAuthUser via Edge Function falló:', authErr.message,
                     '— el perfil fue eliminado pero auth.users puede haber quedado huérfano.');
        toast('Perfil eliminado. La fila de auth.users debe limpiarse manualmente (Edge Function admin-ops no disponible).', 'warning');
      }
      toast('Usuario eliminado ✓', 'success');
      loadUsers();
    } catch(err) {
      console.error('[AdminClient] deleteUser:', err);
      toast('Error al eliminar: ' + err.message, 'error');
    }
  }

  function populateClubSelects() {
    var selects = ['user-club', 'export-club-select'];
    selects.forEach(function(selId){
      var sel = document.getElementById(selId);
      if (!sel) return;
      var cur = sel.value;
      var opts = '<option value="">— Sin club —</option>';
      state.clubs.forEach(function(c){
        opts += '<option value="' + c.id + '"' + (c.id === cur ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      });
      sel.innerHTML = opts;
    });
  }

  function populateInvoiceClubSelect() {
    var sel = document.getElementById('inv-club');
    if (!sel) return;
    sel.innerHTML = state.clubs.map(function(c){
      return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
    }).join('');
  }

  function populateTrialClubSelect() {
    var sel = document.getElementById('trial-club');
    if (!sel) return;
    sel.innerHTML = state.clubs.map(function(c){
      return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
    }).join('');
  }

  function populateExportClubSelect() {
    populateClubSelects();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AUDIT LOG
  // ══════════════════════════════════════════════════════════════════════════
  async function loadAuditLog() {
    var tbody = document.getElementById('audit-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="empty">Cargando...</td></tr>';

    try {
      var res = await DB.from('audit_log')
        .select('id, action, created_at, profiles(email, full_name), clubs(name)')
        .order('created_at', { ascending: false })
        .limit(200);

      var logs = res.data || [];
      if (!logs.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">Sin registros de acceso aún</td></tr>';
        return;
      }

      tbody.innerHTML = logs.map(function(l){
        var who   = l.profiles ? (l.profiles.full_name || l.profiles.email || '—') : '—';
        var club  = l.clubs ? l.clubs.name : '—';
        return '<tr>' +
          '<td>' + esc(who) + '</td>' +
          '<td style="color:var(--mut)">' + esc(club) + '</td>' +
          '<td><span class="tag tag-cyan">' + formatAction(l.action) + '</span></td>' +
          '<td style="font-size:11px;color:var(--mut)">' + fmtDateTime(l.created_at) + '</td>' +
          '<td style="width:40px;text-align:right">' +
            '<button class="btn btn-red btn-sm" style="padding:3px 8px" title="Eliminar registro" onclick="deleteAuditLog(\'' + l.id + '\')">🗑</button>' +
          '</td>' +
        '</tr>';
      }).join('');

    } catch(err) {
      console.error('[AdminClient] loadAuditLog:', err);
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="empty">Error al cargar logs</td></tr>';
    }
  }

  async function deleteAuditLog(id) {
    try {
      var res = await DB.from('audit_log').delete().eq('id', id);
      if (res.error) throw res.error;
      toast('Registro eliminado', 'success');
      loadAuditLog();
    } catch(e) {
      toast('Error al eliminar: ' + e.message, 'error');
    }
  }

  async function clearAllAuditLog() {
    if (!confirm('¿Eliminar TODOS los registros del log? Esta acción no se puede deshacer.')) return;
    try {
      // Eliminar registros más viejos a más nuevos — usando un filtro siempre verdadero
      var res = await DB.from('audit_log').delete().lt('created_at', new Date().toISOString());
      if (res.error) throw res.error;
      toast('Log limpiado ✓', 'success');
      loadAuditLog();
    } catch(e) {
      toast('Error: ' + e.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FACTURACIÓN
  // ══════════════════════════════════════════════════════════════════════════
  async function loadBilling() {
    try {
      populateBillingClubSelect(); // poblar select de clubs en modal factura
      var res = await DB.from('invoices')
        .select('*, clubs(name, plan, plan_currency)')
        .order('due_date', { ascending: false });

      var invoices = res.data || [];
      window._lastInvoices = invoices; // cache para editInvoice

      // ── KPIs principales ────────────────────────────────────────────────────
      var activeClubs = state.clubs.filter(function(c){ return c.active; });
      var mrr = activeClubs.reduce(function(s,c){
        var price = parseFloat(c.plan_price) || 0;
        var rate  = (CURRENCIES[c.plan_currency] || CURRENCIES['USD']).rate;
        return s + price / rate; // convertir a USD equivalente
      }, 0);

      var overdue  = invoices.filter(function(i){ return i.status === 'overdue'; });
      var pending  = invoices.filter(function(i){ return i.status === 'pending'; });
      var paid     = invoices.filter(function(i){ return i.status === 'paid'; });

      var now = new Date();
      var next30 = invoices.filter(function(i){
        if (i.status !== 'pending' || !i.due_date) return false;
        var diff = (new Date(i.due_date) - now) / 86400000;
        return diff >= 0 && diff <= 30;
      });
      var next30total = next30.reduce(function(s,i){ return s + (parseFloat(i.amount)||0); }, 0);

      setText('bil-mrr', 'USD ' + mrr.toFixed(0));
      setText('bil-overdue', overdue.length);
      setText('bil-next', overdue.length === 0 ? ('$' + next30total.toFixed(0)) : overdue.length + ' fact.');
      setText('bil-total-inv', invoices.length);
      setText('bil-paid', paid.length);
      setText('bil-pending', pending.length);
      setText('bil-overdue2', overdue.length);

      // Badge sidebar
      var badge = document.getElementById('sb-overdue-count');
      if (badge) {
        badge.style.display = overdue.length ? 'inline-flex' : 'none';
        badge.textContent = overdue.length;
      }

      // ── Panel: Ingresos por moneda ─────────────────────────────────────────
      var byCurrency = document.getElementById('bil-by-currency');
      if (byCurrency) {
        var curTotals = {};
        invoices.forEach(function(i){
          if (i.status !== 'paid') return;
          var cur = i.currency || 'USD';
          curTotals[cur] = (curTotals[cur] || 0) + (parseFloat(i.amount) || 0);
        });
        var curKeys = Object.keys(curTotals);
        if (!curKeys.length) {
          byCurrency.innerHTML = '<div class="empty">Sin pagos registrados</div>';
        } else {
          var maxCur = Math.max.apply(null, curKeys.map(function(k){ return curTotals[k]; }));
          byCurrency.innerHTML = curKeys.sort(function(a,b){ return curTotals[b]-curTotals[a]; }).map(function(cur){
            var total = curTotals[cur];
            var pct = Math.round((total / maxCur) * 100);
            var curData = CURRENCIES[cur] || { symbol:cur+' ' };
            return '<div class="stat-bar-row">' +
              '<div class="stat-bar-label">' + cur + ' — ' + (curData.name || cur) + '</div>' +
              '<div class="stat-bar-track"><div class="stat-bar-fill" style="width:' + pct + '%;background:var(--green)"></div></div>' +
              '<div class="stat-bar-val" style="width:80px">' + curData.symbol + Math.round(total).toLocaleString('es-AR') + '</div>' +
            '</div>';
          }).join('');
        }
      }

      // ── Panel: Próximos vencimientos ───────────────────────────────────────
      var upcoming = document.getElementById('bil-upcoming');
      if (upcoming) {
        var upcoming30 = next30.sort(function(a,b){ return new Date(a.due_date) - new Date(b.due_date); }).slice(0,8);
        if (!upcoming30.length) {
          upcoming.innerHTML = '<div class="empty"><div class="empty-icon">📆</div>Sin vencimientos en los próximos 30 días</div>';
        } else {
          upcoming.innerHTML = upcoming30.map(function(inv){
            var days = Math.ceil((new Date(inv.due_date) - now) / 86400000);
            var club = inv.clubs ? inv.clubs.name : '—';
            var urgency = days <= 5 ? 'var(--red)' : days <= 10 ? 'var(--orange)' : 'var(--txt)';
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(34,37,64,.5)">' +
              '<div>' +
                '<div style="font-size:12px;color:var(--wht);font-weight:600">' + esc(club) + '</div>' +
                '<div style="font-size:10px;color:var(--mut)">' + fmtDate(inv.due_date) + '</div>' +
              '</div>' +
              '<div style="text-align:right">' +
                '<div style="font-family:var(--cond);font-size:12px;font-weight:700;color:var(--green)">' + fmtMoney(inv.amount, inv.currency) + '</div>' +
                '<div style="font-size:10px;color:' + urgency + '">' + days + ' días</div>' +
              '</div>' +
            '</div>';
          }).join('');
        }
      }

      // ── Tabla ──────────────────────────────────────────────────────────────
      var tbody = document.getElementById('billing-tbody');
      if (!tbody) return;
      if (!invoices.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">Sin facturas registradas</td></tr>';
        return;
      }

      var statusTags = {
        pending:   '<span class="tag tag-orange">⏳ Pendiente</span>',
        paid:      '<span class="tag tag-green">✅ Pagado</span>',
        overdue:   '<span class="tag tag-red">🔴 Vencido</span>',
        cancelled: '<span class="tag tag-mut">Cancelado</span>',
      };

      tbody.innerHTML = invoices.map(function(inv){
        var clubName  = inv.clubs ? inv.clubs.name : '—';
        var statusTag = statusTags[inv.status] || inv.status;

        return '<tr>' +
          '<td><strong style="color:var(--wht)">' + esc(clubName) + '</strong>' +
            (inv.notes ? '<div style="font-size:10px;color:var(--mut);margin-top:2px">' + esc(inv.notes.slice(0,40)) + '</div>' : '') +
          '</td>' +
          '<td>' + planBadge((inv.clubs||{}).plan || 'basic') + '</td>' +
          '<td style="font-family:var(--cond);font-weight:600;color:var(--green)">' + fmtMoney(inv.amount, inv.currency) + '</td>' +
          '<td style="font-size:11px;color:var(--mut)">' + (inv.due_date ? fmtDate(inv.due_date) : '—') + '</td>' +
          '<td>' + statusTag + '</td>' +
          '<td><div class="tbl-actions">' +
            '<button class="btn btn-ghost btn-sm" title="Ver recibo" onclick="viewReceipt(\'' + inv.id + '\')" style="padding:3px 8px">🧾</button>' +
            '<button class="btn btn-ghost btn-sm" title="Editar factura" onclick="editInvoice(\'' + inv.id + '\')" style="padding:3px 8px">✏️</button>' +
            (inv.status === 'pending' || inv.status === 'overdue'
              ? '<button class="btn btn-green btn-sm" onclick="markPaid(\'' + inv.id + '\')">✓ Pagar</button>'
              : '') +
            '<button class="btn btn-red btn-sm" title="Eliminar factura" onclick="deleteInvoice(\'' + inv.id + '\')" style="padding:3px 8px">🗑</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');

    } catch(err) {
      console.error('[AdminClient] loadBilling:', err);
    }
  }

  function newInvoice() {
    // Reset modal to creation mode
    var editId = document.getElementById('inv-edit-id');
    var title  = document.getElementById('modal-invoice-title');
    var btn    = document.getElementById('inv-save-btn');
    if (editId) editId.value = '';
    if (title)  title.textContent = 'Nueva factura';
    if (btn)    btn.textContent = 'Guardar factura';
    // Clear fields
    ['inv-amount','inv-start','inv-end','inv-due','inv-notes'].forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    var statusEl = document.getElementById('inv-status');
    if (statusEl) statusEl.value = 'pending';
    populateBillingClubSelect();
    openModal('modal-invoice');
  }

  async function editInvoice(id) {
    try {
      var inv = null;
      // Try state cache first
      var cached = (window._lastInvoices || []).find(function(i){ return i.id === id; });
      if (cached) {
        inv = cached;
      } else {
        var res = await DB.from('invoices').select('*').eq('id', id).single();
        if (res.error) throw res.error;
        inv = res.data;
      }

      var editId = document.getElementById('inv-edit-id');
      var title  = document.getElementById('modal-invoice-title');
      var btn    = document.getElementById('inv-save-btn');
      if (editId) editId.value = id;
      if (title)  title.textContent = 'Editar factura';
      if (btn)    btn.textContent = 'Actualizar factura';

      // Pre-fill fields
      populateBillingClubSelect();
      setTimeout(function(){
        setSelectValue(document.getElementById('inv-club'), inv.club_id);
      }, 80);
      var amountEl = document.getElementById('inv-amount');
      if (amountEl) amountEl.value = inv.amount || '';
      setSelectValue(document.getElementById('inv-currency'), inv.currency || 'USD');
      var startEl = document.getElementById('inv-start');
      if (startEl) startEl.value = (inv.period_start || '').split('T')[0];
      var endEl = document.getElementById('inv-end');
      if (endEl) endEl.value = (inv.period_end || '').split('T')[0];
      var dueEl = document.getElementById('inv-due');
      if (dueEl) dueEl.value = (inv.due_date || '').split('T')[0];
      setSelectValue(document.getElementById('inv-status'), inv.status || 'pending');
      var notesEl = document.getElementById('inv-notes');
      if (notesEl) notesEl.value = inv.notes || '';

      openModal('modal-invoice');
    } catch(err) {
      toast('Error al cargar factura: ' + err.message, 'error');
    }
  }

  function populateBillingClubSelect() {
    var sel = document.getElementById('inv-club');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Seleccioná un club —</option>' +
      state.clubs.map(function(c){ return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
  }

  async function saveInvoice() {
    var editId  = (document.getElementById('inv-edit-id') || {}).value || '';
    var clubId  = val(document.getElementById('inv-club'));
    var amount  = parseFloat(trim(document.getElementById('inv-amount')));
    var cur     = val(document.getElementById('inv-currency'));
    var start   = val(document.getElementById('inv-start'));
    var end     = val(document.getElementById('inv-end'));
    var due     = val(document.getElementById('inv-due'));
    var status  = val(document.getElementById('inv-status'));
    var notes   = trim(document.getElementById('inv-notes'));

    if (!clubId) { toast('Seleccioná un club', 'error'); return; }
    if (!amount || isNaN(amount)) { toast('Ingresá un monto válido', 'error'); return; }

    var payload = {
      club_id:      clubId,
      amount:       amount,
      currency:     cur || 'USD',
      period_start: start || null,
      period_end:   end   || null,
      due_date:     due   || null,
      status:       status || 'pending',
      notes:        notes  || null,
    };

    try {
      var res;
      if (editId) {
        res = await DB.from('invoices').update(payload).eq('id', editId);
        if (res.error) throw res.error;
        toast('Factura actualizada ✓', 'success');
      } else {
        res = await DB.from('invoices').insert(payload);
        if (res.error) throw res.error;
        toast('Factura creada ✓', 'success');
      }
      closeModal('modal-invoice');
      loadBilling();
    } catch(err) {
      toast('Error: ' + err.message, 'error');
    }
  }

  async function markPaid(id) {
    try {
      var res = await DB.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', id);
      if (res.error) throw res.error;
      toast('Factura marcada como pagada ✓', 'success');
      loadBilling();
    } catch(err) {
      toast('Error: ' + err.message, 'error');
    }
  }

  async function deleteInvoice(id) {
    if (!confirm('¿Eliminar esta factura? Esta acción no se puede deshacer.')) return;
    try {
      var res = await DB.from('invoices').delete().eq('id', id);
      if (res.error) throw res.error;
      toast('Factura eliminada ✓', 'success');
      loadBilling();
    } catch(err) {
      toast('Error al eliminar: ' + err.message, 'error');
    }
  }

  async function viewReceipt(id) {
    try {
      var res = await DB.from('invoices')
        .select('*, clubs(name, plan, plan_currency, city, country)')
        .eq('id', id)
        .single();
      if (res.error) throw res.error;
      var inv = res.data;
      var pref = {};
      try { pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch(e){}
      var company   = pref.company  || 'Líbero Táctico';
      var email     = pref.email    || 'hola@liberotactico.com';
      var website   = pref.website  || 'www.liberotactico.com';
      var accent    = pref.accent   || '#39e870';
      var clubName  = inv.clubs ? inv.clubs.name : '—';
      var statusMap = { paid:'PAGADO', pending:'PENDIENTE', overdue:'VENCIDO', cancelled:'CANCELADO' };
      var statusCol = { paid:'#22c55e', pending:'#f97316', overdue:'#ef4444', cancelled:'#9ca3af' };
      var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Recibo #' + id.slice(-6).toUpperCase() + '</title>' +
        '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;background:#f7f8fc;padding:40px;color:#1a1d2e}' +
        '.card{max-width:620px;margin:auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}' +
        '.header{background:' + accent + ';padding:28px 32px;color:#000}' +
        '.header h1{font-size:22px;font-weight:900;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px}' +
        '.header .sub{font-size:12px;opacity:.7}' +
        '.body{padding:32px}' +
        '.row{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}' +
        '.label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#9ca3af;margin-bottom:4px}' +
        '.val{font-size:14px;font-weight:600;color:#1a1d2e}' +
        '.amount{font-size:36px;font-weight:900;color:' + accent + ';margin:24px 0}' +
        '.divider{border:none;border-top:1px solid #f0f1f7;margin:20px 0}' +
        '.status{display:inline-block;padding:4px 14px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:1px;color:#fff;background:' + (statusCol[inv.status]||'#9ca3af') + '}' +
        '.footer{padding:20px 32px;background:#f7f8fc;font-size:10px;color:#9ca3af;text-align:center;border-top:1px solid #f0f1f7}' +
        '@media print{body{padding:0;background:#fff}.card{box-shadow:none;border-radius:0}}' +
        '</style></head><body>' +
        '<div class="card">' +
          '<div class="header"><h1>Recibo</h1><div class="sub">' + esc(company) + ' · ' + esc(website) + '</div></div>' +
          '<div class="body">' +
            '<div class="row">' +
              '<div><div class="label">Para</div><div class="val">' + esc(clubName) + '</div>' + (inv.clubs && inv.clubs.city ? '<div style="font-size:11px;color:#9ca3af">' + esc(inv.clubs.city) + ', ' + esc(inv.clubs.country || '') + '</div>' : '') + '</div>' +
              '<div style="text-align:right"><div class="label">N° Recibo</div><div class="val">#' + id.slice(-8).toUpperCase() + '</div>' +
                (inv.due_date ? '<div style="font-size:11px;color:#9ca3af">Vence: ' + fmtDate(inv.due_date) + '</div>' : '') + '</div>' +
            '</div>' +
            '<hr class="divider">' +
            '<div class="label">Período</div>' +
            '<div class="val" style="margin-bottom:8px">' + (inv.period_start ? fmtDate(inv.period_start) : '—') + ' → ' + (inv.period_end ? fmtDate(inv.period_end) : '—') + '</div>' +
            (inv.notes ? '<div style="font-size:11px;color:#9ca3af;margin-top:4px">' + esc(inv.notes) + '</div>' : '') +
            '<div class="amount">' + fmtMoney(inv.amount, inv.currency) + '</div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
              '<span class="status">' + (statusMap[inv.status] || inv.status) + '</span>' +
              (inv.paid_at ? '<div style="font-size:11px;color:#9ca3af">Pagado: ' + fmtDate(inv.paid_at) + '</div>' : '') +
            '</div>' +
          '</div>' +
          '<div class="footer">' + esc(company) + ' · ' + esc(email) + ' · ' + esc(website) + '<br>Generado el ' + new Date().toLocaleDateString('es-AR') + '</div>' +
        '</div>' +
        '<div style="text-align:center;margin-top:20px"><button onclick="window.print()" style="background:' + accent + ';border:none;padding:10px 24px;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px">🖨 Imprimir / PDF</button></div>' +
        '</body></html>';

      var w = window.open('', '_blank', 'width=700,height=780');
      if (w) { w.document.write(html); w.document.close(); }
    } catch(err) {
      toast('Error al cargar recibo: ' + err.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TRIALS
  // ══════════════════════════════════════════════════════════════════════════
  async function loadTrials() {
    var tbody = document.getElementById('trials-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty">Cargando...</td></tr>';

    try {
      var res = await DB.from('clubs')
        .select('*')
        .eq('trial', true)
        .order('trial_ends', { ascending: true });

      var trials = res.data || [];
      if (!trials.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">No hay trials activos</td></tr>';
        return;
      }

      var today = new Date();
      tbody.innerHTML = trials.map(function(c){
        var ends   = c.trial_ends ? new Date(c.trial_ends) : null;
        var days   = ends ? Math.ceil((ends - today) / 86400000) : '—';
        var status = typeof days === 'number'
          ? (days < 0 ? '<span class="tag tag-red">Vencido</span>' :
             days <= 3 ? '<span class="tag tag-orange">⚠️ Por vencer</span>' :
             '<span class="tag tag-green">Activo</span>')
          : '—';

        return '<tr>' +
          '<td><strong style="color:var(--wht)">' + esc(c.name) + '</strong></td>' +
          '<td style="color:var(--mut)">' + fmtDate(c.created_at) + '</td>' +
          '<td style="color:var(--mut)">' + (c.trial_ends ? fmtDate(c.trial_ends) : '—') + '</td>' +
          '<td style="font-family:var(--cond);font-weight:700;color:' + (typeof days === 'number' && days < 0 ? 'var(--red)' : 'var(--cyan)') + '">' +
            (typeof days === 'number' ? (days < 0 ? 'Vencido' : days + ' días') : '—') +
          '</td>' +
          '<td>' + status + '</td>' +
          '<td><div class="tbl-actions">' +
            '<button class="btn btn-orange btn-sm" onclick="extendTrial(\'' + c.id + '\')">+14 días</button>' +
            '<button class="btn btn-green btn-sm" onclick="convertTrial(\'' + c.id + '\')">→ Convertir</button>' +
            '<button class="btn btn-red btn-sm" title="Eliminar período de prueba" onclick="deleteTrial(\'' + c.id + '\')" style="padding:3px 8px">🗑</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');

    } catch(err) {
      console.error('[AdminClient] loadTrials:', err);
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty">Error al cargar trials</td></tr>';
    }
  }

  async function saveTrial() {
    var clubId = val(document.getElementById('trial-club'));
    var days   = parseInt(val(document.getElementById('trial-days'))) || 14;
    var start  = val(document.getElementById('trial-start')) || new Date().toISOString().split('T')[0];

    if (!clubId) { toast('Seleccioná un club', 'error'); return; }

    var endDate = new Date(start);
    endDate.setDate(endDate.getDate() + days);

    // Módulos seleccionados
    var modChecks = document.querySelectorAll('#trial-modules input[type=checkbox]:checked');
    var trialMods = Array.from(modChecks).map(function(cb){ return cb.value; });

    try {
      // Actualizar club
      var cRes = await DB.from('clubs').update({
        trial:      true,
        trial_ends: endDate.toISOString().split('T')[0],
        plan:       'trial',
        active:     true,
      }).eq('id', clubId);
      if (cRes.error) throw cRes.error;

      // Activar módulos del trial
      for (var i = 0; i < trialMods.length; i++) {
        await DB.from('club_modules').upsert({
          club_id:    clubId,
          module:     trialMods[i],
          enabled:    true,
          enabled_at: new Date().toISOString(),
          enabled_by: (window._adminUser || {}).id,
        }, { onConflict: 'club_id,module' });
      }

      toast('Trial activado por ' + days + ' días ✓', 'success');
      closeModal('modal-trial');
      loadTrials();
      loadClubs();
      loadOverview();
    } catch(err) {
      toast('Error: ' + err.message, 'error');
    }
  }

  async function extendTrial(id) {
    var club = state.clubs.find(function(c){ return c.id === id; });
    var base = club && club.trial_ends ? new Date(club.trial_ends) : new Date();
    base.setDate(base.getDate() + 14);

    try {
      var res = await DB.from('clubs').update({ trial_ends: base.toISOString().split('T')[0] }).eq('id', id);
      if (res.error) throw res.error;
      toast('Trial extendido 14 días ✓', 'success');
      loadTrials();
    } catch(err) {
      toast('Error: ' + err.message, 'error');
    }
  }

  async function convertTrial(id) {
    var plan = prompt('¿A qué plan convertir?\n(basic / pro / enterprise)', 'basic');
    if (!plan) return;
    plan = plan.toLowerCase();
    if (!['basic','pro','enterprise'].includes(plan)) { toast('Plan no válido', 'error'); return; }

    var prices = { basic: 80, pro: 150, enterprise: 250 };
    try {
      var res = await DB.from('clubs').update({
        trial:      false,
        trial_ends: null,
        plan:       plan,
        plan_price: prices[plan] || 0,
        active:     true,
      }).eq('id', id);
      if (res.error) throw res.error;
      toast('Club convertido a plan ' + plan + ' ✓', 'success');
      loadTrials();
      loadClubs();
      loadOverview();
    } catch(err) {
      toast('Error: ' + err.message, 'error');
    }
  }

  async function deleteTrial(id) {
    var club = state.clubs.find(function(c){ return c.id === id; });
    var name = club ? club.name : 'este club';
    if (!confirm('¿Eliminar el período de prueba de ' + name + '?\nEl club quedará inactivo y sin trial.')) return;
    try {
      var res = await DB.from('clubs').update({
        trial:      false,
        trial_ends: null,
        plan:       'basic',
        active:     false,
      }).eq('id', id);
      if (res.error) throw res.error;
      toast('Trial eliminado — club desactivado', 'success');
      loadTrials();
      loadClubs();
      loadOverview();
    } catch(err) {
      toast('Error: ' + err.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ANALYTICS
  // ══════════════════════════════════════════════════════════════════════════
  async function loadAnalytics() {
    try {
      var now = new Date();
      var monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      var weekAgo    = new Date(now - 7*86400000).toISOString();

      // Logins este mes
      var loginRes = await DB.from('audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('action', 'login')
        .gte('created_at', monthStart);

      // Saves este mes
      var saveRes = await DB.from('audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('action', 'save_data')
        .gte('created_at', monthStart);

      // Clubes inactivos (sin actividad en 7 días)
      var recentClubsRes = await DB.from('audit_log')
        .select('club_id')
        .gte('created_at', weekAgo);

      var activeClubIds = new Set((recentClubsRes.data || []).map(function(l){ return l.club_id; }));
      var inactiveCount = state.clubs.filter(function(c){ return c.active && !activeClubIds.has(c.id); }).length;

      // Módulo más usado
      var modRes = await DB.from('club_modules')
        .select('module')
        .eq('enabled', true);

      var modCounts = {};
      (modRes.data || []).forEach(function(m){ modCounts[m.module] = (modCounts[m.module]||0) + 1; });
      var topMod = Object.keys(modCounts).sort(function(a,b){ return modCounts[b]-modCounts[a]; })[0] || '—';
      var topModLabel = MODULE_LABELS[topMod] ? MODULE_LABELS[topMod].icon + ' ' + MODULE_LABELS[topMod].label : topMod;

      setText('an-logins',   loginRes.count || 0);
      setText('an-saves',    saveRes.count  || 0);
      setText('an-inactive', inactiveCount);
      setText('an-top',      topModLabel);

      // Barras de uso por módulo
      var anMods = document.getElementById('analytics-modules');
      if (anMods) {
        var totalClubs = state.clubs.length || 1;
        anMods.innerHTML = MODULES.map(function(m){
          var cnt = modCounts[m] || 0;
          var pct = Math.round((cnt / totalClubs) * 100);
          var ml  = MODULE_LABELS[m];
          return '<div class="stat-bar-row">' +
            '<div class="stat-bar-label">' + ml.icon + ' ' + ml.label + '</div>' +
            '<div class="stat-bar-track"><div class="stat-bar-fill" style="width:' + pct + '%;background:var(--cyan)"></div></div>' +
            '<div class="stat-bar-val">' + cnt + '</div>' +
          '</div>';
        }).join('');
      }

      // Clubes más activos (por audit_log)
      var clubActivityRes = await DB.from('audit_log')
        .select('club_id, clubs(name)')
        .gte('created_at', monthStart)
        .not('club_id', 'is', null);

      var clubCounts = {};
      (clubActivityRes.data || []).forEach(function(l){
        var cname = l.clubs ? l.clubs.name : l.club_id;
        clubCounts[cname] = (clubCounts[cname]||0) + 1;
      });

      var anClubs = document.getElementById('analytics-clubs');
      if (anClubs) {
        var sorted = Object.keys(clubCounts).sort(function(a,b){ return clubCounts[b]-clubCounts[a]; }).slice(0,6);
        var maxAct = sorted.length ? clubCounts[sorted[0]] : 1;

        if (!sorted.length) {
          anClubs.innerHTML = '<div class="empty">Sin actividad registrada este mes</div>';
        } else {
          anClubs.innerHTML = sorted.map(function(name){
            var cnt = clubCounts[name];
            var pct = Math.round((cnt / maxAct) * 100);
            return '<div class="stat-bar-row">' +
              '<div class="stat-bar-label">' + esc(name) + '</div>' +
              '<div class="stat-bar-track"><div class="stat-bar-fill" style="width:' + pct + '%;background:var(--orange)"></div></div>' +
              '<div class="stat-bar-val">' + cnt + '</div>' +
            '</div>';
          }).join('');
        }
      }

    } catch(err) {
      console.error('[AdminClient] loadAnalytics:', err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MENSAJES
  // ══════════════════════════════════════════════════════════════════════════
  async function loadMessages() {
    try {
      // Cargar webhook guardado
      try {
        var _pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
        var whEl  = document.getElementById('msg-email-webhook');
        if (whEl && _pref.msgEmailWebhook) whEl.value = _pref.msgEmailWebhook;
      } catch(e) {}

      // Poblar destinatarios
      var msgTo = document.getElementById('msg-to');
      if (msgTo) {
        var opts = '<option value="all">📢 Todos los usuarios</option>';
        state.clubs.forEach(function(c){
          opts += '<option value="club_' + c.id + '">🏟 ' + esc(c.name) + '</option>';
        });
        state.users.filter(function(u){ return u.role !== 'admin'; }).forEach(function(u){
          opts += '<option value="user_' + u.id + '">👤 ' + esc(u.full_name || u.email) + '</option>';
        });
        msgTo.innerHTML = opts;
      }

      // Mensajes enviados
      var res = await DB.from('messages')
        .select('*, profiles!from_id(email, full_name), clubs!to_club_id(name)')
        .order('created_at', { ascending: false })
        .limit(20);

      var msgs = res.data || [];
      var el   = document.getElementById('messages-list');
      if (!el) return;

      if (!msgs.length) {
        el.innerHTML = '<div class="empty"><div class="empty-icon">📭</div>Sin mensajes enviados</div>';
        return;
      }

      var typeIcons  = { announcement:'📣', warning:'⚠️', system:'🔧', invoice:'💰' };
      var typeColors = { announcement:'tag-cyan', warning:'tag-orange', system:'tag-purple', invoice:'tag-green' };
      var typeLabels = { announcement:'Anuncio', warning:'Aviso', system:'Sistema', invoice:'Factura' };
      el.innerHTML = msgs.map(function(m){
        var to   = m.clubs ? ('🏟 ' + esc(m.clubs.name)) : (m.to_user_id ? '👤 Usuario específico' : '📢 Broadcast — todos');
        var icon = typeIcons[m.type]  || '📣';
        var tCol = typeColors[m.type] || 'tag-cyan';
        var tLbl = typeLabels[m.type] || m.type;
        var subj = m.subject || '(Sin asunto)';
        var isBc = (!m.to_club_id && !m.to_user_id);
        return '<div style="background:var(--bg3);border:1px solid var(--brd);border-radius:10px;padding:14px 16px;margin-bottom:10px;transition:border-color .15s" onmouseover="this.style.borderColor=\'var(--brd2)\'" onmouseout="this.style.borderColor=\'var(--brd)\'">' +
          '<div style="display:flex;align-items:flex-start;gap:10px">' +
            '<div style="font-size:20px;flex-shrink:0;margin-top:2px">' + icon + '</div>' +
            '<div style="flex:1;min-width:0">' +
              '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px">' +
                '<div>' +
                  '<span style="font-family:var(--cond);font-weight:700;color:var(--wht);font-size:13px">' + esc(subj) + '</span>' +
                  '<span class="tag ' + tCol + '" style="margin-left:8px;font-size:8px;vertical-align:middle">' + tLbl + '</span>' +
                  (isBc ? '<span class="tag tag-orange" style="margin-left:4px;font-size:8px;vertical-align:middle">BROADCAST</span>' : '') +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">' +
                  '<span style="font-size:10px;color:var(--mut);white-space:nowrap">' + timeAgo(m.created_at) + '</span>' +
                  '<button class="btn btn-red btn-sm" style="padding:3px 8px" onclick="deleteMessage(\'' + m.id + '\')" title="Eliminar mensaje">🗑</button>' +
                '</div>' +
              '</div>' +
              '<div style="font-size:11px;color:var(--cyan);margin-bottom:8px;display:flex;align-items:center;gap:4px">→ ' + to + '</div>' +
              '<div style="font-size:11px;color:var(--txt);line-height:1.6;padding:10px 12px;background:var(--bg2);border-radius:6px;border-left:2px solid var(--brd2)">' + esc(m.body || '').slice(0, 200) + (m.body && m.body.length > 200 ? '…' : '') + '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');

    } catch(err) {
      console.error('[AdminClient] loadMessages:', err);
    }
  }

  async function sendMessage() {
    var toVal   = val(document.getElementById('msg-to'));
    var type    = val(document.getElementById('msg-type'));
    var subject = trim(document.getElementById('msg-subject'));
    var body    = trim(document.getElementById('msg-body'));

    if (!body) { toast('Escribí el mensaje antes de enviar', 'error'); return; }

    var toClubId  = null;
    var toUserId  = null;
    var isBroadcast = (!toVal || toVal === 'all');

    if (!isBroadcast) {
      if (toVal.startsWith('club_')) toClubId = toVal.replace('club_', '');
      if (toVal.startsWith('user_')) toUserId = toVal.replace('user_', '');
    }

    // Si es broadcast (todos), necesitamos al menos un destino para pasar el
    // constraint de la DB. Usamos to_user_id del propio admin como "desde".
    // Si el constraint fue eliminado, esto igualmente funciona bien.
    if (isBroadcast) {
      toUserId = (window._adminUser || {}).id || null;
    }

    try {
      var broadcastSubject = isBroadcast
        ? '[BROADCAST] ' + (subject || 'Mensaje a todos los usuarios')
        : (subject || null);

      var res = await DB.from('messages').insert({
        from_id:    (window._adminUser || {}).id,
        to_club_id: toClubId,
        to_user_id: isBroadcast ? null : toUserId,  // broadcast → sin usuario específico
        subject:    broadcastSubject,
        body:       body,
        type:       type || 'announcement',
        read:       false,
      });
      if (res.error) throw res.error;

      toast(isBroadcast ? '📢 Broadcast enviado a todos ✓' : 'Mensaje enviado ✓', 'success');
      document.getElementById('msg-subject').value = '';
      document.getElementById('msg-body').value    = '';
      loadMessages();

      // ── Notificación por email (si hay webhook configurado) ─────────────
      _sendEmailNotification({
        toClubId:  toClubId,
        toUserId:  isBroadcast ? null : toUserId,
        subject:   broadcastSubject || subject,
        body:      body,
        type:      type || 'announcement',
        broadcast: isBroadcast,
      });
    } catch(err) {
      toast('Error al enviar: ' + err.message, 'error');
    }
  }

  async function deleteMessage(id) {
    try {
      var res = await DB.from('messages').delete().eq('id', id);
      if (res.error) throw res.error;
      toast('Mensaje eliminado ✓', 'success');
      loadMessages();
    } catch(e) {
      toast('Error al eliminar: ' + e.message, 'error');
    }
  }

  // ── Email notification helper ───────────────────────────────────────────
  // Sends an email notification via a configurable webhook URL.
  // If no webhook URL is saved in prefs (msg-email-webhook), skips silently.
  // The webhook receives a POST with JSON: { to, subject, body, clubLogo, appUrl }
  // Compatible with Make.com, Zapier, n8n, or any custom endpoint.
  async function _sendEmailNotification(opts) {
    try {
      var pref       = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      var webhookUrl = (pref.msgEmailWebhook || '').trim();
      if (!webhookUrl) return; // no webhook configurado → skip

      var toEmail = null;
      var clubLogo = '';

      // Buscar email del destinatario
      if (opts.toUserId) {
        var uRes = await DB.from('profiles').select('email').eq('id', opts.toUserId).single();
        if (uRes.data) toEmail = uRes.data.email;
      } else if (opts.toClubId) {
        // Buscar todos los usuarios del club
        var mRes = await DB.from('club_members')
          .select('profiles(email)')
          .eq('club_id', opts.toClubId);
        if (mRes.data && mRes.data.length) {
          toEmail = mRes.data.map(function(m){ return (m.profiles || {}).email; }).filter(Boolean).join(',');
        }
        // Obtener logo del club para el email
        var clRes = await DB.from('clubs').select('logo_b64').eq('id', opts.toClubId).single();
        if (clRes.data && clRes.data.logo_b64) clubLogo = clRes.data.logo_b64;
      }
      // Para broadcast, mandar al webhook sin email específico
      // (el webhook puede consultar su propia lista de suscriptores)

      var payload = {
        to:         toEmail || null,
        subject:    opts.subject || 'Nuevo mensaje — Líbero Táctico',
        body:       opts.body || '',
        type:       opts.type || 'announcement',
        broadcast:  opts.broadcast || false,
        clubLogo:   clubLogo,
        appUrl:     window.location.origin + '/login.html',
        sentAt:     new Date().toISOString(),
      };

      var resp = await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      if (resp.ok) {
        console.log('[LT] Email notification sent via webhook ✓');
      } else {
        console.warn('[LT] Webhook respondió con status:', resp.status);
      }
    } catch(e) {
      console.warn('[LT] Error enviando notificación email:', e.message);
      // No mostrar error al usuario — el mensaje principal ya se envió
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COTIZADOR
  // ══════════════════════════════════════════════════════════════════════════
  var _cotState = {};
  var _cotLogo        = null; // base64 logo para el PDF
  var _cotAccentColor = null; // color acento override para esta propuesta

  // ── Helpers logo/color cotizador ──────────────────────────────────────────
  function handleCotLogoUpload(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 2097152) { toast('Logo debe ser menor a 2 MB', 'error'); return; }
    var reader = new FileReader();
    reader.onload = function(e) {
      _cotLogo = e.target.result;
      var wrap = document.getElementById('cot-logo-preview-wrap');
      var ph   = document.getElementById('cot-logo-placeholder');
      var prev = document.getElementById('cot-logo-preview');
      var clr  = document.getElementById('cot-logo-clear');
      if (wrap) wrap.style.display = 'flex';
      if (ph)   ph.style.display   = 'none';
      if (prev) prev.src = _cotLogo;
      if (clr)  clr.style.display  = 'inline-block';
      // Update mini preview
      var prevLogo = document.getElementById('prev-logo');
      if (prevLogo) { prevLogo.src = _cotLogo; prevLogo.style.display = 'block'; }
      toast('Logo cargado ✓', 'success');
    };
    reader.readAsDataURL(file);
  }

  function clearCotLogo() {
    _cotLogo = null;
    var wrap = document.getElementById('cot-logo-preview-wrap');
    var ph   = document.getElementById('cot-logo-placeholder');
    var clr  = document.getElementById('cot-logo-clear');
    var fi   = document.getElementById('cot-logo-file');
    var prevLogo = document.getElementById('prev-logo');
    if (wrap) wrap.style.display = 'none';
    if (ph)   ph.style.display   = 'block';
    if (clr)  clr.style.display  = 'none';
    if (fi)   fi.value = '';
    if (prevLogo) prevLogo.style.display = 'none';
  }

  function updateCotAccent(color) {
    _cotAccentColor = color;
    var pick   = document.getElementById('cot-accent-pick');
    var hex    = document.getElementById('cot-accent-hex');
    var swatch = document.getElementById('cot-accent-swatch');
    var prevHd = document.getElementById('prev-header-text');
    if (/^#[0-9a-fA-F]{6}$/.test(color)) {
      if (pick)   pick.value = color;
      if (swatch) swatch.style.background = color;
      if (prevHd) prevHd.style.color = color;
    }
    if (hex && hex !== document.activeElement) hex.value = color;
  }

  function calcCotizador() {
    var seats    = val(document.getElementById('cot-seats'))    || '5';
    var currency = val(document.getElementById('cot-currency')) || 'USD';
    var desc     = parseFloat((document.getElementById('cot-desc') || {}).value) || 0;
    var period   = val(document.getElementById('cot-period'))   || '1';
    var club     = trim(document.getElementById('cot-club'))    || '—';

    var curData  = CURRENCIES[currency] || CURRENCIES['USD'];
    var rate     = curData.rate;
    var sym      = curData.symbol;

    // Módulos seleccionados
    var modNames = { m1:'📊 Rendimiento', m2:'🔍 Análisis Rival', m3:'👁 Scouting', m4:'📋 Evaluación', m5:'📈 Data & Visualización', m6:'💡 Recomendaciones CT' };
    var modPrices = { m1:20, m2:20, m3:25, m4:15, m5:15, m6:25 };
    var selectedMods = [];
    var baseUSD = 0;

    var pdDisc     = COT_PERIOD_DISC[period] || 0;
    var manualDisc = Math.min(Math.max(desc, 0), 80) / 100;
    var monthlyLocal, subtotalLocal, periodLocal, monthlyUSD, subtotalUSD;

    if (_cotSelectedPlan && _cotSelectedPlan.prices) {
      // ── Modo plan configurado ─────────────────────────────────────────────
      var planPriceLocal = (_cotSelectedPlan.prices[currency] || 0);
      // Add a synthetic "module" entry for the plan
      selectedMods = [_cotSelectedPlan.id || 'plan'];
      modNames[_cotSelectedPlan.id || 'plan'] = '📦 ' + (_cotSelectedPlan.name || 'Plan');
      baseUSD = planPriceLocal / rate;  // approximate USD equiv
      subtotalLocal = planPriceLocal;
      monthlyLocal  = planPriceLocal * (1 - manualDisc) * (1 - pdDisc);
      monthlyUSD    = monthlyLocal / rate;
      subtotalUSD   = baseUSD;
      periodLocal   = monthlyLocal * parseInt(period);
      // Also expose plan features in modNames for preview
      (_cotSelectedPlan.features || []).forEach(function(f, fi){
        modNames['plan_feat_' + fi] = '  · ' + f;
      });
    } else {
      // ── Modo personalizado: módulos sueltos ───────────────────────────────
      for (var k in modPrices) {
        var chk = document.getElementById('cot-' + k);
        if (chk && chk.checked) {
          baseUSD += modPrices[k];
          selectedMods.push(k);
        }
      }
      var mult      = COT_SEAT_MULT[seats] || 1;
      monthlyUSD    = baseUSD * mult * (1 - manualDisc) * (1 - pdDisc);
      monthlyLocal  = monthlyUSD * rate;
      periodLocal   = monthlyLocal * parseInt(period);
      subtotalUSD   = baseUSD * mult;
      subtotalLocal = subtotalUSD * rate;
    }

    // Función helper de formato
    function fmtLocal(n) { return sym + Math.round(n).toLocaleString('es-AR'); }

    // ── IVA ──────────────────────────────────────────────────────────────────
    var ivaType = val(document.getElementById('cot-iva-type')) || 'normal';
    var ivaPct  = 0;
    if (ivaType === 'boleta' || ivaType === 'factura') {
      ivaPct = 19;
    } else if (ivaType === 'custom') {
      ivaPct = parseFloat((document.getElementById('cot-iva-pct') || {}).value) || 0;
    }
    var ivaAmount   = monthlyLocal * ivaPct / 100;
    var totalConIVA = monthlyLocal + ivaAmount;

    // IVA info line
    var ivaInfoEl = document.getElementById('cot-iva-info');
    if (ivaInfoEl) {
      if (ivaPct > 0) {
        ivaInfoEl.textContent = '+ IVA ' + ivaPct + '%: ' + fmtLocal(ivaAmount) + ' → Total con IVA: ' + fmtLocal(totalConIVA);
        ivaInfoEl.style.display = 'block';
      } else {
        ivaInfoEl.style.display = 'none';
      }
    }

    // ── Override manual ───────────────────────────────────────────────────────
    var overrideVal = parseFloat((document.getElementById('cot-override') || {}).value) || 0;
    var displayTotal = overrideVal > 0 ? overrideVal : totalConIVA;

    // Actualizar total principal
    setText('cot-total', fmtLocal(displayTotal));
    setText('cot-total-sub', currency + ' / mes' + (ivaPct > 0 ? ' (c/IVA ' + ivaPct + '%)' : '') + (overrideVal > 0 ? ' ✏' : ''));

    var periodText = '';
    if (parseInt(period) > 1) {
      periodText = 'Total ' + COT_PERIOD_LABELS[period] + ': ' + fmtLocal(periodLocal) + ' ' + currency;
    }
    setText('cot-total-period', periodText);

    // Guardar estado para preview y export
    _cotState = {
      club: club, seats: seats, currency: currency, curData: curData,
      sym: sym, rate: rate, desc: desc, pdDisc: pdDisc, period: period,
      selectedMods: selectedMods, modNames: modNames, modPrices: modPrices,
      baseUSD: baseUSD, monthlyUSD: monthlyUSD, monthlyLocal: monthlyLocal,
      periodLocal: periodLocal, subtotalLocal: subtotalLocal, subtotalUSD: subtotalUSD,
      ivaType: ivaType, ivaPct: ivaPct, ivaAmount: ivaAmount,
      totalConIVA: totalConIVA, displayTotal: displayTotal,
      fmtLocal: fmtLocal,
    };

    // ── Actualizar vista previa en panel ──────────────────────────────────────
    // Logo y color de acento en preview
    var prevLogoEl = document.getElementById('prev-logo');
    if (prevLogoEl) { prevLogoEl.src = _cotLogo || ''; prevLogoEl.style.display = _cotLogo ? 'block' : 'none'; }
    var accent = _cotAccentColor || '#39e870';
    var prevHeader = document.getElementById('cot-preview');
    if (prevHeader) prevHeader.style.setProperty('--local-accent', accent);
    var prevHeadTitle = document.getElementById('prev-header-text');
    if (prevHeadTitle) prevHeadTitle.style.color = accent;
    var prevClub = document.getElementById('prev-club-name');
    if (prevClub) prevClub.textContent = club;

    var prevMods = document.getElementById('prev-modules-list');
    if (prevMods) {
      if (_cotSelectedPlan) {
        var planPreviewPrice = (_cotSelectedPlan.prices || {})[currency] || monthlyLocal;
        prevMods.innerHTML =
          (_cotSelectedPlan.imageData
            ? '<img src="' + _cotSelectedPlan.imageData + '" style="width:100%;max-height:60px;object-fit:cover;border-radius:6px;margin-bottom:6px">'
            : '') +
          '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:11px;color:var(--txt)">' +
            '<span style="font-weight:700;color:var(--green)">📦 ' + esc(_cotSelectedPlan.name) + '</span>' +
            '<span style="color:var(--mut)">' + fmtLocal(planPreviewPrice) + '/mes</span>' +
          '</div>' +
          (_cotSelectedPlan.features || []).map(function(f){
            return '<div style="font-size:10px;color:var(--mut);padding:1px 0">· ' + esc(f) + '</div>';
          }).join('');
      } else {
        prevMods.innerHTML = selectedMods.length
          ? selectedMods.map(function(k){
              var price = modPrices[k] * rate;
              return '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:11px;color:var(--txt)">' +
                '<span>' + modNames[k] + '</span>' +
                '<span style="color:var(--mut)">' + fmtLocal(price) + '/mes</span>' +
              '</div>';
            }).join('')
          : '<div style="font-size:11px;color:var(--mut)">Ningún módulo seleccionado</div>';
      }
    }

    setText('prev-subtotal', fmtLocal(subtotalLocal));
    setText('prev-total', fmtLocal(displayTotal));

    var discountRow = document.getElementById('prev-discount-row');
    if (discountRow) {
      var totalDiscPct = (manualDisc + pdDisc - manualDisc * pdDisc) * 100;
      if (totalDiscPct > 0 && discountRow) {
        discountRow.style.display = 'flex';
        setText('prev-discount-label', 'Descuento (' + totalDiscPct.toFixed(0) + '%)');
        setText('prev-discount-val', '-' + fmtLocal(subtotalLocal - monthlyLocal));
      } else {
        discountRow.style.display = 'none';
      }
    }

    var prevPeriod = document.getElementById('prev-period-total');
    if (prevPeriod) {
      prevPeriod.textContent = parseInt(period) > 1 ? ('Total ' + COT_PERIOD_LABELS[period] + ': ' + fmtLocal(periodLocal)) : '';
    }
  }

  function _buildCotizadorHTML() {
    calcCotizador(); // asegura _cotState actualizado
    var s = _cotState;
    if (!s || !s.club) return '<p>Configurá la propuesta primero.</p>';

    var pref = JSON.parse(localStorage.getItem('lt-admin-prefs') || '{}');
    var _cfgT = (_cotConfig && _cotConfig.texts)   || {};
    var _cfgC = (_cotConfig && _cotConfig.contact) || {};
    // Campos rápidos del cotizador (override inline)
    var quickCompany = trim(document.getElementById('cot-company-quick'));
    var quickHeader  = trim(document.getElementById('cot-header-quick'));
    var companyName  = quickCompany  || _cfgT.company    || pref.company    || 'Líbero Táctico';
    var supportEmail = _cfgC.email   || pref.email       || 'hola@liberotactico.com';
    var website      = _cfgC.website || pref.website     || 'www.liberotactico.com';
    var pdfHeader    = quickHeader   || _cfgT.pdfHeader  || pref.pdfHeader  || 'PROPUESTA COMERCIAL';
    var pdfFooter    = _cfgT.pdfFooter  || pref.pdfFooter  || 'Información confidencial — Líbero Táctico · Válida por 15 días';
    var guarantee    = _cfgT.guarantee  || pref.guarantee  || 'Soporte técnico dedicado, actualizaciones continuas y acceso inmediato desde el primer día.';
    var accent       = _cotAccentColor || pref.accent || '#39e870';
    // Logo: primero el subido en el cotizador, luego logo.png del panel como fallback
    var logoSrcBuild = _cotLogo || 'logo.png';
    var logoTag      = '<img src="' + logoSrcBuild + '" style="height:52px;max-width:180px;object-fit:contain;display:block;margin-bottom:12px" onerror="this.style.display=\'none\'">';

    var dateStr = new Date().toLocaleDateString('es-AR', { day:'2-digit', month:'long', year:'numeric' });
    var periodLabel = COT_PERIOD_LABELS[s.period] || 'mensual';
    var totalDiscAmt = s.subtotalLocal - s.monthlyLocal;
    var totalDiscPct = s.subtotalLocal > 0 ? ((totalDiscAmt / s.subtotalLocal) * 100).toFixed(0) : 0;

    var modsRows;
    if (_cotSelectedPlan) {
      // Plan seleccionado: mostrar nombre del plan + features como filas
      var planPrice = (_cotSelectedPlan.prices || {})[s.currency] || s.monthlyLocal;
      modsRows = '<tr>' +
        '<td style="padding:12px 16px;border-bottom:1px solid #e8eaf0;color:#1a1d2e;font-weight:700">' +
          (_cotSelectedPlan.imageData ? '<img src="' + _cotSelectedPlan.imageData + '" style="height:32px;border-radius:4px;margin-right:8px;vertical-align:middle">' : '') +
          esc(_cotSelectedPlan.name || 'Plan') +
          (_cotSelectedPlan.badge ? ' <span style="background:#ff9c2a;color:#000;border-radius:3px;padding:1px 5px;font-size:10px;margin-left:4px">' + esc(_cotSelectedPlan.badge) + '</span>' : '') +
        '</td>' +
        '<td style="padding:12px 16px;border-bottom:1px solid #e8eaf0;color:#5a6080;font-size:12px">' +
          esc(_cotSelectedPlan.description || '') +
          ((_cotSelectedPlan.features || []).length
            ? '<ul style="margin:6px 0 0 16px;padding:0">' + (_cotSelectedPlan.features || []).map(function(f){ return '<li style="font-size:11px;color:#5a6080;margin-bottom:2px">' + esc(f) + '</li>'; }).join('') + '</ul>'
            : '') +
        '</td>' +
        '<td style="padding:12px 16px;border-bottom:1px solid #e8eaf0;font-weight:700;color:#1a1d2e;text-align:right">' + s.fmtLocal(planPrice) + '/mes</td>' +
      '</tr>';
    } else {
      modsRows = s.selectedMods.length
        ? s.selectedMods.map(function(k){
            var price = s.modPrices[k] * s.rate;
            return '<tr>' +
              '<td style="padding:10px 16px;border-bottom:1px solid #e8eaf0;color:#1a1d2e">' + s.modNames[k].replace(/^[\S]+ /,'') + '</td>' +
              '<td style="padding:10px 16px;border-bottom:1px solid #e8eaf0;color:#5a6080;font-size:12px">Análisis y visualización en tiempo real</td>' +
              '<td style="padding:10px 16px;border-bottom:1px solid #e8eaf0;font-weight:700;color:#1a1d2e;text-align:right">' + s.fmtLocal(price) + '/mes</td>' +
            '</tr>';
          }).join('')
        : '<tr><td colspan="3" style="padding:16px;color:#9aa0c0;text-align:center">Ningún módulo seleccionado</td></tr>';
    }

    return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">' +
      '<title>Propuesta — ' + esc(s.club) + ' — ' + esc(companyName) + '</title>' +
      '<style>' +
        '@import url(\'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:wght@300;400;500;600;700&family=Barlow+Condensed:wght@500;600;700&display=swap\');' +
        '*{box-sizing:border-box;margin:0;padding:0}' +
        'body{font-family:Barlow,Arial,sans-serif;background:#fff;color:#1a1d2e;print-color-adjust:exact;-webkit-print-color-adjust:exact}' +

        /* PORTADA */
        '.cover{background:#08090d;min-height:100vh;display:flex;flex-direction:column;padding:60px;position:relative;overflow:hidden}' +
        '.cover::before{content:"";position:absolute;top:-80px;right:-80px;width:400px;height:400px;border-radius:50%;background:radial-gradient(circle,' + accent + '18,transparent 70%)}' +
        '.cover::after{content:"";position:absolute;bottom:-60px;left:-60px;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,' + accent + '10,transparent 70%)}' +
        '.cover-logo{font-family:"Bebas Neue",sans-serif;font-size:13px;letter-spacing:4px;color:' + accent + ';margin-bottom:auto;text-transform:uppercase}' +
        '.cover-tag{display:inline-block;background:' + accent + '22;border:1px solid ' + accent + '44;color:' + accent + ';font-family:"Barlow Condensed",sans-serif;font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;padding:6px 14px;border-radius:20px;margin-bottom:20px}' +
        '.cover-title{font-family:"Bebas Neue",sans-serif;font-size:64px;line-height:1.05;color:#fff;margin-bottom:10px}' +
        '.cover-club{font-family:"Barlow Condensed",sans-serif;font-size:28px;font-weight:700;color:' + accent + ';margin-bottom:6px}' +
        '.cover-date{font-size:12px;color:#5a6080;margin-bottom:40px}' +
        '.cover-total-box{border:1px solid ' + accent + '33;border-radius:16px;padding:28px 36px;background:rgba(255,255,255,.04);display:inline-block;margin-bottom:40px}' +
        '.cover-total-label{font-family:"Barlow Condensed",sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5a6080;margin-bottom:6px}' +
        '.cover-total-num{font-family:"Bebas Neue",sans-serif;font-size:72px;line-height:1;color:' + accent + ';margin-bottom:4px}' +
        '.cover-total-sub{font-size:12px;color:#5a6080}' +
        '.cover-footer{display:flex;justify-content:space-between;align-items:center;padding-top:24px;border-top:1px solid rgba(255,255,255,.08);font-family:"Barlow Condensed",sans-serif;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#3a3d50}' +

        /* PÁGINAS */
        '.page{padding:52px 60px;page-break-before:always}' +
        '.page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:40px;padding-bottom:16px;border-bottom:2px solid #f0f1f7}' +
        '.page-logo{font-family:"Bebas Neue",sans-serif;font-size:14px;letter-spacing:3px;color:#1a1d2e}' +
        '.page-logo span{color:' + accent + '}' +
        '.section-tag{font-family:"Barlow Condensed",sans-serif;font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:' + accent + ';margin-bottom:6px}' +
        '.section-title{font-family:"Bebas Neue",sans-serif;font-size:36px;color:#1a1d2e;margin-bottom:24px}' +
        '.table{width:100%;border-collapse:collapse;margin-bottom:24px}' +
        '.table th{background:#f7f8fc;font-family:"Barlow Condensed",sans-serif;font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9aa0c0;padding:10px 16px;text-align:left}' +
        '.inv-row{background:' + accent + '08;border-left:3px solid ' + accent + '}' +
        '.total-row{background:#f7f8fc}' +
        '.total-row td{font-family:"Bebas Neue",sans-serif;font-size:22px;color:' + accent + ';padding:14px 16px}' +
        '.summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px}' +
        '.sum-card{background:#f7f8fc;border-radius:12px;padding:20px}' +
        '.sum-card-label{font-family:"Barlow Condensed",sans-serif;font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9aa0c0;margin-bottom:4px}' +
        '.sum-card-val{font-family:"Bebas Neue",sans-serif;font-size:28px;color:#1a1d2e}' +
        '.sum-card-val.accent{color:' + accent + '}' +
        '.guarantee-box{background:#f7f8fc;border-left:3px solid ' + accent + ';border-radius:0 12px 12px 0;padding:20px;margin-bottom:28px}' +
        '.guarantee-title{font-family:"Barlow Condensed",sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:' + accent + ';margin-bottom:6px}' +
        '.guarantee-text{font-size:12px;color:#5a6080;line-height:1.7}' +
        '.benefit-list{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}' +
        '.benefit-item{display:flex;align-items:center;gap:8px;font-size:12px;color:#1a1d2e}' +
        '.benefit-dot{width:8px;height:8px;border-radius:50%;background:' + accent + ';flex-shrink:0}' +
        '.page-footer{margin-top:40px;padding-top:16px;border-top:1px solid #f0f1f7;display:flex;justify-content:space-between;font-size:10px;color:#9aa0c0;font-family:"Barlow Condensed",sans-serif;letter-spacing:.5px}' +
        '@media print{.page{page-break-before:always}.cover{page-break-after:always}}' +
      '</style></head><body>' +

      /* ── PORTADA ── */
      '<div class="cover">' +
        '<div class="cover-logo">' + logoTag + '<span>' + esc(companyName) + '</span></div>' +
        '<div>' +
          '<div class="cover-tag">' + pdfHeader + '</div>' +
          '<div class="cover-title">Propuesta<br>Comercial</div>' +
          '<div class="cover-club">Para: ' + esc(s.club) + '</div>' +
          '<div class="cover-date">Fecha: ' + dateStr + '</div>' +
          '<div class="cover-total-box">' +
            '<div class="cover-total-label">Inversión mensual</div>' +
            '<div class="cover-total-num">' + s.fmtLocal(s.monthlyLocal) + '</div>' +
            '<div class="cover-total-sub">' + s.currency + ' · Período ' + periodLabel + ' · ' + s.seats + ' usuarios</div>' +
          '</div>' +
        '</div>' +
        '<div class="cover-footer">' +
          '<span>' + esc(companyName) + '</span>' +
          '<span>' + esc(supportEmail) + '</span>' +
          '<span>' + esc(website) + '</span>' +
        '</div>' +
      '</div>' +

      /* ── PÁG 2: MÓDULOS ── */
      '<div class="page">' +
        '<div class="page-header"><div class="page-logo"><img src="' + logoSrcBuild + '" style="height:22px;object-fit:contain;margin-right:8px;vertical-align:middle" onerror="this.style.display=\'none\'"><span>LÍBERO <span style="color:' + accent + '">TÁCTICO</span></span></div><div style="font-size:11px;color:#9aa0c0">Propuesta para ' + esc(s.club) + '</div></div>' +
        '<div class="section-tag">Módulos contratados</div>' +
        '<div class="section-title">Solución a medida</div>' +
        '<table class="table">' +
          '<thead><tr><th>Módulo</th><th>Descripción</th><th style="text-align:right">Precio/mes</th></tr></thead>' +
          '<tbody>' + modsRows + '</tbody>' +
        '</table>' +
        '<table class="table">' +
          '<tbody>' +
            '<tr class="inv-row"><td style="padding:10px 16px;font-family:\'Barlow Condensed\',sans-serif;font-size:11px;font-weight:600;letter-spacing:1px;color:#1a1d2e;text-transform:uppercase">Subtotal base</td>' +
              '<td style="padding:10px 16px;color:#9aa0c0;font-size:12px">×' + s.seats + ' usuarios (' + COT_SEAT_MULT[s.seats] + 'x)</td>' +
              '<td style="padding:10px 16px;font-weight:700;text-align:right">' + s.fmtLocal(s.subtotalLocal) + '</td></tr>' +
            (totalDiscPct > 0
              ? '<tr><td style="padding:8px 16px;font-size:12px;color:#9aa0c0">Descuento total aplicado</td><td></td>' +
                '<td style="padding:8px 16px;text-align:right;color:#ff9c2a;font-weight:600">−' + s.fmtLocal(totalDiscAmt) + ' (' + totalDiscPct + '%)</td></tr>'
              : '') +
            '<tr class="total-row"><td style="padding:14px 16px">TOTAL MENSUAL</td><td></td><td style="padding:14px 16px;font-family:\'Bebas Neue\',sans-serif;font-size:22px;color:' + accent + ';text-align:right">' + s.fmtLocal(s.monthlyLocal) + '</td></tr>' +
            (parseInt(s.period) > 1
              ? '<tr><td style="padding:8px 16px;font-size:12px;color:#9aa0c0">Total ' + periodLabel + ' (' + s.period + ' meses)</td><td></td>' +
                '<td style="padding:8px 16px;font-weight:700;color:#1a1d2e;text-align:right">' + s.fmtLocal(s.periodLocal) + '</td></tr>'
              : '') +
          '</tbody>' +
        '</table>' +
        '<div class="page-footer"><span>' + esc(companyName) + '</span><span>' + pdfFooter + '</span><span>2 / 3</span></div>' +
      '</div>' +

      /* ── PÁG 3: RESUMEN Y GARANTÍA ── */
      '<div class="page">' +
        '<div class="page-header"><div class="page-logo"><img src="' + logoSrcBuild + '" style="height:22px;object-fit:contain;margin-right:8px;vertical-align:middle" onerror="this.style.display=\'none\'"><span>LÍBERO <span style="color:' + accent + '">TÁCTICO</span></span></div><div style="font-size:11px;color:#9aa0c0">Propuesta para ' + esc(s.club) + '</div></div>' +
        '<div class="section-tag">Resumen de inversión</div>' +
        '<div class="section-title">Condiciones comerciales</div>' +
        '<div class="summary-grid">' +
          '<div class="sum-card"><div class="sum-card-label">Club</div><div class="sum-card-val">' + esc(s.club) + '</div></div>' +
          '<div class="sum-card"><div class="sum-card-label">Módulos</div><div class="sum-card-val">' + s.selectedMods.length + '</div></div>' +
          '<div class="sum-card"><div class="sum-card-label">Usuarios</div><div class="sum-card-val">' + s.seats + '</div></div>' +
          '<div class="sum-card"><div class="sum-card-label">Total mensual</div><div class="sum-card-val accent">' + s.fmtLocal(s.monthlyLocal) + '</div></div>' +
        '</div>' +
        '<div class="guarantee-box">' +
          '<div class="guarantee-title">Compromiso Líbero Táctico</div>' +
          '<div class="guarantee-text">' + esc(guarantee) + '</div>' +
        '</div>' +
        '<div class="section-tag" style="margin-bottom:8px">Incluido en todos los planes</div>' +
        '<div class="benefit-list">' +
          ['Plataforma web responsive', 'Soporte técnico prioritario', 'Actualizaciones incluidas', 'Onboarding personalizado',
           'Backup automático de datos', 'Exportación de reportes', 'Capacitación del equipo', 'Dashboard en tiempo real'].map(function(b){
            return '<div class="benefit-item"><div class="benefit-dot"></div>' + esc(b) + '</div>';
          }).join('') +
        '</div>' +
        '<div class="page-footer"><span>' + esc(companyName) + ' · ' + esc(supportEmail) + '</span><span>' + pdfFooter + '</span><span>3 / 3</span></div>' +
      '</div>' +

    '</body></html>';
  }

  function previewCotizador() {
    calcCotizador();
    var pref = {};
    try { pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch(e){}
    var accent  = _cotAccentColor || pref.accent || '#39e870';
    var logoSrc = _cotLogo || 'logo.png';

    // Build the full proposal HTML (dark themed, all CSS in <head>)
    var baseHtml = _buildCotizadorHTML();

    // ── TOOLBAR CSS: injected into the proposal's <head> so it sits atop the dark design ──
    var toolbarCss =
      '<style id="lt-toolbar-css">' +
      'body{padding-top:52px !important}' +
      '#lt-toolbar{position:fixed;top:0;left:0;right:0;z-index:9999;background:#0d0f1a;border-bottom:2px solid ' + accent + ';display:flex;align-items:center;gap:3px;padding:4px 10px;overflow-x:auto;overflow-y:hidden;box-shadow:0 4px 24px rgba(0,0,0,.8)}' +
      '#lt-toolbar::-webkit-scrollbar{height:3px}' +
      '#lt-toolbar::-webkit-scrollbar-thumb{background:' + accent + '66;border-radius:2px}' +
      '#lt-toolbar button,#lt-toolbar select{background:#161827;color:#b0b4d8;border:1px solid #252840;border-radius:5px;padding:4px 9px;cursor:pointer;font-size:12px;font-family:Barlow,system-ui,sans-serif;transition:all .13s;white-space:nowrap;flex-shrink:0}' +
      '#lt-toolbar button:hover{background:#252840;color:#e0e2f0}' +
      '#lt-toolbar button.active{background:' + accent + '28;border-color:' + accent + ';color:' + accent + ';font-weight:700}' +
      '#lt-toolbar .sep{width:1px;height:20px;background:#252840;margin:0 4px;flex-shrink:0}' +
      '#lt-toolbar label{font-size:10px;color:#555880;margin-right:2px;white-space:nowrap;user-select:none;flex-shrink:0}' +
      '#lt-toolbar input[type=color]{padding:2px;width:26px;height:26px;border-radius:4px;cursor:pointer;border:1px solid #252840;background:#161827;flex-shrink:0}' +
      '#lt-toolbar select{max-width:75px;padding:4px 5px}' +
      '.lt-editable{outline:none;cursor:text;border-radius:2px;transition:box-shadow .12s}' +
      '.lt-editable:hover{box-shadow:0 0 0 1px ' + accent + '55}' +
      '.lt-editable:focus{box-shadow:0 0 0 2px ' + accent + '88;outline:none}' +
      '@media print{#lt-toolbar{display:none !important}body{padding-top:0 !important}.lt-editable{box-shadow:none !important}}' +
      '</style>';

    // ── TOOLBAR HTML: injected right after <body> tag ──
    var sizeOpts = ['10','11','12','13','14','16','18','20','24','28','32','36','42','48','56','64','72']
      .map(function(sz){ return '<option value="' + sz + '">' + sz + '</option>'; }).join('');

    var toolbarDiv =
      '<div id="lt-toolbar">' +
        // Logo de empresa
        '<div style="display:flex;align-items:center;gap:4px;margin-right:5px;flex-shrink:0">' +
          '<img id="lt-logo-img" src="' + logoSrc + '" style="height:24px;max-width:80px;object-fit:contain;border-radius:3px;border:1px solid #252840;background:#0a0b0f;padding:2px" onerror="this.style.display=\'none\'">' +
          '<input type="file" id="lt-logo-file" accept="image/*" style="display:none" onchange="ltUploadLogo(this)">' +
          '<button onclick="document.getElementById(\'lt-logo-file\').click()" title="Cambiar logo" style="padding:3px 8px;font-size:11px">🖼</button>' +
          '<button onclick="ltRemoveLogo()" title="Quitar logo" style="color:#ff6b6b;padding:3px 7px;font-size:11px">✕</button>' +
        '</div>' +
        '<div class="sep"></div>' +
        // Color de acento
        '<label>Acento</label>' +
        '<input type="color" id="lt-color-pick" value="' + accent + '" oninput="ltApplyAccent(this.value)" title="Color de acento">' +
        '<div class="sep"></div>' +
        // Tamaño
        '<label>Tam.</label>' +
        '<select id="lt-size" onchange="ltApplySize(this.value)">' + sizeOpts + '</select>' +
        '<div class="sep"></div>' +
        // Formato de texto
        '<button onclick="ltFmt(\'bold\')" title="Negrita"><b>B</b></button>' +
        '<button onclick="ltFmt(\'italic\')" title="Cursiva"><i>I</i></button>' +
        '<button onclick="ltFmt(\'underline\')" title="Subrayado"><u>U</u></button>' +
        '<button onclick="ltFmt(\'strikeThrough\')" title="Tachado" style="text-decoration:line-through">S</button>' +
        '<div class="sep"></div>' +
        // Alineación
        '<button onclick="ltFmt(\'justifyLeft\')" title="Izquierda" style="font-size:13px;letter-spacing:-1px">⇐</button>' +
        '<button onclick="ltFmt(\'justifyCenter\')" title="Centrar" style="font-size:13px">≡</button>' +
        '<button onclick="ltFmt(\'justifyRight\')" title="Derecha" style="font-size:13px;letter-spacing:-1px">⇒</button>' +
        '<div class="sep"></div>' +
        // Color de texto
        '<label>Texto</label>' +
        '<input type="color" id="lt-text-color" value="#e0e2f0" oninput="ltApplyTextColor(this.value)" title="Color del texto">' +
        '<div class="sep"></div>' +
        // PDF
        '<button onclick="window.print()" title="Imprimir / Guardar PDF" style="background:' + accent + '22;border-color:' + accent + ';color:' + accent + ';font-weight:700;padding:5px 14px;margin-left:2px">🖨 PDF</button>' +
      '</div>';

    // ── EDITOR SCRIPTS: injected before </body> ──
    var editScript =
      '<script>' +
      // Make text-bearing elements contenteditable on load
      '(function(){' +
        'var sels=["h1","h2","h3","h4","p","td","th","li",' +
          '".cover-tag",".cover-title",".cover-club",".cover-date",' +
          '".cover-total-label",".cover-total-sub",".section-tag",".section-title",' +
          '".guarantee-title",".guarantee-text",".benefit-item",' +
          '".sum-card-label",".sum-card-val",".page-footer span",".cover-footer span"' +
        '];' +
        'sels.forEach(function(sel){' +
          'document.querySelectorAll(sel).forEach(function(el){' +
            'if(!el.querySelector("img")&&el.children.length===0||el.textContent.trim()){' +
              'el.contentEditable="true";el.classList.add("lt-editable");' +
            '}' +
          '});' +
        '});' +
        // Track accent for replacement
        'window._ltAccent=' + JSON.stringify(accent) + ';' +
      '})();' +
      // Formatting commands
      'function ltFmt(c){document.execCommand(c,false,null);}' +
      'function ltApplySize(s){' +
        'document.execCommand("fontSize",false,"7");' +
        'document.querySelectorAll("font[size=\'7\']").forEach(function(e){' +
          'e.removeAttribute("size");e.style.fontSize=s+"px";' +
        '});' +
      '}' +
      'function ltApplyTextColor(c){document.execCommand("foreColor",false,c);}' +
      // Accent color swap (uses split/join — safe with hex colors, no regex escaping needed)
      'function ltApplyAccent(c){' +
        'var old=window._ltAccent||"#39e870";' +
        'function rep(str){return str.split(old).join(c);}' +
        'document.querySelectorAll("[style]").forEach(function(el){' +
          'el.style.cssText=rep(el.style.cssText);' +
        '});' +
        'document.querySelectorAll("style").forEach(function(s){' +
          's.textContent=rep(s.textContent);' +
        '});' +
        'window._ltAccent=c;' +
      '}' +
      // Logo swap
      'function ltUploadLogo(inp){' +
        'if(!inp.files||!inp.files[0])return;' +
        'var r=new FileReader();' +
        'r.onload=function(e){' +
          'var img=document.getElementById("lt-logo-img");' +
          'if(img){img.src=e.target.result;img.style.display="block";}' +
          'document.querySelectorAll(".cover-logo img,.page-logo img").forEach(function(i){' +
            'i.src=e.target.result;i.style.display="block";' +
          '});' +
        '};' +
        'r.readAsDataURL(inp.files[0]);' +
      '}' +
      'function ltRemoveLogo(){' +
        'var img=document.getElementById("lt-logo-img");if(img)img.style.display="none";' +
        'document.querySelectorAll(".cover-logo img,.page-logo img").forEach(function(i){i.style.display="none";});' +
      '}' +
      '<\/script>';

    // ── ASSEMBLE: inject toolbar into the full proposal HTML (preserving all dark CSS) ──
    var finalHtml = baseHtml
      .replace('</head>', toolbarCss + '</head>')
      .replace(/<body([^>]*)>/, function(match){ return match + toolbarDiv; })
      .replace('</body>', editScript + '</body>');

    var iframe = document.getElementById('cot-preview-content');
    if (iframe) {
      iframe.srcdoc = finalHtml;
      openModal('modal-cot-preview');
    } else {
      toast('Error: no se encontró el editor. Recarga la página.', 'error');
    }
  }

  function exportCotizador() {
    calcCotizador();
    var s = _cotState;
    var html = _buildCotizadorHTML();

    var blob = new Blob([html], { type: 'text/html' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href   = url;
    a.download = 'propuesta-' + (s.club || 'club').toLowerCase().replace(/\s+/g,'-') + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('✓ Propuesta exportada — Abrí el archivo en el navegador e imprimí como PDF', 'success');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXPORTAR
  // ══════════════════════════════════════════════════════════════════════════
  async function exportData(type, format) {
    format = format || 'json';
    try {
      var res, baseName, data, columns, title;
      if (type === 'clubs') {
        res = await DB.from('clubs').select('*').order('name');
        baseName = 'clubes';
        title = 'Clubes — Líbero Táctico';
        columns = ['name','short_name','country','city','category','plan','seats','plan_price','plan_currency','active','trial'];
      } else if (type === 'users') {
        res = await DB.from('profiles').select('id, email, full_name, role, active, created_at').order('email');
        baseName = 'usuarios';
        title = 'Usuarios — Líbero Táctico';
        columns = ['full_name','email','role','active','created_at'];
      } else if (type === 'invoices') {
        res = await DB.from('invoices').select('*, clubs(name)').order('created_at', { ascending: false });
        baseName = 'facturas';
        title = 'Facturación — Líbero Táctico';
        columns = ['clubs','amount','currency','due_date','status','period_start','period_end'];
      } else {
        toast('Tipo no válido', 'error'); return;
      }

      if (res.error) throw res.error;
      data = res.data || [];

      _downloadAs(data, baseName, format, title, columns);
      toast('Exportado ✓', 'success');
    } catch(err) {
      toast('Error al exportar: ' + err.message, 'error');
    }
  }

  async function exportClubData(format) {
    format = format || 'json';
    var clubId = val(document.getElementById('export-club-select'));
    if (!clubId) { toast('Seleccioná un club', 'error'); return; }

    var club = state.clubs.find(function(c){ return c.id === clubId; });
    var clubName = club ? club.name : clubId;
    try {
      var [usersRes, modulesRes, invoicesRes, auditRes] = await Promise.all([
        DB.from('club_members').select('*, profiles(full_name, email, role)').eq('club_id', clubId),
        DB.from('club_modules').select('module, enabled, enabled_at').eq('club_id', clubId),
        DB.from('invoices').select('amount, currency, status, due_date, period_start, period_end').eq('club_id', clubId),
        // Uso por módulo: audit_log de este club
        DB.from('audit_log').select('action, created_at').eq('club_id', clubId).order('created_at', { ascending: false }).limit(500),
      ]);

      // --- Calcular uso por módulo con fecha y porcentaje ---
      var modulesData = modulesRes.data || [];
      var auditData   = auditRes.data   || [];
      var totalActions = auditData.length || 1;

      // Contar acciones por módulo a partir del audit_log
      var modUseCounts = {};
      MODULES.forEach(function(m){ modUseCounts[m] = 0; });
      auditData.forEach(function(entry){
        // Inferir módulo desde el action name (ej: 'save_rendimiento' → 'rendimiento')
        MODULES.forEach(function(m){
          if (entry.action && entry.action.toLowerCase().includes(m)) modUseCounts[m]++;
        });
      });

      var modulesWithUsage = modulesData.map(function(m){
        var uses  = modUseCounts[m.module] || 0;
        var pct   = ((uses / totalActions) * 100).toFixed(1);
        var label = (MODULE_LABELS[m.module] || { label: m.module }).label;
        return {
          modulo:      label,
          activo:      m.enabled ? 'Sí' : 'No',
          activado_el: m.enabled_at ? fmtDate(m.enabled_at) : '—',
          usos_aprox:  uses,
          pct_uso:     pct + '%',
        };
      });

      var exportPayload = {
        club:        club || { id: clubId },
        usuarios:    (usersRes.data || []).map(function(m){ return { nombre: (m.profiles||{}).full_name || '—', email: (m.profiles||{}).email || '—', rol: m.role || '—' }; }),
        modulos:     modulesWithUsage,
        facturas:    (invoicesRes.data || []),
        exported_at: new Date().toISOString(),
      };

      if (format === 'json') {
        var blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'lt-' + clubName.replace(/\s+/g,'-').toLowerCase() + '.json';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
      } else {
        // Para Excel/PDF: exportar módulos con uso como hoja principal
        var flatRows = [];
        exportPayload.usuarios.forEach(function(u){
          flatRows.push({ tipo:'Usuario', nombre:u.nombre, email:u.email, rol:u.rol, activo:'—', activado_el:'—', usos_aprox:'—', pct_uso:'—' });
        });
        exportPayload.modulos.forEach(function(m){
          flatRows.push({ tipo:'Módulo', nombre:m.modulo, email:'—', rol:'—', activo:m.activo, activado_el:m.activado_el, usos_aprox:m.usos_aprox, pct_uso:m.pct_uso });
        });
        exportPayload.facturas.forEach(function(i){
          flatRows.push({ tipo:'Factura', nombre: fmtMoney(i.amount, i.currency), email:'—', rol:'—', activo:i.status, activado_el: i.due_date || '—', usos_aprox:'—', pct_uso:'—' });
        });
        _downloadAs(flatRows, 'data-' + clubName.replace(/\s+/g,'-').toLowerCase(), format, 'Datos — ' + clubName,
          ['tipo','nombre','email','rol','activo','activado_el','usos_aprox','pct_uso']);
      }
      toast('Datos de ' + clubName + ' exportados ✓', 'success');
    } catch(err) {
      toast('Error al exportar: ' + err.message, 'error');
    }
  }

  function _downloadAs(data, baseName, format, title, columns) {
    var a = document.createElement('a');

    if (format === 'json') {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      a.href = URL.createObjectURL(blob);
      a.download = 'lt-' + baseName + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(a.href);

    } else if (format === 'excel') {
      if (!window.XLSX) { toast('SheetJS no cargado — verifica la conexión a internet', 'error'); return; }
      // Aplanar objetos
      var rows = data.map(function(row) {
        var flat = {};
        (columns || Object.keys(row)).forEach(function(col) {
          var v = row[col];
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            // nested (ej: clubs:{name})
            flat[col] = v.name || JSON.stringify(v);
          } else {
            flat[col] = v;
          }
        });
        return flat;
      });
      var wb = XLSX.utils.book_new();
      var ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, baseName.slice(0,31));
      XLSX.writeFile(wb, 'lt-' + baseName + '.xlsx');

    } else if (format === 'pdf') {
      // Generar HTML tabla imprimible
      var cols = columns || (data.length ? Object.keys(data[0]) : []);
      var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<title>' + esc(title) + '</title>' +
        '<style>body{font-family:Arial,sans-serif;padding:32px;color:#1a1d2e}' +
        'h1{font-size:20px;margin-bottom:4px}' +
        '.sub{font-size:11px;color:#9aa0c0;margin-bottom:20px}' +
        'table{width:100%;border-collapse:collapse}' +
        'th{background:#f7f8fc;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#9aa0c0;padding:8px 12px;text-align:left;border-bottom:2px solid #e8eaf0}' +
        'td{padding:8px 12px;border-bottom:1px solid #f0f1f7;font-size:12px;color:#1a1d2e}' +
        'tr:nth-child(even) td{background:#fafbff}' +
        '.footer{margin-top:24px;font-size:10px;color:#9aa0c0;text-align:center}' +
        '@media print{@page{margin:16mm}}' +
        '</style></head><body>' +
        '<h1>' + esc(title) + '</h1>' +
        '<div class="sub">Exportado el ' + new Date().toLocaleDateString('es-AR') + ' · ' + data.length + ' registros</div>' +
        '<table><thead><tr>' +
          cols.map(function(c){ return '<th>' + esc(c) + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
          data.map(function(row){
            return '<tr>' + cols.map(function(c){
              var v = row[c];
              if (v && typeof v === 'object') v = v.name || JSON.stringify(v);
              return '<td>' + esc(String(v === null || v === undefined ? '—' : v)) + '</td>';
            }).join('') + '</tr>';
          }).join('') +
        '</tbody></table>' +
        '<div class="footer">Líbero Táctico · Datos confidenciales</div>' +
        '</body></html>';

      var blob = new Blob([html], { type: 'text/html' });
      a.href = URL.createObjectURL(blob);
      a.download = 'lt-' + baseName + '.html';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast('Abrí el archivo en el navegador e imprimí como PDF', 'success');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AI INSIGHTS (análisis estratégico basado en reglas)
  // ══════════════════════════════════════════════════════════════════════════
  async function loadAIInsights() {
    var container = document.getElementById('ai-insights-container');
    if (!container) return;
    container.innerHTML = '<div class="empty"><div class="empty-icon" style="font-size:24px;animation:spin 1s linear infinite">⟳</div>Analizando métricas...</div>';

    try {
      var clubs   = state.clubs || [];
      var users   = state.users || [];
      var insights = [];

      // ─── Calcular métricas ─────────────────────────────────────────────────
      var activeClubs = clubs.filter(function(c){ return c.active && !c.trial; });
      var trialClubs  = clubs.filter(function(c){ return c.trial; });
      var avgPrice    = activeClubs.length
        ? activeClubs.reduce(function(s,c){ return s + (parseFloat(c.plan_price)||0); }, 0) / activeClubs.length
        : 0;

      // Módulos habilitados
      var modRes = await DB.from('club_modules').select('module').eq('enabled', true);
      var modCounts = {};
      (modRes.data || []).forEach(function(m){ modCounts[m.module] = (modCounts[m.module]||0) + 1; });

      var leastUsedMod = MODULES.slice().sort(function(a,b){ return (modCounts[a]||0) - (modCounts[b]||0); })[0];
      var mostUsedMod  = MODULES.slice().sort(function(a,b){ return (modCounts[b]||0) - (modCounts[a]||0); })[0];
      var leastLabel   = MODULE_LABELS[leastUsedMod] || { icon:'📦', label: leastUsedMod };
      var mostLabel    = MODULE_LABELS[mostUsedMod]  || { icon:'📦', label: mostUsedMod };

      // Auditoría de últimas acciones
      var logRes = await DB.from('audit_log').select('club_id, created_at').order('created_at', { ascending:false }).limit(200);
      var weekAgo = new Date(Date.now() - 7*86400000);
      var recentIds = new Set((logRes.data||[]).filter(function(l){ return new Date(l.created_at) > weekAgo; }).map(function(l){ return l.club_id; }));
      var inactiveClubs = activeClubs.filter(function(c){ return !recentIds.has(c.id); });

      // ─── Reglas de insights ─────────────────────────────────────────────────

      // 1. Tasa de conversión de trials
      if (trialClubs.length > 0) {
        var trialPct = Math.round((trialClubs.length / (clubs.length || 1)) * 100);
        insights.push({
          priority: trialPct > 30 ? 'high' : 'med',
          icon: '🎯',
          title: 'Convertir trials en clientes pagos',
          desc: 'Tenés ' + trialClubs.length + ' club' + (trialClubs.length > 1 ? 's' : '') + ' en período de prueba (' + trialPct + '% del total). Contactalos antes del vencimiento con una propuesta personalizada. Los trials con más de 10 días activos tienen 3× más probabilidad de convertir.',
          action: 'Revisar períodos de prueba',
          section: 'trials',
        });
      }

      // 2. Clubes inactivos
      if (inactiveClubs.length > 0) {
        insights.push({
          priority: inactiveClubs.length > 2 ? 'high' : 'med',
          icon: '😴',
          title: 'Reactivar clubes sin actividad',
          desc: inactiveClubs.length + ' club' + (inactiveClubs.length > 1 ? 's activos no han' : ' activo no ha') + ' generado actividad en los últimos 7 días: ' +
            inactiveClubs.slice(0,3).map(function(c){ return c.name; }).join(', ') +
            (inactiveClubs.length > 3 ? ' y ' + (inactiveClubs.length - 3) + ' más' : '') + '. Enviá un mensaje de seguimiento o programá una llamada de onboarding.',
          action: 'Enviar mensaje',
          section: 'messages',
        });
      }

      // 3. Módulo con baja adopción
      var leastCount = modCounts[leastUsedMod] || 0;
      if (activeClubs.length > 1 && leastCount < Math.ceil(activeClubs.length * 0.4)) {
        insights.push({
          priority: 'med',
          icon: leastLabel.icon,
          title: 'Impulsar adopción de ' + leastLabel.label,
          desc: 'Solo ' + leastCount + ' de ' + activeClubs.length + ' clubs activos tienen habilitado el módulo de ' + leastLabel.label + '. Considerá incluirlo en el onboarding o crear una demo específica para mostrar su valor.',
          action: 'Ver módulos',
          section: 'modules',
        });
      }

      // 4. Precio promedio bajo
      if (activeClubs.length >= 2 && avgPrice < 80) {
        insights.push({
          priority: 'med',
          icon: '💰',
          title: 'Aumentar el ticket promedio',
          desc: 'El precio promedio de tus clubes activos es USD ' + avgPrice.toFixed(0) + '/mes. Analizá qué clubes tienen plan básico y ofreceles una demo del módulo ' + mostLabel.label + ' (' + mostLabel.icon + ') que es el más adoptado. Un upsell del 20% en 3 clubes aumentaría el MRR considerablemente.',
          action: 'Ver cotizador',
          section: 'cotizador',
        });
      }

      // 5. Oportunidad de upsell para clubs en Basic
      var basicClubs = activeClubs.filter(function(c){ return c.plan === 'basic'; });
      if (basicClubs.length > 0) {
        insights.push({
          priority: 'low',
          icon: '⬆️',
          title: 'Upsell: ' + basicClubs.length + ' club' + (basicClubs.length > 1 ? 's' : '') + ' en plan Basic',
          desc: 'Los clubs en plan Basic tienen mayor potencial de crecimiento. Presentá el plan Pro con módulos avanzados (' + mostLabel.icon + ' ' + mostLabel.label + ' es el más usado). Una propuesta personalizada por usuario tiene más impacto que una oferta general.',
          action: 'Ver clubes',
          section: 'clubs',
        });
      }

      // 6. Sin facturas recientes
      var invRes = await DB.from('invoices').select('id, created_at, status').order('created_at', { ascending:false }).limit(10);
      var invs = invRes.data || [];
      var overdueInvs = invs.filter(function(i){ return i.status === 'overdue'; });
      if (overdueInvs.length > 0) {
        insights.push({
          priority: 'high',
          icon: '🔴',
          title: overdueInvs.length + ' factura' + (overdueInvs.length > 1 ? 's vencidas' : ' vencida') + ' sin cobrar',
          desc: 'Tenés facturas vencidas que impactan el flujo de caja. Contactá a los clubs correspondientes y ofrecé alternativas de pago si es necesario. Las deudas pendientes mayores a 30 días tienen menor probabilidad de cobro.',
          action: 'Ver facturación',
          section: 'billing',
        });
      }

      // 7. Buenas noticias — todo en orden
      if (insights.length === 0) {
        insights.push({
          priority: 'low',
          icon: '🏆',
          title: '¡Todo en orden!',
          desc: 'No se detectaron alertas críticas. Tus métricas están saludables. Seguí monitoreando la actividad de los clubes y mantené comunicación regular con el equipo.',
          action: null,
          section: null,
        });
      }

      // Ordenar por prioridad
      var pOrder = { high: 0, med: 1, low: 2 };
      insights.sort(function(a,b){ return pOrder[a.priority] - pOrder[b.priority]; });

      // ─── Renderizar ─────────────────────────────────────────────────────────
      var priorityLabels = { high: 'Alta prioridad', med: 'Prioridad media', low: 'Información' };
      container.innerHTML = insights.map(function(ins){
        return '<div class="insight-card ' + ins.priority + '">' +
          '<div class="insight-icon">' + ins.icon + '</div>' +
          '<div class="insight-body">' +
            '<div class="insight-title">' + esc(ins.title) + '</div>' +
            '<div class="insight-desc">' + esc(ins.desc) + '</div>' +
            '<div style="margin-top:8px;display:flex;align-items:center;gap:8px">' +
              '<span class="insight-tag ' + ins.priority + '">' + priorityLabels[ins.priority] + '</span>' +
              (ins.action ? '<button onclick="showSection(\'' + ins.section + '\')" style="background:none;border:none;cursor:pointer;font-family:var(--cond);font-size:10px;color:var(--cyan);letter-spacing:1px;text-decoration:underline">' + esc(ins.action) + ' →</button>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');

    } catch(err) {
      console.error('[AdminClient] loadAIInsights:', err);
      container.innerHTML = '<div class="empty">No se pudo generar el análisis — verifica la conexión a la base de datos</div>';
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PERSONALIZACIÓN
  // ══════════════════════════════════════════════════════════════════════════
  var PREF_KEY = 'lt-admin-prefs';

  function loadPersonalization() {
    var pref = {};
    try { pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch(e){}

    // Rellenar campos
    var fields = {
      'pref-panel-name':       pref.panelName    || 'Líbero Táctico',
      'pref-company':          pref.company       || '',
      'pref-tagline':          pref.tagline       || '',
      'pref-email':            pref.email         || '',
      'pref-phone':            pref.phone         || '',
      'pref-website':          pref.website       || '',
      'pref-address':          pref.address       || '',
      'pref-instagram':        pref.instagram     || '',
      'pref-twitter':          pref.twitter       || '',
      'pref-cta':              pref.cta           || '',
      'pref-welcome':          pref.welcome       || '',
      'pref-pdf-header':       pref.pdfHeader     || 'PROPUESTA COMERCIAL',
      'pref-pdf-footer':       pref.pdfFooter     || 'Información confidencial — Líbero Táctico',
      'pref-guarantee':        pref.guarantee     || '',
      'pref-color-hex':        pref.accent        || '#39e870',
      'pref-default-currency': pref.defaultCurrency || 'USD',
    };
    // Logo
    if (pref.logoB64) {
      var logoPreview = document.getElementById('pref-logo-preview');
      if (logoPreview) { logoPreview.src = pref.logoB64; logoPreview.style.display = 'block'; }
      var logoB64El = document.getElementById('pref-logo-b64');
      if (logoB64El) logoB64El.value = pref.logoB64;
    }

    Object.keys(fields).forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.value = fields[id];
    });

    // Aplicar acento
    if (pref.accent) applyAccentColor(pref.accent);

    // Marcar swatch activo
    var swatches = document.querySelectorAll('.color-swatch');
    swatches.forEach(function(sw){
      sw.classList.toggle('active', sw.getAttribute('data-color') === pref.accent);
    });
  }

  function savePersonalization() {
    var g = function(id){ return (document.getElementById(id) || {}).value || ''; };
    var pref = {
      panelName:       g('pref-panel-name') || 'Líbero Táctico',
      company:         g('pref-company'),
      tagline:         g('pref-tagline'),
      email:           g('pref-email'),
      phone:           g('pref-phone'),
      website:         g('pref-website'),
      address:         g('pref-address'),
      instagram:       g('pref-instagram'),
      twitter:         g('pref-twitter'),
      cta:             g('pref-cta'),
      welcome:         g('pref-welcome'),
      pdfHeader:       g('pref-pdf-header') || 'PROPUESTA COMERCIAL',
      pdfFooter:       g('pref-pdf-footer'),
      guarantee:       g('pref-guarantee'),
      accent:          g('pref-color-hex') || '#39e870',
      defaultCurrency: g('pref-default-currency') || 'USD',
      logoB64:         g('pref-logo-b64'),
    };

    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(pref));
      applyAccentColor(pref.accent);
      toast('Preferencias guardadas ✓', 'success');
    } catch(e) {
      toast('Error al guardar preferencias', 'error');
    }
  }

  function applyAccentColor(color) {
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
    document.documentElement.style.setProperty('--green', color);
  }

  function selectAccent(el) {
    var color = el.getAttribute('data-color');
    if (!color) return;
    document.querySelectorAll('.color-swatch').forEach(function(sw){ sw.classList.remove('active'); });
    el.classList.add('active');
    var hexInput = document.getElementById('pref-color-hex');
    if (hexInput) hexInput.value = color;
    var colorInput = document.getElementById('pref-custom-color');
    if (colorInput) colorInput.value = color;
    applyAccentColor(color);
  }

  function applyCustomColor() {
    var hexInput = document.getElementById('pref-color-hex');
    if (!hexInput) return;
    var color = hexInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(color)) {
      applyAccentColor(color);
      document.querySelectorAll('.color-swatch').forEach(function(sw){ sw.classList.remove('active'); });
    }
  }

  function previewClubLogo(input) {
    if (!input.files || !input.files[0]) return;
    var file = input.files[0];
    if (file.size > 512000) { toast('El logo debe ser menor a 500KB', 'error'); return; }

    var reader = new FileReader();
    reader.onload = function(e) {
      var b64 = e.target.result;
      var imgEl = document.getElementById('logo-preview-img');
      var placeholder = document.getElementById('logo-upload-placeholder');
      var previewDiv = document.getElementById('logo-upload-preview');
      var b64Input = document.getElementById('club-logo-b64');
      if (imgEl) imgEl.src = b64;
      if (placeholder) placeholder.style.display = 'none';
      if (previewDiv) previewDiv.style.display = 'flex';
      if (b64Input) b64Input.value = b64;
      toast('Logo cargado ✓', 'success');
    };
    reader.readAsDataURL(file);
  }

  function previewUserAvatar(input) {
    if (!input.files || !input.files[0]) return;
    var file = input.files[0];
    if (file.size > 300000) { toast('La foto debe ser menor a 300KB', 'error'); return; }
    var reader = new FileReader();
    reader.onload = function(e) {
      var b64 = e.target.result;
      var imgEl = document.getElementById('user-avatar-preview');
      var ph    = document.getElementById('user-avatar-placeholder');
      var b64In = document.getElementById('user-avatar-b64');
      if (imgEl) { imgEl.src = b64; imgEl.style.display = 'block'; }
      if (ph)    ph.style.display = 'none';
      if (b64In) b64In.value = b64;
      toast('Foto cargada ✓', 'success');
    };
    reader.readAsDataURL(file);
  }

  function clearUserAvatar() {
    var imgEl = document.getElementById('user-avatar-preview');
    var ph    = document.getElementById('user-avatar-placeholder');
    var b64In = document.getElementById('user-avatar-b64');
    var fi    = document.getElementById('user-avatar-file');
    if (imgEl) { imgEl.src = ''; imgEl.style.display = 'none'; }
    if (ph)    ph.style.display = 'flex';
    if (b64In) b64In.value = '';
    if (fi)    fi.value = '';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS INTERNOS
  // ══════════════════════════════════════════════════════════════════════════
  async function logAction(action, details) {
    try {
      await DB.from('audit_log').insert({
        user_id:  (window._adminUser || {}).id,
        action:   action,
        details:  details || {},
      });
    } catch(e) { /* silencioso */ }
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function val(el) {
    return el ? el.value : '';
  }

  function trim(el) {
    return el ? (el.value || '').trim() : '';
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function setSelectValue(sel, value) {
    if (!sel) return;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === String(value)) { sel.selectedIndex = i; return; }
    }
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('es-AR', { day:'2-digit', month:'short', year:'numeric' });
  }

  function fmtDateTime(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString('es-AR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
  }

  function fmtMoney(amount, currency) {
    var n = parseFloat(amount) || 0;
    if (!n) return '—';
    var cur = CURRENCIES[currency] || { symbol: currency + ' ', name: currency };
    return cur.symbol + n.toLocaleString('es-AR') + ' ' + (currency || 'USD');
  }

  function timeAgo(d) {
    if (!d) return '—';
    var diff = (Date.now() - new Date(d)) / 1000;
    if (diff < 60)     return 'Hace un momento';
    if (diff < 3600)   return 'Hace ' + Math.floor(diff/60) + ' min';
    if (diff < 86400)  return 'Hace ' + Math.floor(diff/3600) + 'h';
    if (diff < 604800) return 'Hace ' + Math.floor(diff/86400) + 'd';
    return fmtDate(d);
  }

  function formatAction(action) {
    var map = {
      login:        'Inicio de sesión',
      logout:       'Cierre de sesión',
      save_data:    'Guardó datos',
      create_club:  'Creó club',
      edit_club:    'Editó club',
      delete_club:  'Eliminó club',
      create_user:  'Creó usuario',
    };
    return map[action] || action;
  }

  function planBadge(plan) {
    var map = {
      trial:      '<span class="tag tag-orange">🎁 Trial</span>',
      basic:      '<span class="tag tag-cyan">Basic</span>',
      pro:        '<span class="tag tag-purple">Pro</span>',
      enterprise: '<span class="tag tag-green">Enterprise</span>',
    };
    return map[plan] || '<span class="tag tag-mut">' + esc(plan) + '</span>';
  }

  function roleBadge(role) {
    var map = {
      admin:                 '<span class="tag tag-orange">Admin</span>',
      gerente:               '<span class="tag tag-orange">Gerente</span>',
      director:              '<span class="tag tag-orange">Director</span>',
      representante:         '<span class="tag tag-orange">Representante</span>',
      dt:                    '<span class="tag tag-cyan">DT</span>',
      ayudante_tecnico:      '<span class="tag tag-cyan">Ayudante Técnico</span>',
      entrenador_porteros:   '<span class="tag tag-cyan">Prep. Porteros</span>',
      preparador_fisico:     '<span class="tag tag-cyan">Prep. Físico</span>',
      analista:              '<span class="tag tag-green">Analista</span>',
      analista_rendimiento:  '<span class="tag tag-green">Analista Rend.</span>',
      analista_rival:        '<span class="tag tag-green">Analista Rival</span>',
      analista_mercado:      '<span class="tag tag-green">Analista Mercado</span>',
      scout:                 '<span class="tag tag-purple">Scout</span>',
    };
    return map[role] || '<span class="tag tag-mut">' + esc(role || '—') + '</span>';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXPONER GLOBALES (llamadas desde onclick en HTML)
  // ══════════════════════════════════════════════════════════════════════════
  window.showSection   = showSection;
  window.openModal     = openModal;
  window.closeModal    = closeModal;
  window.doLogout      = doLogout;
  window.refreshAll    = refreshAll;

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIG COTIZADOR — Planes y textos editables guardados en Supabase
  // ══════════════════════════════════════════════════════════════════════════

  var _cotConfig = null;
  var _cotSelectedPlan = null;   // plan selected from _cotConfig.plans
  var COT_SETTINGS_KEY = 'cotizador_config';

  var DEFAULT_COT_CONFIG = {
    plans: [
      { id:'plan_1', name:'Starter', description:'Ideal para clubes que comienzan', highlighted:false,
        prices:{ USD:80, ARS:76000, CLP:72800, BRL:400, EUR:73, GBP:63, MXN:1400, COP:312000, UYU:3040 },
        features:['3 usuarios','Módulo Rendimiento','Módulo Scouting','Soporte email'] },
      { id:'plan_2', name:'Club Pro', description:'Para clubes con staff técnico completo', highlighted:true,
        prices:{ USD:150, ARS:142500, CLP:136500, BRL:750, EUR:138, GBP:118, MXN:2625, COP:585000, UYU:5700 },
        features:['5 usuarios','Todos los módulos','Exportar PDF','Soporte prioritario'] },
      { id:'plan_3', name:'Agencia', description:'Para agencias deportivas y scouts', highlighted:false,
        prices:{ USD:280, ARS:266000, CLP:254800, BRL:1400, EUR:257, GBP:221, MXN:4900, COP:1092000, UYU:10640 },
        features:['10 usuarios','Todos los módulos','Multi-club','Reportes avanzados'] }
    ],
    texts: {
      title:'Propuesta Comercial',
      subtitle:'Plataforma de análisis táctico para fútbol profesional',
      company:'Líbero Táctico',
      cta:'Comenzá hoy con 14 días de prueba gratuita',
      pdfHeader:'PROPUESTA COMERCIAL',
      pdfFooter:'Información confidencial — Líbero Táctico · Válida por 15 días',
      guarantee:'Soporte técnico dedicado, actualizaciones continuas y acceso inmediato desde el primer día.'
    },
    contact: { email:'hola@liberotactico.com', whatsapp:'', website:'www.liberotactico.com' }
  };

  async function loadCotizadorSettings() {
    _cotConfig = JSON.parse(JSON.stringify(DEFAULT_COT_CONFIG));
    var loaded = false;
    try {
      var res = await DB.from('settings').select('value').eq('key', COT_SETTINGS_KEY).single();
      if (res.data && res.data.value) { _cotConfig = res.data.value; loaded = true; }
    } catch(e) {
      console.warn('[AdminClient] tabla settings no encontrada, usando defaults:', e.message);
    }
    renderCotizadorConfigUI();
    renderCotizadorPlanSelector(); // Actualizar selector de planes en cotizador
  }

  async function saveCotizadorSettings() {
    var config = collectCotConfigFromUI();
    _cotConfig = config;
    try {
      var res = await DB.from('settings').upsert(
        { key: COT_SETTINGS_KEY, value: config, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
      if (res.error) throw res.error;
      toast('Configuración del cotizador guardada ✓', 'success');
      renderCotizadorPlanSelector(); // Actualizar selector en la sección cotizador
    } catch(e) {
      toast('Error: ' + (e.message || 'Verifica que la tabla settings exista en Supabase'), 'error');
      console.error('[AdminClient] Error guardando cotizador settings:', e);
    }
  }

  function collectCotConfigFromUI() {
    var config = { plans:[], texts:{}, contact:{} };
    var CURR = ['USD','ARS','CLP','BRL','EUR','GBP','MXN','COP','UYU'];
    document.querySelectorAll('.cot-plan-card').forEach(function(card) {
      var prices = {};
      CURR.forEach(function(c) {
        var inp = card.querySelector('.cot-plan-price-' + c);
        prices[c] = inp ? (parseFloat(inp.value) || 0) : 0;
      });
      var featEl = card.querySelector('.cot-plan-features');
      var features = featEl
        ? featEl.value.split('\n').map(function(f){ return f.trim(); }).filter(Boolean)
        : [];
      var imgHidden   = card.querySelector('.cot-plan-imagedata');
      var badgeEl     = card.querySelector('.cot-plan-badge');
      var recpText    = (card.querySelector('.cot-recipient-text')     || {}).value || '';
      var recpEmoji   = (card.querySelector('.cot-recipient-emoji-val')|| {}).value || '';
      var recpImgData = (card.querySelector('.cot-recipient-img-data') || {}).value || '';
      config.plans.push({
        id:            card.getAttribute('data-plan-id') || ('plan_' + Date.now()),
        name:          (card.querySelector('.cot-plan-name') || {}).value || '',
        description:   (card.querySelector('.cot-plan-desc') || {}).value || '',
        highlighted:   !!(card.querySelector('.cot-plan-highlighted') || {}).checked,
        badge:         badgeEl ? badgeEl.value : '',
        imageData:     imgHidden ? imgHidden.value : '',
        recipientText:  recpText,
        recipientEmoji: recpEmoji,
        recipientImage: recpImgData,
        prices:         prices,
        features:       features
      });
    });
    var gv = function(id){ var el = document.getElementById(id); return el ? el.value : ''; };
    config.texts = {
      title:     gv('cot-cfg-title'),
      subtitle:  gv('cot-cfg-subtitle'),
      company:   gv('cot-cfg-company'),
      cta:       gv('cot-cfg-cta'),
      pdfHeader: gv('cot-cfg-pdf-header'),
      pdfFooter: gv('cot-cfg-pdf-footer'),
      guarantee: gv('cot-cfg-guarantee')
    };
    config.contact = {
      email:    gv('cot-cfg-email'),
      whatsapp: gv('cot-cfg-whatsapp'),
      website:  gv('cot-cfg-website')
    };
    return config;
  }

  // ── Cotizador: selector de planes configurados ────────────────────────────
  function renderCotizadorPlanSelector() {
    var container = document.getElementById('cot-plan-selector');
    if (!container) return;
    var cfg = _cotConfig || DEFAULT_COT_CONFIG;
    var plans = (cfg.plans || []).filter(function(p){ return p.name; });

    var currency = val(document.getElementById('cot-currency')) || 'USD';
    var curData  = CURRENCIES[currency] || CURRENCIES['USD'];
    var sym      = curData.symbol;

    // Si no hay planes configurados, mostrar modo personalizado
    if (!plans.length) {
      container.innerHTML = '<div style="font-size:11px;color:var(--mut);padding:6px 0">Sin planes configurados. Creá uno en <a href="#" onclick="showSection(\'cot-config\');return false" style="color:var(--cyan)">Config. Cotizador</a>.</div>';
      var customWrap = document.getElementById('cot-custom-modules-wrap');
      if (customWrap) customWrap.style.display = 'block';
      return;
    }

    // Opción "Personalizado" + tarjetas de planes
    var html = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">' +
      '<div class="cot-plan-opt" data-plan-idx="-1" onclick="selectCotizadorPlan(-1)" style="' +
        'border:1px solid var(--brd);border-radius:8px;padding:8px 12px;cursor:pointer;transition:all .15s;' +
        'background:rgba(57,232,112,.08);border-color:var(--green);flex-shrink:0' +
      '">' +
        '<div style="font-family:var(--cond);font-size:11px;font-weight:700;color:var(--green)">⚙ Personalizado</div>' +
        '<div style="font-size:9px;color:var(--mut);margin-top:2px">Módulos sueltos</div>' +
      '</div>';

    html += plans.map(function(p, i) {
      var price     = (p.prices || {})[currency] || 0;
      var imgEl     = p.imageData
        ? '<img src="' + p.imageData + '" style="width:100%;height:56px;object-fit:cover;border-radius:6px;margin-bottom:6px">'
        : '';
      var recpEl    = (p.recipientEmoji || p.recipientText)
        ? '<div style="font-size:10px;color:var(--cyan);margin-bottom:4px">' + esc((p.recipientEmoji || '') + ' ' + (p.recipientText || '')).trim() + '</div>'
        : '';
      var badgeEl   = p.badge
        ? '<span style="background:var(--orange);color:#000;border-radius:3px;padding:0 5px;font-size:8px;font-family:var(--cond);font-weight:700;letter-spacing:1px;margin-left:4px">' + esc(p.badge) + '</span>'
        : '';
      var highlightStyle = p.highlighted ? 'border-color:var(--green);background:rgba(57,232,112,.04)' : '';
      var features = (p.features || []).slice(0, 3).map(function(f){
        return '<div style="font-size:9px;color:var(--mut);display:flex;align-items:center;gap:3px"><span style="color:var(--green);font-size:8px">✓</span>' + esc(f) + '</div>';
      }).join('');

      return '<div class="cot-plan-opt" data-plan-idx="' + i + '" onclick="selectCotizadorPlan(' + i + ')" style="' +
        'border:1px solid var(--brd);border-radius:8px;padding:10px;cursor:pointer;transition:all .15s;' +
        'background:var(--bg3);flex:1;min-width:120px;' + highlightStyle +
      '">' +
        imgEl +
        '<div style="font-family:var(--cond);font-size:12px;font-weight:700;color:var(--wht);margin-bottom:1px">' + esc(p.name) + badgeEl + '</div>' +
        (p.description ? '<div style="font-size:9px;color:var(--mut);margin-bottom:4px">' + esc(p.description) + '</div>' : '') +
        recpEl +
        features +
        '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:18px;color:var(--green);margin-top:6px">' +
          sym + Math.round(price).toLocaleString('es-AR') +
          '<span style="font-family:var(--cond);font-size:9px;color:var(--mut);margin-left:3px">/mes</span>' +
        '</div>' +
      '</div>';
    }).join('');

    html += '</div>';
    container.innerHTML = html;

    // Re-aplicar selección activa
    if (_cotSelectedPlan) {
      var idx = plans.findIndex(function(p){ return p.id === _cotSelectedPlan.id; });
      if (idx !== -1) _highlightPlanCard(idx);
    } else {
      _highlightPlanCard(-1); // personalizado activo por defecto
    }
  }

  function _highlightPlanCard(idx) {
    document.querySelectorAll('.cot-plan-opt').forEach(function(el) {
      el.style.borderColor   = '';
      el.style.boxShadow     = '';
      el.style.background    = '';
    });
    var sel = document.querySelector('.cot-plan-opt[data-plan-idx="' + idx + '"]');
    if (sel) {
      sel.style.borderColor = 'var(--green)';
      sel.style.boxShadow   = '0 0 0 2px rgba(57,232,112,.2)';
      sel.style.background  = 'rgba(57,232,112,.08)';
    }
    // Mostrar/ocultar módulos personalizados
    var customWrap = document.getElementById('cot-custom-modules-wrap');
    if (customWrap) customWrap.style.display = (idx === -1) ? 'block' : 'none';
  }

  function selectCotizadorPlan(idx) {
    var cfg   = _cotConfig || DEFAULT_COT_CONFIG;
    var plans = (cfg.plans || []).filter(function(p){ return p.name; });

    if (idx === -1) {
      _cotSelectedPlan = null;
    } else {
      _cotSelectedPlan = plans[idx] || null;
    }
    _highlightPlanCard(idx);
    calcCotizador();
  }
  // ─────────────────────────────────────────────────────────────────────────

  function renderCotizadorConfigUI() {
    var cfg = _cotConfig || DEFAULT_COT_CONFIG;
    var plansList = document.getElementById('cot-plans-list');
    if (plansList) {
      plansList.innerHTML = (cfg.plans || []).map(function(p){ return _buildPlanCardHTML(p); }).join('');
    }
    var t = cfg.texts || {};
    var c = cfg.contact || {};
    var setV = function(id, v){ var el = document.getElementById(id); if (el) el.value = v || ''; };
    setV('cot-cfg-title',      t.title);
    setV('cot-cfg-subtitle',   t.subtitle);
    setV('cot-cfg-company',    t.company);
    setV('cot-cfg-cta',        t.cta);
    setV('cot-cfg-pdf-header', t.pdfHeader);
    setV('cot-cfg-pdf-footer', t.pdfFooter);
    setV('cot-cfg-guarantee',  t.guarantee);
    setV('cot-cfg-email',      c.email);
    setV('cot-cfg-whatsapp',   c.whatsapp);
    setV('cot-cfg-website',    c.website);
  }

  function _buildPlanCardHTML(plan) {
    var CURR = ['USD','ARS','CLP','BRL','EUR','GBP','MXN','COP','UYU'];
    var prices = plan.prices || {};
    var featuresText = (plan.features || []).join('\n');
    var clientTypes = plan.clientTypes || [];
    var badge = plan.badge || '';
    var imageData = plan.imageData || '';

    var priceRows = '<div style="font-size:9px;color:var(--mut);margin-bottom:3px">Ingresá el precio en CLP y las demás monedas se calcularán automáticamente ↓</div>';
    for (var i = 0; i < CURR.length; i += 3) {
      priceRows += '<div class="fg-row3" style="margin-top:6px">';
      for (var j = i; j < Math.min(i + 3, CURR.length); j++) {
        var c = CURR[j];
        var isAnchor = (c === 'CLP');
        priceRows += '<div class="fg"><label style="' + (isAnchor ? 'color:var(--green);font-weight:700' : '') + '">' + c + (isAnchor ? ' ★' : '') + '</label>' +
          '<input class="fi cot-plan-price-' + c + '" type="number" value="' + (prices[c] || 0) + '" placeholder="0" min="0"' +
          (isAnchor ? ' oninput="ltCotAutoCalcPrices(this)"' : '') +
          '></div>';
      }
      priceRows += '</div>';
    }

    var badgeOptions = ['', 'MÁS POPULAR', 'NUEVO', 'RECOMENDADO', 'DESTACADO', 'PROMO'];
    var badgeSelect = '<select class="fi cot-plan-badge" style="margin-top:4px">' +
      badgeOptions.map(function(b){ return '<option value="' + b + '"' + (b === badge ? ' selected' : '') + '>' + (b || '— Sin badge —') + '</option>'; }).join('') +
    '</select>';

    // Nuevo "Dirigido a": texto libre + emoji rápido + imagen
    var recipientText  = plan.recipientText  || '';
    var recipientEmoji = plan.recipientEmoji || '';
    var recipientImage = plan.recipientImage || '';
    var emojiList = ['🏟','👟','🏢','👁','🏅','⚽','🤝','🎽','📊','🌎','💼','🎯'];
    var emojiButtons = emojiList.map(function(e){
      return '<button type="button" class="cot-emoji-pick" title="' + e + '" ' +
        'onclick="this.closest(\'.cot-recipient-wrap\').querySelector(\'.cot-recipient-emoji-val\').value=\'' + e + '\';' +
        'this.closest(\'.cot-recipient-wrap\').querySelector(\'.cot-recipient-emoji-disp\').textContent=\'' + e + '\';' +
        'this.closest(\'.cot-recipient-wrap\').querySelectorAll(\'.cot-emoji-pick\').forEach(function(b){b.style.background=\'transparent\'});' +
        'this.style.background=\'rgba(57,232,112,.15)\'" ' +
        'style="background:' + (e === recipientEmoji ? 'rgba(57,232,112,.15)' : 'transparent') + ';border:1px solid var(--brd);border-radius:6px;padding:4px 7px;cursor:pointer;font-size:15px;line-height:1">' +
        e + '</button>';
    }).join('');
    var recipientImgPreview = recipientImage
      ? '<img src="' + recipientImage + '" style="height:32px;width:32px;object-fit:cover;border-radius:6px;border:1px solid var(--brd2)">'
      : '';
    var clientChecks = '<div class="cot-recipient-wrap" style="display:flex;flex-direction:column;gap:10px">' +
      // Free text input
      '<div><label style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:1px">Para quién (texto libre)</label>' +
      '<input class="fi cot-recipient-text" value="' + esc(recipientText) + '" placeholder="ej: Entrenador independiente, Club Atlético San Martín..." style="margin-top:4px"></div>' +
      // Emoji quick picker
      '<div><label style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:1px">Emoji rápido <span class="cot-recipient-emoji-disp" style="font-size:14px;margin-left:4px">' + (recipientEmoji || '') + '</span></label>' +
      '<input type="hidden" class="cot-recipient-emoji-val" value="' + esc(recipientEmoji) + '">' +
      '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">' + emojiButtons + '</div></div>' +
      // Image upload
      '<div><label style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:1px">Imagen del destinatario (opcional)</label>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:6px">' +
        '<div style="cursor:pointer" onclick="this.nextElementSibling.click()">' +
          (recipientImgPreview ||
            '<div style="width:40px;height:40px;border:1px dashed var(--brd);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--mut)">+</div>') +
        '</div>' +
        '<input type="file" class="cot-recipient-img-file" accept="image/*" style="display:none" onchange="handleRecipientImageUpload(this)">' +
        '<input type="hidden" class="cot-recipient-img-data" value="' + esc(recipientImage) + '">' +
        '<span style="font-size:10px;color:var(--mut)">Logo, foto o ícono del cliente<br>(máx 300KB)</span>' +
      '</div></div>' +
    '</div>';

    var imgPreviewHtml = imageData
      ? '<div class="cot-plan-img-preview" style="display:flex;align-items:center;gap:8px;margin-top:6px">' +
          '<img src="' + imageData + '" style="height:40px;object-fit:contain;border-radius:6px;border:1px solid var(--brd2)">' +
          '<button type="button" class="btn btn-red btn-sm" onclick="clearPlanImage(this)">✕ Quitar</button>' +
        '</div>'
      : '<div class="cot-plan-img-preview" style="display:none"></div>';

    return '<div class="panel cot-plan-card" data-plan-id="' + esc(plan.id || '') + '" style="margin-bottom:14px">' +
      '<div class="panel-head" style="background:rgba(255,255,255,.02)">' +
        '<div class="panel-title" style="color:var(--wht)">' + esc(plan.name || 'Plan') + '</div>' +
        (plan.highlighted ? '<span class="tag tag-green" style="margin-right:8px">★ ' + esc(badge || 'MÁS POPULAR') + '</span>' : '') +
        '<button class="btn btn-red btn-sm" onclick="removeCotPlan(this)">🗑</button>' +
      '</div>' +
      '<div class="panel-body">' +

        /* ── Imagen del plan ── */
        '<div class="fg">' +
          '<label>Imagen / banner del plan</label>' +
          '<div class="logo-upload-area" onclick="this.querySelector(\'.cot-plan-img-file\').click()" style="padding:10px;margin-top:4px">' +
            '<input type="file" class="cot-plan-img-file" accept="image/*" style="display:none" onchange="handlePlanImageUpload(this)">' +
            '<div style="text-align:center;font-size:11px;color:var(--mut)">🖼️ Clic para subir imagen del plan (PNG, JPG — máx 1MB)</div>' +
          '</div>' +
          '<input type="hidden" class="cot-plan-imagedata" value="' + esc(imageData) + '">' +
          imgPreviewHtml +
        '</div>' +

        /* ── Nombre y descripción ── */
        '<div class="fg-row">' +
          '<div class="fg"><label>Nombre del plan</label>' +
            '<input class="fi cot-plan-name" value="' + esc(plan.name || '') + '" placeholder="ej: Club Pro" oninput="this.closest(\'.cot-plan-card\').querySelector(\'.panel-title\').textContent=this.value||\'Plan\'"></div>' +
          '<div class="fg"><label>Descripción corta</label>' +
            '<input class="fi cot-plan-desc" value="' + esc(plan.description || '') + '" placeholder="Para clubes con staff completo"></div>' +
        '</div>' +

        /* ── Badge ── */
        '<div class="fg-row">' +
          '<div class="fg"><label>Badge / etiqueta</label>' + badgeSelect + '</div>' +
          '<div class="fg"><div style="display:flex;align-items:center;gap:10px;padding-top:22px">' +
            '<label class="toggle"><input type="checkbox" class="cot-plan-highlighted"' + (plan.highlighted ? ' checked' : '') + '><span class="toggle-slider"></span></label>' +
            '<span style="font-size:11px;color:var(--txt)">Activar badge</span>' +
          '</div></div>' +
        '</div>' +

        /* ── Precios ── */
        '<div class="fg"><label>Precios por moneda (mensuales)</label>' + priceRows + '</div>' +

        /* ── Features ── */
        '<div class="fg"><label>Features incluidos (uno por línea)</label>' +
          '<textarea class="fi cot-plan-features" rows="5" placeholder="3 usuarios&#10;Todos los módulos&#10;Exportar PDF&#10;Soporte prioritario">' + esc(featuresText) + '</textarea></div>' +

        /* ── Dirigido a ── */
        '<div class="fg"><label>Dirigido a</label>' +
          '<div style="padding:12px;background:var(--bg3);border:1px solid var(--brd);border-radius:8px;margin-top:6px">' +
          clientChecks + '</div></div>' +

      '</div>' +
    '</div>';
  }

  function handlePlanImageUpload(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 1048576) { toast('Imagen debe ser menor a 1 MB', 'error'); return; }
    var card = input.closest('.cot-plan-card');
    if (!card) return;
    var reader = new FileReader();
    reader.onload = function(e) {
      var hidden  = card.querySelector('.cot-plan-imagedata');
      var preview = card.querySelector('.cot-plan-img-preview');
      if (hidden)  hidden.value = e.target.result;
      if (preview) {
        preview.style.display = 'flex';
        preview.innerHTML =
          '<img src="' + e.target.result + '" style="height:40px;object-fit:contain;border-radius:6px;border:1px solid var(--brd2)">' +
          '<button type="button" class="btn btn-red btn-sm" onclick="clearPlanImage(this)">✕ Quitar</button>';
      }
      toast('Imagen del plan cargada ✓', 'success');
    };
    reader.readAsDataURL(file);
  }

  function clearPlanImage(btn) {
    var card = btn.closest('.cot-plan-card');
    if (!card) return;
    var hidden  = card.querySelector('.cot-plan-imagedata');
    var preview = card.querySelector('.cot-plan-img-preview');
    var fileInput = card.querySelector('.cot-plan-img-file');
    if (hidden)    hidden.value = '';
    if (preview)   preview.style.display = 'none';
    if (fileInput) fileInput.value = '';
  }

  function handleRecipientImageUpload(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 307200) { toast('La imagen debe ser menor a 300KB', 'error'); return; }
    var wrap = input.closest('.cot-recipient-wrap');
    if (!wrap) return;
    var reader = new FileReader();
    reader.onload = function(e) {
      var b64 = e.target.result;
      var hiddenEl = wrap.querySelector('.cot-recipient-img-data');
      var thumbEl  = input.previousElementSibling;
      if (hiddenEl) hiddenEl.value = b64;
      if (thumbEl) thumbEl.innerHTML = '<img src="' + b64 + '" style="height:32px;width:32px;object-fit:cover;border-radius:6px;border:1px solid var(--brd2)">';
      toast('Imagen cargada ✓', 'success');
    };
    reader.readAsDataURL(file);
  }

  function addCotPlan() {
    var newPlan = {
      id: 'plan_' + Date.now(),
      name: 'Nuevo plan',
      description: '',
      highlighted: false,
      prices: { USD:0, ARS:0, CLP:0, BRL:0, EUR:0, GBP:0, MXN:0, COP:0, UYU:0 },
      features: []
    };
    var list = document.getElementById('cot-plans-list');
    if (list) {
      list.insertAdjacentHTML('beforeend', _buildPlanCardHTML(newPlan));
      list.lastElementChild.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function removeCotPlan(btn) {
    var card = btn.closest('.cot-plan-card');
    if (!card) return;
    if (document.querySelectorAll('.cot-plan-card').length <= 1) {
      toast('Debe haber al menos un plan', 'error');
      return;
    }
    card.remove();
  }

  function switchCotTab(btn, tabId) {
    document.querySelectorAll('.cot-tab').forEach(function(t) {
      t.style.borderBottom = '2px solid transparent';
      t.style.color = 'var(--mut)';
    });
    btn.style.borderBottom = '2px solid var(--green)';
    btn.style.color = 'var(--green)';
    document.querySelectorAll('.cot-tab-content').forEach(function(c){ c.style.display = 'none'; });
    var content = document.getElementById('cot-tab-' + tabId);
    if (content) content.style.display = 'block';
  }

  window.filterClubs   = filterClubs;
  window.editClub      = editClub;
  window.deleteClub    = deleteClub;

  // ── Entrar al dashboard preseleccionando un club (admin shortcut) ────────
  window.enterClubDashboard = function(clubId, clubName) {
    var url = 'dashboard.html?club_id=' + encodeURIComponent(clubId) + '&club_name=' + encodeURIComponent(clubName);
    window.open(url, '_blank');
  };
  // También desde el admin panel puede ir al dashboard sin preselección
  window.openDashboard = function() { window.open('dashboard.html', '_blank'); };
  window.saveClub      = saveClub;
  window.updatePlanPrice = updatePlanPrice;

  window.toggleModule  = toggleModule;

  window.filterUsers   = filterUsers;
  window.editUser      = editUser;
  window.saveUser      = saveUser;
  window.deactivateUser = deactivateUser;
  window.activateUser   = activateUser;
  window.deleteUser     = deleteUser;

  window.loadAuditLog  = loadAuditLog;

  window.newInvoice    = newInvoice;
  window.saveInvoice   = saveInvoice;
  window.editInvoice   = editInvoice;
  window.markPaid      = markPaid;
  window.deleteInvoice = deleteInvoice;
  window.viewReceipt   = viewReceipt;

  window.saveTrial     = saveTrial;
  window.extendTrial   = extendTrial;
  window.convertTrial  = convertTrial;
  window.deleteTrial   = deleteTrial;

  window.calcCotizador              = calcCotizador;
  window.exportCotizador            = exportCotizador;
  window.previewCotizador           = previewCotizador;
  window.selectCotizadorPlan        = selectCotizadorPlan;
  window.renderCotizadorPlanSelector = renderCotizadorPlanSelector;

  window.exportData      = exportData;
  window.exportClubData  = exportClubData;

  window.loadAIInsights  = loadAIInsights;

  window.savePersonalization = savePersonalization;
  window.loadPersonalization = loadPersonalization;
  window.selectAccent        = selectAccent;
  window.applyCustomColor    = applyCustomColor;
  window.previewClubLogo     = previewClubLogo;
  window.previewUserAvatar   = previewUserAvatar;
  window.clearUserAvatar     = clearUserAvatar;
  // ── Password management helpers ───────────────────────────────────────────

  /** Toggle visibilidad contraseña */
  window.ltTogglePwd = function(inputId, btnId) {
    var inp = document.getElementById(inputId);
    var btn = document.getElementById(btnId);
    if (!inp) return;
    var isHidden = inp.type === 'password';
    inp.type = isHidden ? 'text' : 'password';
    if (btn) btn.textContent = isHidden ? '🙈' : '👁';
  };

  /** Generar contraseña aleatoria segura y llenar un campo */
  window.ltGenPwd = function(inputId) {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
    var pwd = '';
    for (var i = 0; i < 12; i++) {
      pwd += chars[Math.floor(Math.random() * chars.length)];
    }
    var inp = document.getElementById(inputId);
    if (!inp) return;
    inp.type = 'text'; // mostrar la contraseña generada
    inp.value = pwd;
    // actualizar ícono del ojo
    var eyeMap = { 'user-password': 'user-pwd-eye1', 'user-password-new': 'user-pwd-eye3' };
    var eyeBtn = document.getElementById(eyeMap[inputId]);
    if (eyeBtn) eyeBtn.textContent = '🙈';
    toast('Contraseña generada — guardala antes de cerrar', 'info');
  };

  /** Mostrar/ocultar campo de cambio de contraseña en modo edición */
  window.ltToggleChangePwd = function() {
    var row = document.getElementById('user-pwd-change-row');
    var btn = document.getElementById('user-pwd-toggle-btn');
    if (!row) return;
    var isOpen = row.style.display !== 'none';
    row.style.display = isOpen ? 'none' : 'block';
    if (btn) btn.textContent = isOpen ? '✏️ Cambiar' : '✕ Cancelar';
    if (!isOpen) {
      var inp = document.getElementById('user-password-new');
      if (inp) { inp.value = ''; inp.type = 'password'; }
      var eye3 = document.getElementById('user-pwd-eye3');
      if (eye3) eye3.textContent = '👁';
    }
  };

  /** Preparar la sección de contraseña según modo (nuevo vs edición).
   *  2026-05-12 Sprint1 C.6 — `storedPwd` ya no se usa (los passwords no se persisten).
   *  Se mantiene el parámetro por compatibilidad con la firma original. */
  function ltResetPwdSection(isEdit, storedPwd) {
    var newRow  = document.getElementById('user-pwd-new-row');
    var editRow = document.getElementById('user-pwd-edit-row');
    var chgRow  = document.getElementById('user-pwd-change-row');
    var inp1    = document.getElementById('user-password');
    var inp3    = document.getElementById('user-password-new');
    var eye1    = document.getElementById('user-pwd-eye1');
    var eye3    = document.getElementById('user-pwd-eye3');
    var btn     = document.getElementById('user-pwd-toggle-btn');

    // Mostrar/ocultar checkbox de email_confirm según modo
    var emailConfirmWrap = document.getElementById('user-email-confirm');
    if (emailConfirmWrap) {
      var parentDiv = emailConfirmWrap.parentElement && emailConfirmWrap.parentElement.parentElement;
      if (parentDiv) parentDiv.style.display = isEdit ? 'none' : 'flex';
    }
    if (isEdit) {
      if (newRow)  newRow.style.display  = 'none';
      if (editRow) editRow.style.display = 'block';
      if (chgRow)  chgRow.style.display  = 'none';
      if (inp3) { inp3.value = ''; inp3.type = 'password'; }
      if (eye3) eye3.textContent = '👁';
      if (btn)  btn.textContent  = '✏️ Cambiar';
    } else {
      if (newRow)  newRow.style.display  = 'block';
      if (editRow) editRow.style.display = 'none';
      if (inp1) { inp1.value = ''; inp1.type = 'password'; }
      if (eye1) eye1.textContent = '👁';
    }
  }

  /** Actualizar contraseña de un usuario via Edge Function admin-ops */
  async function ltAdminUpdatePassword(userId, newPassword) {
    try {
      await ltAdminOps('updatePassword', { userId: userId, password: newPassword });
      return true;
    } catch (e) {
      console.error('[AdminClient] updatePassword:', e);
      toast('No se pudo cambiar la contraseña: ' + e.message, 'error');
      return false;
    }
  }

  /** Crear usuario Auth via Edge Function admin-ops (sin alterar la sesión del admin) */
  async function ltAdminCreateAuthUser(email, password, fullName, emailConfirm) {
    // emailConfirm: true = acceso inmediato (admin bypasses) | false = enviar email de confirmación
    if (typeof emailConfirm === 'undefined') emailConfirm = true;
    try {
      var body = await ltAdminOps('createAuthUser', {
        email: email,
        password: password,
        email_confirm: emailConfirm,
        user_metadata: { full_name: fullName || email.split('@')[0] }
      });
      return body || null;
    } catch (svcErr) {
      // Fallback solo si la Edge Function no está deployada: signUp normal.
      // Tiene 2 limitaciones conocidas:
      //   1) Cambia la sesión activa del browser (logueá al admin)
      //   2) Requiere confirmación de email
      // Por eso solo se usa cuando admin-ops no responde.
      console.warn('[AdminClient] createAuthUser via Edge Function falló, usando signUp fallback:', svcErr.message);
      toast('⚠️ Edge Function admin-ops no disponible — el usuario puede requerir confirmación de email', 'warning');
      var fallbackRes = await DB.auth.signUp({
        email: email,
        password: password,
        options: { data: { full_name: fullName || email.split('@')[0] } }
      });
      if (fallbackRes.error) throw fallbackRes.error;
      return fallbackRes.data || null;
    }
  }

  window.ltHandleRoleChange  = function(selectId, customInputId) {
    var sel = document.getElementById(selectId);
    var inp = document.getElementById(customInputId);
    if (!sel || !inp) return;
    if (sel.value === 'personalizado') {
      inp.style.display = 'block';
      inp.focus();
    } else {
      inp.style.display = 'none';
      inp.value = '';
    }
  };

  // Personalización: logo del panel
  window.ltLoadPrefLogo = function(input) {
    if (!input.files || !input.files[0]) return;
    var reader = new FileReader();
    reader.onload = function(e) {
      var prev = document.getElementById('pref-logo-preview');
      if (prev) { prev.src = e.target.result; prev.style.display = 'block'; }
      var b64el = document.getElementById('pref-logo-b64');
      if (b64el) b64el.value = e.target.result;
    };
    reader.readAsDataURL(input.files[0]);
  };

  // Cotizador: IVA type toggle
  window.ltCotIvaChange = function() {
    var ivaType = val(document.getElementById('cot-iva-type')) || 'normal';
    var customWrap = document.getElementById('cot-iva-custom-wrap');
    if (customWrap) {
      customWrap.style.display = ivaType === 'custom' ? 'flex' : 'none';
    }
  };

  // Config. Cotizador: auto-calculate all currencies from CLP anchor price
  window.ltCotAutoCalcPrices = function(clpInput) {
    var clpVal = parseFloat(clpInput.value) || 0;
    if (clpVal <= 0) return;
    var card = clpInput.closest('.cot-plan-card') || clpInput.closest('.panel-body');
    if (!card) return;
    var CURR = ['USD','ARS','CLP','BRL','EUR','GBP','MXN','COP','UYU'];
    var clpRate = CURRENCIES['CLP'].rate;  // CLP per USD
    var usdEquiv = clpVal / clpRate;       // price in USD
    CURR.forEach(function(c) {
      if (c === 'CLP') return; // keep as-is (it's the source)
      var inp = card.querySelector('.cot-plan-price-' + c);
      if (inp) {
        var converted = Math.round(usdEquiv * CURRENCIES[c].rate);
        inp.value = converted;
      }
    });
  };

  window.sendMessage   = sendMessage;
  window.ltSaveWebhook = function(v) {
    try {
      var pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      pref.msgEmailWebhook = v || '';
      localStorage.setItem(PREF_KEY, JSON.stringify(pref));
    } catch(e) {}
  };

  window.loadCotizadorSettings = loadCotizadorSettings;
  window.saveCotizadorSettings = saveCotizadorSettings;
  window.addCotPlan    = addCotPlan;
  window.removeCotPlan = removeCotPlan;
  window.switchCotTab  = switchCotTab;

  window.deleteAuditLog   = deleteAuditLog;
  window.clearAllAuditLog = clearAllAuditLog;
  window.deleteMessage    = deleteMessage;

  window.handleCotLogoUpload = handleCotLogoUpload;
  window.clearCotLogo        = clearCotLogo;
  window.updateCotAccent     = updateCotAccent;

  window.handlePlanImageUpload     = handlePlanImageUpload;
  window.clearPlanImage            = clearPlanImage;
  window.handleRecipientImageUpload = handleRecipientImageUpload;

  // ── Arrancar cuando el DOM esté listo ────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 150); // pequeño delay para que auth guard termine
  }

})();
