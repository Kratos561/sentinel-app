/* Sentinel PWA v3 — snapshot del bot (10s) + precios en vivo (5s), PnL no realizado, sparklines. */
(function () {
  "use strict";
  var cfg = (window.SENTINEL || {});
  var BASE = String(cfg.worker || "").replace(/\/+$/, "");
  var KEY = String(cfg.key || "");
  var POLL_SNAP = 10000, POLL_PX = 5000, STALE_MS = 60000, BUFN = 48;
  var lastOkSnap = 0, lastOkPx = 0, lastHttp = "—", lastServer = "—";
  var livePx = {}, pxBuf = {}, pxSrc = "—", lastOpen = [];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function num(v, d) { var n = Number(v); return Number.isFinite(n) ? n.toFixed(d == null ? 2 : d) : "—"; }
  function money(v, d) { var n = Number(v); if (!Number.isFinite(n)) return "—"; return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(d == null ? 2 : d); }
  function agoT(t) { if (!t) return "—"; var s = Math.max(0, (Date.now() - t) / 1000); if (s < 60) return "hace " + Math.floor(s) + "s"; if (s < 3600) return "hace " + Math.floor(s / 60) + "m"; return "hace " + Math.floor(s / 3600) + "h"; }
  function tshort(ts) { var t = new Date(Date.parse(ts)); return isNaN(t) ? "—" : t.toLocaleString("es", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  function host() { try { return new URL(BASE).host; } catch (e) { return "—"; } }
  function initials(s) { s = String(s || "?").replace(/[^A-Z]/gi, ""); return (s.slice(0, 2) || "?").toUpperCase(); }

  var tabs = document.querySelectorAll(".tabbar button[data-view]");
  tabs.forEach(function (b) {
    b.addEventListener("click", function () {
      tabs.forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
      $("view-" + b.getAttribute("data-view")).classList.add("active");
    });
  });
  $("fabRefresh").addEventListener("click", function () {
    $("fabRefresh").classList.add("spin");
    tickSnap(); tickPx();
    setTimeout(function () { $("fabRefresh").classList.remove("spin"); }, 1200);
  });
  document.querySelectorAll(".cmds button").forEach(function (b) {
    b.addEventListener("click", function () {
      var t = b.getAttribute("data-cmd");
      function done() { $("copyHint").textContent = t + " copiado. Pégalo en el chat del bot."; }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, done);
      else done();
    });
  });

  function rows(d, k) { return (d && Array.isArray(d[k])) ? d[k] : []; }
  function latestByField(list, field) {
    var best = null;
    list.forEach(function (r) { if (r.field === field && (!best || r.time > best.time)) best = r; });
    return best;
  }
  function upnlOf(o) {
    var L = livePx[o.asset];
    if (!L || !Number.isFinite(L.price)) return null;
    var d = (o.direction === "LONG" ? 1 : -1) * (L.price - o.entry) * o.size;
    return Number.isFinite(d) ? d : null;
  }
  function drawSpark(sym) {
    var cv = $("sp-" + sym), buf = pxBuf[sym];
    if (!cv || !buf || buf.length < 2) return;
    var ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
    var mn = Math.min.apply(null, buf), mx = Math.max.apply(null, buf), rg = (mx - mn) || 1;
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    buf.forEach(function (v, i) {
      var x = (i / (buf.length - 1)) * (W - 4) + 2, y = H - 3 - ((v - mn) / rg) * (H - 6);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    var up = buf[buf.length - 1] >= buf[0];
    ctx.strokeStyle = up ? "#16a34a" : "#dc2626"; ctx.lineWidth = 1.6; ctx.stroke();
    var lx = W - 3, ly = H - 3 - ((buf[buf.length - 1] - mn) / rg) * (H - 6);
    ctx.fillStyle = up ? "#16a34a" : "#dc2626";
    ctx.beginPath(); ctx.arc(lx, ly, 2.4, 0, 7); ctx.fill();
  }
  function diag() {
    var sw = ("serviceWorker" in navigator) ? (navigator.serviceWorker.controller ? "activo v3" : "registrando…") : "no soportado";
    $("diagBox").innerHTML =
      '<div class="k"><span>Puente</span><strong class="mono">' + esc(host()) + "</strong></div>" +
      '<div class="k"><span>Clave</span><strong>' + (KEY ? "configurada" : "FALTA") + "</strong></div>" +
      '<div class="k"><span>Último HTTP</span><strong class="mono">' + esc(lastHttp) + "</strong></div>" +
      '<div class="k"><span>Hora servidor</span><strong class="mono">' + esc(lastServer) + "</strong></div>" +
      '<div class="k"><span>Bot (snapshot)</span><strong>' + (lastOkSnap ? esc(agoT(lastOkSnap)) : "nunca") + "</strong></div>" +
      '<div class="k"><span>Precios (' + esc(pxSrc) + ")</span><strong>" + (lastOkPx ? esc(agoT(lastOkPx)) : "nunca") + "</strong></div>" +
      '<div class="k"><span>Service Worker</span><strong>' + esc(sw) + "</strong></div>";
  }

  function renderSnap(d) {
    var H = rows(d, "health"), P = rows(d, "positions"), T = rows(d, "trades"),
        D = rows(d, "dl"), E = rows(d, "events"), MO = rows(d, "monitor");
    var bal = latestByField(H, "balance"), op = latestByField(H, "open"), pa = latestByField(H, "paused");
    var balN = bal ? Number(bal.value) : NaN;
    $("cBalance").textContent = Number.isFinite(balN) ? "$" + balN.toFixed(2) : "—";
    $("cPnl").textContent = Number.isFinite(balN) ? "PnL " + money(balN - 15) + " vs inicio $15" : "—";
    $("cPnl").className = "sub-light mono " + ((balN - 15) >= 0 ? "up" : "down");
    $("cOpen").textContent = op ? op.value : "—";
    var paused = pa && (pa.value === "1" || pa.value === 1 || pa.value === true);
    $("cPaused").textContent = paused ? "Pausado" : "Armado";
    var sharpe = latestByField(MO, "sharpe"), dd = latestByField(MO, "maxDrawdownPct"),
        mt = latestByField(MO, "trades"), mp = latestByField(MO, "totalPnl");
    $("cSharpe").textContent = sharpe ? num(sharpe.value, 3) : "—";
    $("cTrades").textContent = mt ? ("Sharpe sobre " + mt.value + " trades") : "Acumulando muestra (20–50 trades por activo)";
    $("cDd").textContent = dd ? (Number(dd.value) * 100).toFixed(2) + "%" : "—";
    var driftTxt = "drift: ninguno";
    MO.forEach(function (r) { if (r.field === "drifting" && r.value && r.value !== '""') driftTxt = "drift: " + String(r.value).replace(/"/g, ""); });
    $("cDrift").textContent = driftTxt + (mp ? (" · PnL mon " + money(mp.value)) : "");
    // Abiertas (con PnL no realizado en vivo si hay precio)
    var seen = {};
    lastOpen = [];
    P.filter(function (r) { return r.tags && r.tags.is_open === "true"; })
      .sort(function (a, b) { return a.time < b.time ? 1 : -1; }).slice(0, 12)
      .forEach(function (r) {
        var s = r.tags.symbol || "?";
        if (seen[s]) return; seen[s] = 1;
        var g = {};
        P.filter(function (x) { return x.tags && x.tags.symbol === s && x.time === r.time; }).forEach(function (x) { g[x.field] = x.value; });
        lastOpen.push({ asset: s, direction: g.direction || "?", entry: Number(g.entry) || 0, size: Number(g.size) || 0, time: r.time });
      });
    var openHtml = "";
    lastOpen.forEach(function (o) {
      var u = upnlOf(o);
      openHtml += '<div class="row"><div class="l"><span class="sym">' + esc(initials(o.asset)) + "</span><span>" + esc(o.asset) + ' <span class="mut small">' + esc(o.direction) + '</span><div class="small dim">@ $' + esc(num(o.entry, 4)) + " × " + esc(o.size) + "</div></span></div>" +
        '<div class="r mono" id="upnl-' + esc(o.asset) + '">' + (u == null ? '<span class="dim small">sin precio</span>' : '<span class="' + (u >= 0 ? "up" : "down") + '">' + (u >= 0 ? "▲ " : "▼ ") + esc(money(u, 4)) + "</span>") + "</div></div>";
    });
    $("openList").innerHTML = openHtml || '<div class="empty">Sin posiciones abiertas.</div>';
    // Trades
    var groups = {};
    T.forEach(function (r) {
      var k = r.time + "|" + ((r.tags && r.tags.symbol) || "");
      if (!groups[k]) groups[k] = { time: r.time, sym: (r.tags && r.tags.symbol) || "?", f: {} };
      groups[k].f[r.field] = r.value;
    });
    function tradeRow(g) {
      var p = Number(g.f.pnl), cls = p >= 0 ? "up" : "down", arrow = p >= 0 ? "▲" : "▼";
      return '<div class="row"><div class="l"><span class="sym">' + esc(initials(g.sym)) + "</span><span>" + esc(g.sym) + ' <span class="mut small">' + esc(g.f.direction || "") + " · " + esc(g.f.reason || "") + '</span><div class="small dim">' + esc(tshort(g.time)) + "</div></span></div>" +
        '<div class="r mono ' + cls + '">' + arrow + " " + esc(money(p, 4)) + "</div></div>";
    }
    var gk = Object.keys(groups).sort().reverse(), W = 0, L = 0;
    gk.forEach(function (k) { var p = Number(groups[k].f.pnl); if (p > 0) W++; else if (p < 0) L++; });
    $("recentClosed").innerHTML = gk.slice(0, 6).map(function (k) { return tradeRow(groups[k]); }).join("") || '<div class="empty">Sin cierres registrados.</div>';
    $("tradeHist").innerHTML = gk.slice(0, 15).map(function (k) { return tradeRow(groups[k]); }).join("") || '<div class="empty">Sin historial.</div>';
    $("sessWL").innerHTML = gk.length ? ("Ledger 7d: <strong class='up'>" + W + "W</strong> · <strong class='down'>" + L + "L</strong> · " + gk.length + " trades") : "";
    // DL
    var dlS = {}, dlT = {};
    D.forEach(function (r) {
      var s = (r.tags && r.tags.symbol) || "";
      if (!s) return;
      if (r.field === "hybrid_score" && (!dlS[s] || r.time > dlS[s].time)) dlS[s] = r;
      if (r.field === "latency_ms" && (!dlT[s] || r.time > dlT[s].time)) dlT[s] = r;
    });
    var dh = "";
    Object.keys(dlS).sort().forEach(function (s) {
      var v = Number(dlS[s].value) * 100, lat = dlT[s] ? dlT[s].value + "ms" : "";
      var cls = v >= 55 ? "up" : (v <= 45 ? "down" : "warn");
      dh += '<div class="row"><div class="l"><span class="sym">' + esc(initials(s)) + "</span><span>" + esc(s) + '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, v)).toFixed(0) + '%"></i></div></span></div>' +
        '<div class="r mono ' + cls + '">' + v.toFixed(1) + '%<div class="small dim">' + esc(lat) + " · " + esc(agoT(Date.parse(dlS[s].time))) + "</div></div></div>";
    });
    $("dlList").innerHTML = dh || '<div class="empty">Sin señales.</div>';
    // Learn
    var lb = "";
    if (sharpe) lb += '<div class="k"><span>Sharpe aprox</span><strong class="mono">' + esc(num(sharpe.value, 3)) + "</strong></div>";
    if (dd) lb += '<div class="k"><span>Drawdown máximo</span><strong class="mono">' + esc((Number(dd.value) * 100).toFixed(2)) + "%</strong></div>";
    if (mt) lb += '<div class="k"><span>Trades analizados</span><strong class="mono">' + esc(mt.value) + "</strong></div>";
    var dcc = latestByField(MO, "driftCount");
    if (dcc) lb += '<div class="k"><span>Activos en drift</span><strong class="mono">' + esc(dcc.value) + "</strong></div>";
    $("learnBox").innerHTML = lb || '<div class="empty">Acumulando muestra (20–50 trades por activo).</div>';
    // Events
    var eh = "";
    E.slice(0, 8).forEach(function (r) {
      eh += '<div class="row"><div class="l">' + esc(r.value || "") + '</div><div class="r small dim">' + esc(tshort(r.time)) + "</div></div>";
    });
    $("eventList").innerHTML = eh || '<div class="empty">Sin eventos.</div>';
    // Feeds
    var py = latestByField(H, "pyth"), bi = latestByField(H, "binance"), fx = latestByField(H, "fx");
    function st(v) { return (v && (v.value === "1" || v.value === 1)) ? '<span class="up">OK</span>' : '<span class="down">CAÍDO</span>'; }
    $("feedBox").innerHTML =
      '<div class="k"><span>Pyth</span><strong>' + st(py) + "</strong></div>" +
      '<div class="k"><span>Binance</span><strong>' + st(bi) + "</strong></div>" +
      '<div class="k"><span>FX</span><strong>' + st(fx) + "</strong></div>";
    renderPrices();
  }

  var SYMS = ["ORO", "YEN", "EURO", "BITCOIN", "SOLANA", "SUI", "SP500", "NASDAQ100"];
  function renderPrices() {
    var html = "", any = false;
    SYMS.forEach(function (s) {
      var L = livePx[s];
      if (!L) return; any = true;
      html += '<div class="row" id="pr-' + s + '"><div class="l"><span class="sym">' + esc(initials(s)) + "</span><span>" + esc(s) +
        '<div><canvas id="sp-' + s + '" width="96" height="28" style="width:96px;height:28px"></canvas></div></span></div>' +
        '<div class="r mono" id="pxv-' + s + '">$' + esc(num(L.price, 4)) + '<div class="small dim" id="pxa-' + s + '">' + esc(agoT(L.at)) + "</div></div></div>";
    });
    $("priceList").innerHTML = html || '<div class="empty">Esperando primer tick de precios…</div>';
    SYMS.forEach(drawSpark);
    $("pxSrc").textContent = pxSrc === "—" ? "" : "· fuente " + pxSrc;
  }
  function fastPrices() {
    SYMS.forEach(function (s) {
      var L = livePx[s]; if (!L) return;
      var el = $("pxv-" + s);
      if (el) {
        var prev = el.getAttribute("data-p");
        el.innerHTML = "$" + esc(num(L.price, 4)) + '<div class="small dim" id="pxa-' + s + '">' + esc(agoT(L.at)) + "</div>";
        if (prev && Number(prev) !== L.price) {
          var row = $("pr-" + s);
          row.style.background = L.price > Number(prev) ? "rgba(22,163,74,.12)" : "rgba(220,38,38,.12)";
          setTimeout((function (rr) { return function () { rr.style.background = ""; }; })(row), 700);
        }
        el.setAttribute("data-p", L.price);
      }
      drawSpark(s);
    });
    lastOpen.forEach(function (o) {
      var u = upnlOf(o), el = $("upnl-" + o.asset);
      if (el && u != null) el.innerHTML = '<span class="' + (u >= 0 ? "up" : "down") + '">' + (u >= 0 ? "▲ " : "▼ ") + esc(money(u, 4)) + "</span>";
    });
  }

  // SSE directo a Hermes; fallback a Worker REST
  var es = null, esDead = null;
  function sseStart() {
    try { if (es) es.close(); } catch (e) {}
    try {
      es = new EventSource("https://hermes.pyth.network/v2/updates/price/stream?ids[]=" +
        ["765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
         "ef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52",
         "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
         "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
         "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
         "23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
         "19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5",
         "9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d"].join("&ids[]=") + "&parsed=true");
    } catch (e) { sseFallback(); return; }
    var got = false;
    es.onmessage = function (ev) {
      try {
        var arr = JSON.parse(ev.data);
        (Array.isArray(arr) ? arr : []).forEach(function (f) {
          if (!f || !f.id || !f.price) return;
          var sym = id2sym(String(f.id).toLowerCase());
          if (!sym) return;
          var px = Number(f.price.price) * Math.pow(10, Number(f.price.expo));
          if (!Number.isFinite(px)) return;
          pushPx(sym, px);
          got = true;
        });
        if (got) { pxSrc = "SSE directo"; lastOkPx = Date.now(); fastPrices(); }
      } catch (e) {}
    };
    es.onerror = function () { try { es.close(); } catch (e) {} sseFallback(); };
    esDead = setTimeout(function () { if (!got) { try { es.close(); } catch (e) {} sseFallback(); } }, 12000);
  }
  function id2sym(id) {
    var m = {
      "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2": "ORO",
      "ef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52": "YEN",
      "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b": "EURO",
      "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43": "BITCOIN",
      "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d": "SOLANA",
      "23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744": "SUI",
      "19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5": "SP500",
      "9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d": "NASDAQ100"
    };
    return m[id] || null;
  }
  function pushPx(sym, px) {
    livePx[sym] = { price: px, at: Date.now() };
    var b = pxBuf[sym] || (pxBuf[sym] = []);
    b.push(px); if (b.length > BUFN) b.shift();
  }
  var restPxTimer = null;
  function sseFallback() {
    if (restPxTimer) return;
    pxSrc = pxSrc === "SSE directo" ? pxSrc : "puente";
    function poll() {
      if (!BASE || !KEY) return;
      fetch(BASE + "/api/pyth?key=" + encodeURIComponent(KEY), { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw 0; return r.json(); })
        .then(function (j) {
          if (!j || !j.ok || !j.prices) throw 0;
          Object.keys(j.prices).forEach(function (s) {
            var p = Number(j.prices[s].price);
            if (Number.isFinite(p)) pushPx(s, p);
          });
          pxSrc = "puente·" + (j.src || "?");
          lastOkPx = Date.now();
          fastPrices();
        }).catch(function () {});
    }
    poll();
    restPxTimer = setInterval(poll, 5000);
  }

  function tickSnap() {
    if (!BASE || !KEY) {
      $("age").textContent = "falta configuración";
      lastHttp = "sin backend"; diag(); return;
    }
    fetch(BASE + "/api/snapshot?key=" + encodeURIComponent(KEY), { cache: "no-store" })
      .then(function (r) { lastHttp = "HTTP " + r.status; if (!r.ok) throw 0; return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw 0;
        lastOkSnap = Date.now(); lastServer = j.serverTime || "—";
        $("age").textContent = "en vivo · " + new Date(lastOkSnap).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        $("liveDot").className = "dot live";
        $("livePill").style.background = "rgba(74,222,128,.18)";
        $("stale").classList.add("hidden");
        renderSnap(j.data); diag();
      })
      .catch(function () {
        lastHttp = "red/CORS?";
        $("liveDot").className = "dot stale";
        if (lastOkSnap) {
          $("stale").classList.remove("hidden");
          $("staleAt").textContent = new Date(lastOkSnap).toLocaleTimeString("es");
          $("age").textContent = "reintentando… última OK " + agoT(lastOkSnap);
        } else { $("age").textContent = "sin conexión (" + lastHttp + ")"; }
        diag();
      });
  }
  diag(); tickSnap(); sseStart();
  setInterval(tickSnap, POLL_SNAP);
  setInterval(function () {
    if (!lastOkSnap && !lastOkPx) return;
    var ref = Math.max(lastOkSnap, lastOkPx);
    var old = Date.now() - ref > STALE_MS;
    $("liveDot").className = "dot " + (old ? "stale" : "live");
    $("stale").classList.toggle("hidden", !old);
    if (old) $("staleAt").textContent = new Date(ref).toLocaleTimeString("es");
  }, 5000);
})();
