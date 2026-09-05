/* Sentinel PWA — motor de lectura y render. Sin dependencias. */
(function () {
  "use strict";
  var cfg = (window.SENTINEL || {});
  var BASE = String(cfg.worker || "").replace(/\/+$/, "");
  var KEY = String(cfg.key || "");
  var POLL = 25000, STALE_MS = 90000;
  var lastOk = 0, lastData = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function num(v, d) { var n = Number(v); return Number.isFinite(n) ? n.toFixed(d == null ? 2 : d) : "—"; }
  function money(v, d) { var n = Number(v); if (!Number.isFinite(n)) return "—"; return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(d == null ? 2 : d); }
  function ago(ts) { var t = Date.parse(ts); if (!t) return "—"; var s = Math.max(0, (Date.now() - t) / 1000); if (s < 60) return "hace " + Math.floor(s) + "s"; if (s < 3600) return "hace " + Math.floor(s / 60) + "m"; return "hace " + Math.floor(s / 3600) + "h"; }
  function tshort(ts) { var t = new Date(Date.parse(ts)); return isNaN(t) ? "—" : t.toLocaleString("es", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }

  // Tabs
  var tabs = document.querySelectorAll(".tabbar button");
  tabs.forEach(function (b) {
    b.addEventListener("click", function () {
      tabs.forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
      $("view-" + b.getAttribute("data-view")).classList.add("active");
    });
  });
  // Copy commands
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
  function firstPerTag(list, tag) {
    var seen = {}, out = [];
    var sorted = list.slice().sort(function (a, b) { return a.time < b.time ? 1 : -1; });
    sorted.forEach(function (r) {
      var k = (r.tags && r.tags[tag]) || "";
      if (k && !seen[k]) { seen[k] = 1; out.push(r); }
    });
    return out;
  }

  function render(d) {
    var H = rows(d, "health"), P = rows(d, "positions"), T = rows(d, "trades"),
        D = rows(d, "dl"), M = rows(d, "market"), E = rows(d, "events"), MO = rows(d, "monitor");
    // Header
    var bal = latestByField(H, "balance"), op = latestByField(H, "open"), pa = latestByField(H, "paused");
    var balN = bal ? Number(bal.value) : NaN;
    $("cBalance").textContent = Number.isFinite(balN) ? "$" + balN.toFixed(2) : "—";
    $("cPnl").textContent = Number.isFinite(balN) ? "PnL " + money(balN - 15) + " vs inicio $15" : "—";
    $("cPnl").className = "sub mono " + ((balN - 15) >= 0 ? "up" : "down");
    $("cOpen").textContent = op ? op.value : "—";
    var paused = pa && (pa.value === "1" || pa.value === 1 || pa.value === true);
    $("cPaused").textContent = paused ? "Nuevas entradas PAUSADAS" : "Operando";
    $("cPaused").className = "sub " + (paused ? "warn" : "up");
    // Monitor
    var sharpe = latestByField(MO, "sharpe"), dd = latestByField(MO, "maxDrawdownPct"),
        mt = latestByField(MO, "trades"), mp = latestByField(MO, "totalPnl"), dc = latestByField(MO, "driftCount");
    $("cSharpe").textContent = sharpe ? num(sharpe.value, 3) : "—";
    $("cTrades").textContent = mt ? ("sobre " + mt.value + " trades") : "acumulando muestra";
    $("cDd").textContent = dd ? (Number(dd.value) * 100).toFixed(2) + "%" : "—";
    var driftTxt = "drift: ninguno";
    MO.forEach(function (r) { if (r.field === "drifting" && r.value && r.value !== '""') driftTxt = "drift: " + String(r.value).replace(/"/g, ""); });
    $("cDrift").textContent = driftTxt + (mp ? (" | PnL mon " + money(mp.value)) : "");
    // Open positions: agrupa el lote más reciente por tiempo
    var openHtml = "";
    var openRows = P.filter(function (r) { return r.tags && r.tags.is_open === "true"; })
      .sort(function (a, b) { return a.time < b.time ? 1 : -1; }).slice(0, 12);
    var bySym = {};
    openRows.forEach(function (r) { var s = r.tags.symbol || "?"; (bySym[s] = bySym[s] || []).push(r); });
    Object.keys(bySym).forEach(function (s) {
      var g = {}; bySym[s].forEach(function (r) { g[r.field] = r.value; });
      openHtml += '<div class="row"><div class="l">' + esc(s) + ' <span class="mut small">' + esc(g.direction || "") + '</span><div class="small dim">@ $' + esc(g.entry || "?") + " × " + esc(g.size || "?") + "</div></div>" +
        '<div class="r small mut">' + esc((bySym[s][0].time || "").slice(11, 16)) + " UTC</div></div>";
    });
    $("openList").innerHTML = openHtml || '<div class="empty">Sin posiciones abiertas.</div>';
    // trades llegan como filas por campo; reagrupar por tiempo+symbol
    var groups = {};
    T.forEach(function (r) {
      var k = r.time + "|" + ((r.tags && r.tags.symbol) || "");
      if (!groups[k]) groups[k] = { time: r.time, sym: (r.tags && r.tags.symbol) || "?", f: {} };
      groups[k].f[r.field] = r.value;
    });
    var gk = Object.keys(groups).sort().reverse().slice(0, 6);
    var ch = "";
    gk.forEach(function (k) {
      var g = groups[k], p = Number(g.f.pnl);
      var cls = p >= 0 ? "up" : "down", arrow = p >= 0 ? "▲" : "▼";
      ch += '<div class="row"><div class="l">' + esc(g.sym) + ' <span class="mut small">' + esc(g.f.direction || "") + " · " + esc(g.f.reason || "") + '</span><div class="small dim">' + esc(tshort(g.time)) + "</div></div>" +
        '<div class="r mono ' + cls + '">' + arrow + " " + esc(money(p, 4)) + "</div></div>";
    });
    $("recentClosed").innerHTML = ch || '<div class="empty">Sin cierres registrados.</div>';
    // Full history tab
    var hk = Object.keys(groups).sort().reverse().slice(0, 15), hh = "";
    hk.forEach(function (k) {
      var g = groups[k], p = Number(g.f.pnl);
      var cls = p >= 0 ? "up" : "down", arrow = p >= 0 ? "▲" : "▼";
      hh += '<div class="row"><div class="l">' + esc(g.sym) + ' <span class="mut small">' + esc(g.f.direction || "") + " · " + esc(g.f.reason || "") + " · " + esc(g.f.scratch === "1" ? "scratch" : "") + '</span><div class="small dim">' + esc(tshort(g.time)) + "</div></div>" +
        '<div class="r mono ' + cls + '">' + arrow + " " + esc(money(p, 4)) + "</div></div>";
    });
    $("tradeHist").innerHTML = hh || '<div class="empty">Sin historial.</div>';
    // DL per symbol (score + latencia)
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
      dh += '<div class="row"><div class="l">' + esc(s) + '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, v)).toFixed(0) + '%"></i></div></div>' +
        '<div class="r mono ' + cls + '">' + v.toFixed(1) + '%<div class="small dim">' + esc(lat) + "</div></div></div>";
    });
    $("dlList").innerHTML = dh || '<div class="empty">Sin señales.</div>';
    // Learn box
    var lb = "";
    if (sharpe) lb += '<div class="k"><span>Sharpe aprox</span><strong class="mono">' + esc(num(sharpe.value, 3)) + "</strong></div>";
    if (dd) lb += '<div class="k"><span>Drawdown máximo</span><strong class="mono">' + esc((Number(dd.value) * 100).toFixed(2)) + "%</strong></div>";
    if (mt) lb += '<div class="k"><span>Trades analizados</span><strong class="mono">' + esc(mt.value) + "</strong></div>";
    if (dc) lb += '<div class="k"><span>Activos en drift</span><strong class="mono">' + esc(dc.value) + "</strong></div>";
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
    // Prices
    var pr = {}, ph = "";
    M.forEach(function (r) {
      var s = (r.tags && r.tags.symbol) || "";
      if (s && r.field === "price" && (!pr[s] || r.time > pr[s].time)) pr[s] = r;
    });
    Object.keys(pr).sort().forEach(function (s) {
      ph += '<div class="row"><div class="l">' + esc(s) + '</div><div class="r mono">$' + esc(num(pr[s].value, 4)) + '<div class="small dim">' + esc(ago(pr[s].time)) + "</div></div></div>";
    });
    $("priceList").innerHTML = ph || '<div class="empty">Sin precios.</div>';
  }

  function tick() {
    if (!BASE || !KEY) { $("age").textContent = "falta configuración"; return; }
    fetch(BASE + "/api/snapshot?key=" + encodeURIComponent(KEY), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw 0;
        lastOk = Date.now(); lastData = j.data;
        $("age").textContent = "en vivo · " + new Date(lastOk).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        $("liveDot").className = "dot live";
        $("stale").classList.add("hidden");
        render(j.data);
      })
      .catch(function () {
        $("liveDot").className = "dot stale";
        if (lastOk) {
          $("stale").classList.remove("hidden");
          $("staleAt").textContent = new Date(lastOk).toLocaleTimeString("es");
          $("age").textContent = "reintentando… última OK " + ago(new Date(lastOk).toISOString());
        } else { $("age").textContent = "sin conexión"; }
      });
  }
  tick();
  setInterval(tick, POLL);
  setInterval(function () {
    if (!lastOk) return;
    var old = Date.now() - lastOk > STALE_MS;
    $("liveDot").className = "dot " + (old ? "stale" : "live");
    $("stale").classList.toggle("hidden", !old);
    if (old) $("staleAt").textContent = new Date(lastOk).toLocaleTimeString("es");
  }, 5000);
})();
