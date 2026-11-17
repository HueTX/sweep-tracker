/* Sweep Tracker — standalone client (rewritten 2026-11-16 for Sweep v5).
 *
 * The ONLY display model is the engine's published projection:
 * view.json (headline, pill, run, counts, today, stages, lanes, titles,
 * controls, filer_queue, rules, note, now_viewing), lists.json (today's
 * filings / parked / rejected, lane companies), control.json (acks) and
 * heartbeat.json (latch, filing alerts). Every number rendered traces to
 * a field in those files. Nothing is derived client-side beyond a bar's
 * fill share (searched/total, identical to the printed counts) and a
 * lane's remaining-family count (total - searched, the two printed
 * numbers). Lanes rendered = controls.scoped_lanes only, in that order,
 * with the projection's own per-lane families_searched/families_total.
 *
 * Controls: taps are queued locally, then written to control-requests.json
 * in HueTX/sweep-tracker via the GitHub Contents API as
 * {pending: [{id, action, args, requested_at}]}, using the reader's own
 * token from the on-page field (localStorage key sweepTrackerGhToken —
 * never embedded in this page, never sent anywhere but api.github.com).
 * A tap reads "Requested" until its own id appears in the published
 * acks (control.json acks / view.controls.acks). */
(function () {
  "use strict";

  var REPO = "HueTX/sweep-tracker";
  var RAW = "https://raw.githubusercontent.com/" + REPO + "/main/";
  var CDN = "https://cdn.jsdelivr.net/gh/" + REPO + "@main/";
  var CONTROL_API = "https://api.github.com/repos/" + REPO + "/contents/control-requests.json";
  var TOKEN_KEY = "sweepTrackerGhToken";
  var REQUESTS_KEY = "sweepTrackerRequestsV1";
  var THEME_KEY = "sweepTrackerTheme";
  var POLL_MS = 60000;

  var state = {
    view: null, lists: null, control: null, heartbeat: null,
    viewStamp: null, tab: "filings", sourceFilter: null, openLane: null
  };

  /* ---------- tiny DOM helpers (textContent only; no HTML injection) ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString("en-US", { timeZone: "America/Chicago",
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";
  }
  function fmtClock(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString("en-US", { timeZone: "America/Chicago",
      hour: "numeric", minute: "2-digit" }) + " CT";
  }

  /* ---------- data fetching ---------- */
  async function fetchJson(name) {
    var bust = "?x=" + Date.now();
    try {
      var r = await fetch(RAW + name + bust, { cache: "no-store" });
      if (r.ok) return await r.json();
      throw new Error("raw " + r.status);
    } catch (e) {
      var r2 = await fetch(CDN + name + bust, { cache: "no-store" });
      if (!r2.ok) throw new Error("fetch " + name + " failed");
      return await r2.json();
    }
  }
  async function refresh() {
    try {
      var res = await Promise.all([
        fetchJson("view.json"), fetchJson("lists.json"),
        fetchJson("control.json"), fetchJson("heartbeat.json")
      ]);
      state.view = res[0]; state.lists = res[1];
      state.control = res[2]; state.heartbeat = res[3];
      reconcileAcks();
      render();
    } catch (e) {
      $("freshness").textContent = "Could not load tracker data — retrying…";
    }
  }

  /* ---------- control requests: local log, outbox, acks ---------- */
  function loadRequests() {
    try {
      var p = JSON.parse(localStorage.getItem(REQUESTS_KEY) || "[]");
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }
  function saveRequests(list) {
    try { localStorage.setItem(REQUESTS_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function getToken() {
    var t = localStorage.getItem(TOKEN_KEY);
    return t && String(t).trim() ? String(t).trim() : null;
  }
  function makeId() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return "ctrl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  function queueRequest(action, args, label) {
    var id = makeId();
    var now = new Date().toISOString();
    var fullArgs = Object.assign({}, args, { id: id, requested_at: now });
    var rec = { id: id, action: action, args: fullArgs, requested_at: now,
                label: label, written: false, acked: false, effect: null };
    var list = loadRequests();
    list.push(rec);
    saveRequests(list);
    renderPending();
    flushOutbox();
    return rec;
  }
  function ghHeaders(token) {
    return { "Authorization": "Bearer " + token,
             "Accept": "application/vnd.github+json",
             "X-GitHub-Api-Version": "2022-11-28" };
  }
  function b64enc(s) { return window.btoa(unescape(encodeURIComponent(s))); }
  function b64dec(s) { return decodeURIComponent(escape(window.atob(String(s || "").replace(/\s/g, "")))); }

  var flushing = false;
  async function flushOutbox() {
    if (flushing) return;
    var pending = loadRequests().filter(function (r) { return !r.written; });
    if (!pending.length) { renderPending(); return; }
    var token = getToken();
    if (!token) {
      setControlStatus("Add your GitHub token below so controls can be sent.", true);
      $("token-input").focus();
      renderPending();
      return;
    }
    flushing = true;
    try {
      for (var attempt = 0; attempt < 2; attempt++) {
        var getRes = await fetch(CONTROL_API + "?ref=main",
          { cache: "no-store", headers: ghHeaders(token) });
        if (!getRes.ok) throw new Error("GitHub read failed (" + getRes.status + ")");
        var file = await getRes.json();
        var doc = { pending: [] };
        try { doc = JSON.parse(b64dec(file.content)); } catch (e) {}
        if (!doc || !Array.isArray(doc.pending)) doc = { pending: [] };
        var have = {};
        doc.pending.forEach(function (e) { if (e && e.id) have[e.id] = true; });
        pending.forEach(function (r) {
          if (!have[r.id]) doc.pending.push(
            { id: r.id, action: r.action, args: r.args, requested_at: r.requested_at });
        });
        var putRes = await fetch(CONTROL_API, {
          method: "PUT", headers: ghHeaders(token),
          body: JSON.stringify({
            message: "Tracker control request from standalone page",
            content: b64enc(JSON.stringify(doc, null, 1)),
            sha: file.sha
          })
        });
        if (putRes.ok) {
          var list = loadRequests();
          pending.forEach(function (p) {
            var rec = list.filter(function (r) { return r.id === p.id; })[0];
            if (rec) rec.written = true;
          });
          saveRequests(list);
          setControlStatus("Request sent — waiting for the sweep to confirm.", false);
          flushing = false;
          renderPending();
          return;
        }
        if (putRes.status !== 409 && putRes.status !== 422) {
          throw new Error("GitHub write failed (" + putRes.status + ")");
        }
        /* sha conflict: loop re-reads and re-merges once */
      }
      throw new Error("GitHub write conflicted twice — tap again to retry.");
    } catch (e) {
      setControlStatus("Control not sent: " + e.message + " The request stays queued and will retry on the next tap or reload.", true);
    }
    flushing = false;
    renderPending();
  }
  function reconcileAcks() {
    var acks = {};
    [state.control && state.control.acks,
     state.view && state.view.controls && state.view.controls.acks]
      .forEach(function (arr) {
        if (Array.isArray(arr)) arr.forEach(function (a) { if (a && a.id) acks[a.id] = a.effect || ""; });
      });
    var list = loadRequests();
    var changed = false;
    list.forEach(function (r) {
      if (!r.acked && acks[r.id] !== undefined) {
        r.acked = true; r.effect = acks[r.id]; changed = true;
      }
    });
    /* An acked record retires on the poll after its ack was first shown. */
    var before = list.length;
    list = list.filter(function (r) { return !(r.acked && r.ackSeen); });
    list.forEach(function (r) { if (r.acked && !r.ackSeen) { r.ackSeen = true; changed = true; } });
    if (changed || list.length !== before) saveRequests(list);
  }
  function setControlStatus(msg, isError) {
    var n = $("control-status");
    n.textContent = msg || "";
    n.className = "control-status" + (isError ? " error" : "");
  }
  function renderPending() {
    var wrap = $("pending-list");
    clear(wrap);
    loadRequests().forEach(function (r) {
      var row = el("div", "pending-item" + (r.acked ? " acked" : ""));
      row.appendChild(el("span", null, r.label));
      row.appendChild(el("span", null,
        r.acked ? ("Received — " + (r.effect || "applied")) : "Requested"));
      wrap.appendChild(row);
    });
  }

  /* ---------- rendering ---------- */
  var STAGE_LABELS = {
    started: "Cycle opened", prep: "Preparation",
    sector_search: "Employer & board search", sector_filing: "Filing queue",
    stall_watch: "Stall watch", quality_check: "Quality check", delivered: "Delivered"
  };
  function chipFor(state) { return "chip chip-" + String(state || "pending").replace(/\s+/g, "-"); }

  function render() {
    var v = state.view;
    if (!v) return;
    if (state.viewStamp === v.generated_at && state.renderedOnce) { renderPending(); return; }
    state.viewStamp = v.generated_at;
    state.renderedOnce = true;

    /* Header: headline + pill + note, all verbatim from the projection */
    $("headline-label").textContent = (v.headline && v.headline.label) || "";
    var dot = document.querySelector("#headline .dot");
    var hs = (v.headline && v.headline.state) || "";
    dot.className = "dot " + (hs === "in-progress" || hs === "active" ? "dot-live"
      : hs === "stalled" ? "dot-stalled"
      : (hs === "complete" || hs === "done") ? "dot-done" : "dot-idle");
    $("freshness").textContent = "Updated " + fmtTime(v.generated_at);

    var pillRow = $("pill-row");
    clear(pillRow);
    var pills = Array.isArray(v.pill) ? v.pill : [];
    if (!pills.length && v.now_viewing && v.now_viewing.live) {
      pills = [{ primary: v.now_viewing.headline, detail: v.now_viewing.detail }];
    }
    pills.forEach(function (p) {
      var pill = el("span", "now-pill", p.primary || "");
      if (p.detail) pill.appendChild(el("span", "pill-detail", p.detail));
      pillRow.appendChild(pill);
    });
    $("note-line").textContent = v.note || "";

    /* Filing alerts (heartbeat) — only when the engine raises any */
    var alerts = $("alerts");
    clear(alerts);
    var fa = state.heartbeat && state.heartbeat.filing_alerts;
    if (Array.isArray(fa) && fa.length) {
      fa.forEach(function (a) {
        alerts.appendChild(el("div", "alert-strip",
          typeof a === "string" ? a : JSON.stringify(a)));
      });
    }

    renderControls(v);
    renderProgress(v);
    renderToday(v);
    renderStages(v);
    renderLanes(v);
    renderTitles(v);
    renderFiler(v);
    renderSources(v);
    renderTable();
    renderRules(v);
    renderPending();
    $("foot-line").textContent =
      "Sweep state: " + ((v.controls && v.controls.sweep_state) || "—") +
      " · Data generated " + fmtTime(v.generated_at) +
      (state.heartbeat ? " · Last activity " + fmtTime(state.heartbeat.last_disposition_at) : "");
  }

  function renderControls(v) {
    var chip = $("sweep-state");
    var s = (v.controls && v.controls.sweep_state) || "";
    chip.textContent = s;
    chip.className = chipFor(s === "running" ? "searching" : s === "stopped" ? "stopped" : "pending");
    var input = $("token-input");
    if (getToken()) {
      input.placeholder = "Token saved in this browser — paste a new one to replace it";
      $("token-hint").textContent = "A token is saved in this browser. Controls will send immediately.";
    }
  }

  function renderProgress(v) {
    var run = v.run || {};
    var prog = run.progress || {};
    var pct = (typeof prog.pct === "number") ? prog.pct : 0;
    var ring = $("ring");
    ring.style.background = "conic-gradient(var(--accent) " + pct + "%, var(--track) " + pct + "%)";
    $("ring-pct").textContent = pct + "%";
    $("prog-units").textContent =
      (prog.covered_units != null ? prog.covered_units : "–") + " / " +
      (prog.total_units != null ? prog.total_units : "–");
    $("prog-families").textContent =
      (run.families_covered != null ? run.families_covered : "–") + " / " +
      (run.families_total != null ? run.families_total : "–");
    $("run-started").textContent = run.started_at ? ("Started " + fmtTime(run.started_at)) : "";
  }

  function statBlock(num, lbl) {
    var d = el("div", "stat");
    d.appendChild(el("span", "num", String(num != null ? num : "–")));
    d.appendChild(el("span", "lbl", lbl));
    return d;
  }
  function renderToday(v) {
    var t = v.today || {};
    $("today-date").textContent = t.date || "";
    var row = $("today-stats");
    clear(row);
    row.appendChild(statBlock(t.evaluated, "Evaluated"));
    row.appendChild(statBlock(t.filed, "Filed"));
    row.appendChild(statBlock(statOrZero(t.parked), "Parked"));
    row.appendChild(statBlock(t.rejected, "Rejected"));
    var c = v.counts || {};
    var row2 = $("cycle-stats");
    clear(row2);
    row2.appendChild(statBlock(c.evaluated, "Evaluated"));
    row2.appendChild(statBlock(c.filed, "Filed"));
    row2.appendChild(statBlock(c.parked, "Parked"));
    row2.appendChild(statBlock(c.rejected, "Rejected"));
  }
  function statOrZero(x) { return x == null ? 0 : x; }

  function renderStages(v) {
    var list = $("stages-list");
    clear(list);
    var stages = v.stages || {};
    var scoped = (v.controls && v.controls.scoped_lanes) || [];
    var linkedinInScope = scoped.indexOf("LinkedIn") !== -1;
    Object.keys(stages).forEach(function (key) {
      if (!linkedinInScope && (key === "linkedin_discovery" || key === "linkedin_filing")) return;
      var s = stages[key] || {};
      var li = el("li");
      li.appendChild(el("span", "stage-name", STAGE_LABELS[key] || key.replace(/_/g, " ")));
      li.appendChild(el("span", "stage-detail", s.detail || ""));
      li.appendChild(el("span", chipFor(s.state), s.state || ""));
      list.appendChild(li);
    });
  }

  function renderLanes(v) {
    var grid = $("lane-grid");
    clear(grid);
    var scoped = (v.controls && v.controls.scoped_lanes) || [];
    var lanes = v.lanes || {};
    var searching = v.searching_lanes || [];
    var priorities = (v.controls && v.controls.priority_lanes) || [];
    $("lanes-sub").textContent = scoped.length + " lanes in this sweep";
    scoped.forEach(function (id) {
      var lane = lanes[id];
      if (!lane) return;
      var card = el("div", "lane-card" + (searching.indexOf(id) !== -1 ? " searching-now" : ""));
      var top = el("div", "lane-top");
      top.appendChild(el("span", "lane-name", lane.label || id));
      top.appendChild(el("span", chipFor(lane.phase), lane.phase || ""));
      card.appendChild(top);
      card.appendChild(el("div", "lane-titles",
        "Titles " + lane.families_searched + "/" + lane.families_total));
      var bar = el("div", "bar");
      var fill = el("i");
      var share = lane.families_total ? (lane.families_searched / lane.families_total) * 100 : 0;
      fill.style.width = share + "%";
      bar.appendChild(fill);
      card.appendChild(bar);
      card.appendChild(el("div", "lane-detail-line", lane.detail || ""));
      card.appendChild(el("div", "lane-current",
        lane.current_family ? ("Now: " + lane.current_family) : (lane.current || "")));
      var actions = el("div", "lane-actions");
      var star = el("button", "btn btn-small star-btn" + (priorities.indexOf(id) !== -1 ? " on" : ""), "★");
      star.type = "button";
      star.title = "Toggle priority for this lane";
      star.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var isP = ((state.view.controls && state.view.controls.priority_lanes) || []).indexOf(id) !== -1;
        queueRequest("lanecontrol",
          { type: "priority", lane: id, desired: !isP },
          (isP ? "Remove priority — " : "Prioritize — ") + (lane.label || id));
      });
      var restart = el("button", "btn btn-small", "Restart this search");
      restart.type = "button";
      restart.addEventListener("click", function (ev) {
        ev.stopPropagation();
        queueRequest("lanecontrol",
          { type: "restart", lane: id },
          "Restart — " + (lane.label || id));
      });
      actions.appendChild(star);
      actions.appendChild(restart);
      card.appendChild(actions);
      card.addEventListener("click", function () {
        state.openLane = state.openLane === id ? null : id;
        renderLaneDetail();
      });
      grid.appendChild(card);
    });
    renderLaneDetail();
  }

  function renderLaneDetail() {
    var box = $("lane-detail");
    var id = state.openLane;
    var v = state.view;
    if (!id || !v) { box.hidden = true; clear(box); return; }
    var lane = (v.lanes || {})[id];
    if (!lane) { box.hidden = true; return; }
    box.hidden = false;
    clear(box);
    box.appendChild(el("h3", null, lane.label || id));
    var facts = el("p");
    facts.textContent =
      "Phase: " + (lane.phase || "—") +
      " · Titles searched " + lane.families_searched + " of " + lane.families_total +
      " · " + (lane.families_total - lane.families_searched) + " remaining" +
      (lane.detail ? " · " + lane.detail : "") +
      (lane.heartbeat_at ? " · Last activity " + fmtTime(lane.heartbeat_at) : "");
    box.appendChild(facts);
    var companies = (state.lists && state.lists.lane_companies &&
                     state.lists.lane_companies[id]) || [];
    if (companies.length) {
      box.appendChild(el("p", "sub", "Employers in this lane (" + companies.length + "):"));
      var chips = el("div", "company-chips");
      companies.forEach(function (c) { chips.appendChild(el("span", null, c)); });
      box.appendChild(chips);
    }
  }

  function renderTitles(v) {
    var t = v.titles || {};
    $("titles-sub").textContent =
      (t.searched != null ? t.searched : "–") + " of " + (t.total != null ? t.total : "–") + " families searched";
    var wrap = $("title-chips");
    clear(wrap);
    var fams = t.families || {};
    Object.keys(fams).forEach(function (name) {
      wrap.appendChild(el("span", "tchip " + String(fams[name]).replace(/\s+/g, "-"), name));
    });
  }

  function renderFiler(v) {
    var q = Array.isArray(v.filer_queue) ? v.filer_queue : [];
    $("filer-sub").textContent = q.length ? (q.length + " owed") : "Nothing owed";
    var wrap = $("filer-list");
    clear(wrap);
    if (!q.length) { wrap.appendChild(el("p", "empty-line", "No filings are waiting.")); return; }
    q.forEach(function (e) {
      var row = el("div", "filer-row");
      var main = el("div", "filer-main");
      main.appendChild(el("span", "co", e.employer || ""));
      main.appendChild(document.createTextNode(" — " + (e.title || "")));
      row.appendChild(main);
      var meta = [];
      if (e.where) meta.push(e.where);
      if (e.attempts) meta.push("attempts: " + e.attempts);
      if (e.deadline) meta.push("deadline: " + e.deadline);
      if (meta.length) row.appendChild(el("span", "filer-meta", meta.join(" · ")));
      row.appendChild(el("span", chipFor(e.blocker ? "queued" : "pass"),
        e.blocker || e.status || ""));
      wrap.appendChild(row);
    });
  }

  function renderSources(v) {
    var wrap = $("source-rows");
    clear(wrap);
    var by = (v.today && v.today.filed_by_source) || {};
    var names = Object.keys(by);
    if (!names.length) {
      wrap.appendChild(el("p", "empty-line", "No filings yet today."));
      return;
    }
    names.forEach(function (src) {
      var row = el("button", "source-row");
      row.type = "button";
      row.appendChild(el("span", null, src));
      row.appendChild(el("span", "source-count", String(by[src])));
      row.addEventListener("click", function () {
        state.tab = "filings";
        state.sourceFilter = src;
        syncTabs();
        renderTable();
      });
      wrap.appendChild(row);
    });
  }

  function syncTabs() {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === state.tab);
    });
  }

  function flatten(bySource) {
    var out = [];
    Object.keys(bySource || {}).forEach(function (src) {
      (bySource[src] || []).forEach(function (e) {
        out.push(Object.assign({ _source: src }, e));
      });
    });
    return out;
  }

  function renderTable() {
    var wrap = $("table-wrap");
    clear(wrap);
    var lists = state.lists || {};
    var rows, kind = state.tab;
    if (kind === "filings") {
      var bySrc = lists.today_filings || {};
      if (state.sourceFilter && bySrc[state.sourceFilter]) {
        rows = (bySrc[state.sourceFilter] || []).map(function (e) {
          return Object.assign({ _source: state.sourceFilter }, e);
        });
        var note = el("p", "sub", "Showing filings filed via " + state.sourceFilter + " — ");
        var all = el("a", null, "show all");
        all.href = "#";
        all.addEventListener("click", function (ev) {
          ev.preventDefault(); state.sourceFilter = null; renderTable();
        });
        note.appendChild(all);
        wrap.appendChild(note);
      } else {
        rows = flatten(bySrc);
      }
    } else if (kind === "parked") {
      rows = flatten(lists.today_parked);
    } else {
      rows = flatten(lists.today_rejected);
    }
    if (!rows.length) {
      wrap.appendChild(el("p", "empty-line",
        kind === "filings" ? "Nothing filed yet today." :
        kind === "parked" ? "Nothing parked today." : "Nothing rejected today."));
      return;
    }
    var table = el("table");
    var thead = el("tr");
    var cols = kind === "filings"
      ? ["Company", "Role", "Where filed", "Time"]
      : ["Company", "Role", "Source", "Reason", "Time"];
    cols.forEach(function (c) { thead.appendChild(el("th", null, c)); });
    table.appendChild(thead);
    rows.forEach(function (e) {
      var tr = el("tr");
      tr.appendChild(el("td", null, e.company || ""));
      tr.appendChild(el("td", null, e.role || ""));
      if (kind === "filings") {
        tr.appendChild(el("td", null, e.where || e._source || ""));
      } else {
        tr.appendChild(el("td", null, e.where || e._source || ""));
        var rc = el("td", "reason", e.reason || "");
        rc.title = e.reason || "";
        tr.appendChild(rc);
      }
      tr.appendChild(el("td", null, e.time || ""));
      table.appendChild(tr);
    });
    wrap.appendChild(table);
  }

  function renderRules(v) {
    var body = $("rules-body");
    clear(body);
    var r = v.rules || {};
    var parts = [];
    if (typeof r.follow_all === "boolean") {
      parts.push("Follow all rules: <b>" + (r.follow_all ? "on" : "off") + "</b>");
    }
    if (Array.isArray(r.disabled_rule_ids) && r.disabled_rule_ids.length) {
      parts.push("Disabled: " + r.disabled_rule_ids.map(function (x) {
        return "<code>" + escapeHtml(x) + "</code>";
      }).join(", "));
    }
    if (Array.isArray(r.removed_rule_ids) && r.removed_rule_ids.length) {
      parts.push("Removed: " + r.removed_rule_ids.map(function (x) {
        return "<code>" + escapeHtml(x) + "</code>";
      }).join(", "));
    }
    if (parts.length) {
      var p = el("p");
      p.innerHTML = parts.join(" · ");
      body.appendChild(p);
    }
    (r.added_rules || []).forEach(function (rule) {
      var d = el("div");
      var name = el("p");
      var b = el("b", null, rule.name || rule.id || "Rule");
      name.appendChild(b);
      d.appendChild(name);
      if (rule.description) d.appendChild(el("p", "rule-desc", rule.description));
      body.appendChild(d);
    });
    if (!parts.length && !(r.added_rules || []).length) {
      body.appendChild(el("p", "empty-line", "No rule changes in effect."));
    }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- wiring ---------- */
  function init() {
    var savedTheme = null;
    try { savedTheme = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
    else if (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.setAttribute("data-theme", "dark");
    }
    $("theme-toggle").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", cur);
      try { localStorage.setItem(THEME_KEY, cur); } catch (e) {}
    });

    $("btn-token-save").addEventListener("click", function () {
      var val = $("token-input").value.trim();
      if (!val) { setControlStatus("Paste a token first.", true); return; }
      try { localStorage.setItem(TOKEN_KEY, val); } catch (e) {}
      $("token-input").value = "";
      setControlStatus("Token saved in this browser.", false);
      renderControls(state.view || { controls: {} });
      flushOutbox();
    });
    $("btn-token-clear").addEventListener("click", function () {
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
      $("token-input").value = "";
      setControlStatus("Token cleared from this browser.", false);
      renderControls(state.view || { controls: {} });
    });

    $("btn-start").addEventListener("click", function () {
      var lanes = (state.view && state.view.controls && state.view.controls.scoped_lanes) || [];
      queueRequest("sweepcontrol", { type: "start", lanes: lanes.slice() },
        "Start sweep (" + lanes.length + " lanes)");
    });
    $("btn-stop").addEventListener("click", function () {
      queueRequest("sweepcontrol", { type: "stop" }, "Stop sweep");
    });

    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () {
        state.tab = t.getAttribute("data-tab");
        if (state.tab !== "filings") state.sourceFilter = null;
        syncTabs();
        renderTable();
      });
    });

    renderPending();
    flushOutbox(); /* retry anything queued by a previous visit */
    refresh();
    setInterval(refresh, POLL_MS);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
