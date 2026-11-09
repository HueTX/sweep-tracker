/* Standalone data-source shim v2 — the data-source change from the
   live tracker. The page's bundle (assets/app.js, the retooled
   sweep-tracker artifact's client bundle, plus standalone
   patches, fixed 2026-11-06: a running sweep can never headline
   "Sweep complete" from lane/stage states alone; a present-tense
   activity headline can never contradict the master switch and
   the live pill requires the switch on; the titles pill, legend,
   family list and counts derive from the live view's own titles
   rather than the stale 48-family set or the today counter) talks to its
   backend by POSTing {action, args} to ./actions and reading {data}
   back. This shim answers those same calls in-page, over GitHub
   transport only:
   - getTracker fetches tracker.json from the HueTX/sweep-tracker
     repo (the bundle re-calls it every 60s, exactly as the live page
     polls its backend). tracker.json now carries the retooled
     view-model at top level (generated_at, build_version, run,
     counts, today, searching_lanes, lanes, stages, titles,
     controls {priority_lanes, scoped_lanes, sweep_state, pending,
     acks}) PLUS the lists fields (today_filings,
     today_filed_by_source, today_parked, today_rejected,
     lane_companies). When those view fields are present the shim
     passes them through as the response's `view` / `lists` fields —
     the bundle's ONLY source for live state in that mode, exactly
     as in-app — and composes the response's `control_log` from
     controls.pending / controls.acks plus this browser's own
     not-yet-relayed taps. The legacy snapshot fields riding in the
     same response are built from the view-model's typed fields
     (lane phases -> worker rows, view stages -> stage states,
     titles -> family states), never by parsing detail prose. When
     the view fields are absent (an older tracker.json) the shim
     falls back to the legacy snapshot rendering wholesale, and
     when the fetch itself fails it serves the embedded snapshot
     (assets/fallback.js).
   - Daily boundary: the Today counters and lists belong to the
     current calendar day in America/Chicago and reset at midnight
     CT. Any payload whose today block is stamped with another day
     — a stale tracker.json still being served, the embedded
     fallback, a cached payload held across midnight — has its
     today block and today lists swapped for a fresh, empty today
     before the bundle can render them, so a previous day's numbers
     never appear as today's (see enforceCurrentDay).
   - pullview (the bundle calls it on load and every 60s) forces a
     fresh tracker.json fetch and reports the documents'
     generated_at stamps, mirroring the in-app action's response.
   - The control actions (lane / sweep / reprocess / relaunch /
     title / titles / rules) are recorded as durable local request
     records keyed by the tap's own client-generated UUID — the
     same ids the bundle mints at tap time and sends with the call —
     and composed into every getTracker result (the snapshot's
     control channels and control_log.pending) until the request's
     OWN id appears in tracker.json's controls.acks: only then does
     the tap leave "Requested" for "Received — actuating", and it
     returns to normal once the view reflects the effect. No
     optimistic success and no timers: a record retires only via
     its ack, or via the mark-then-consume rule against fetched
     pending state (a record a fetch shows is marked seen; a seen
     record a later fetch still omits is consumed; a record no fetch
     has shown is never dropped). Records persist across reloads,
     so a tap stays "Requested" until its ack lands. Priority taps
     carry `desired` (the priority membership the user wants for
     the lane after the tap) on the queued request bodies and on
     the control-requests.json entry's args, exactly as the client sent it.
     Every control action — titles and rules included — is ALSO
     written to control-requests.json in the same repo via the Contents API
     (see the control outbox below): the entry carries the tap's
     own UUID in its `id` field (args.id when the call carries a
     single request id; the per-lane ids ride in args.ids for a
     lane batch). The write returning ok only means the request is
     queued — it never clears a "Requested" state. No credential is
     ever embedded in this page: the write uses a token the user
     supplies once via a browser prompt, kept only in the
     browser's localStorage.
   - Control channel (fixed 2026-11-06): taps are written to
     control-requests.json — the file the Sweep v4 bridge polls
     (the 2026-11-04 standalone start, request 1399fb91, landed
     there and was actuated). This shim originally wrote to
     control.json, which was the v3 input channel; since the v4
     cutover (2026-11-02) control.json is a read-only mirror the
     engine republishes every cycle, so taps written there were
     overwritten unread and never actuated. The write logic is
     unchanged — control-requests.json holds exactly the
     {pending: [{id, action, args, requested_at}]} shape it
     merges into. */
(function () {
  "use strict";
  var SNAPSHOT_URL = "https://raw.githubusercontent.com/HueTX/sweep-tracker/main/tracker.json";
  var CONTROL_API_URL = "https://api.github.com/repos/HueTX/sweep-tracker/contents/control-requests.json";
  var TOKEN_KEY = "sweepTrackerGhToken";
  var QUEUE_KEY = "sweepTrackerPendingControls";
  var LOG_KEY = "sweepTrackerPendingRequestsV2";
  var CONTROL_ACTIONS = ["sweepcontrol", "lanecontrol", "relaunchcontrol", "reprocesscontrol", "titlecontrol", "titlescontrol", "rulescontrol"];
  var realFetch = window.fetch.bind(window);
  var WORKER_KEYS = ["W1","W2","W3","W4","W5","W6","W7","W8","W9","W10","W11","W12","W13","W14","W15","W16","W17","W18","W19","W20"];
  var overlay = {};

  /* Optimistic local mirrors of control taps (priority / titles /
     rules) are STAGED at tap time and promoted into `overlay` only
     when the tap's own control-requests.json write has succeeded. A tap
     whose write never landed (bad key, offline) must not dress the
     page in a state the system never received: the request record
     reads "Requested" until its ack either way, and the badge /
     state follows the write, not the tap. (Audit 2026-10-18: the
     old code flipped the priority badge at tap time even when the
     write failed, and the badge disagreed with the record after a
     reload.) */
  var stagedOverlayPatches = [];   // [{argsRef, patch}]
  function stageOverlayPatch(argsRef, patch) {
    stagedOverlayPatches.push({ argsRef: argsRef, patch: patch });
  }
  function takeStagedPatch(argsRef) {
    for (var i = 0; i < stagedOverlayPatches.length; i++) {
      if (stagedOverlayPatches[i].argsRef === argsRef) {
        var p = stagedOverlayPatches[i].patch;
        stagedOverlayPatches.splice(i, 1);
        return p;
      }
    }
    return null;
  }
  function applyOverlayPatch(patch) {
    if (!patch) return;
    Object.keys(patch).forEach(function (k) {
      if (patch[k] === undefined) delete overlay[k];
      else overlay[k] = patch[k];
    });
  }
  /* Durable local control-request records — the standalone's mirror
     of the in-app server's request log + queue. Each record is
     {kind, body, logEntry, seen, missingStamp}: `body` is the exact
     request object for the snapshot's control channels (null for
     titles / rules, which have no channel), `logEntry` is the
     verbatim log form ({action, ...body}) composed into
     control_log.pending, `seen` records that a fetched tracker.json
     has carried the request (it reached the server side and is
     pending there), and `missingStamp` is the stamp of the first
     fetched document that omitted a seen request (the
     mark-then-consume rule, applied locally). Records persist in
     localStorage so a reload cannot strand a tap. */
  var pendingControls = loadPendingRecords();
  var lastSnapshot = null;
  var lastViewGeneratedAt = null;
  var lastListsGeneratedAt = null;
  var flushingControls = false;

  function storageGet(key) {
    try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { if (window.localStorage) window.localStorage.setItem(key, value); } catch (e) {}
  }
  function loadPendingRecords() {
    try {
      var parsed = JSON.parse(storageGet(LOG_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (r) { return r && typeof r === "object" && typeof r.kind === "string"; }).map(function (r) {
        return { kind: r.kind, body: r.body || null, logEntry: r.logEntry || null, seen: !!r.seen, missingStamp: r.missingStamp != null ? r.missingStamp : null };
      });
    } catch (e) { return []; }
  }
  function savePendingRecords() {
    try { storageSet(LOG_KEY, JSON.stringify(pendingControls)); } catch (e) {}
  }

  /* Semantic identity of a control request — the fields the page's
     own pending-state derivations read (lane + type, reprocess kind,
     relaunch kind + company + role, the title set, the sweep slot).
     Deliberately blind to requested_at: the relay may restamp a
     request on its way into the server's queue, and the request is
     the same request either way. */
  function controlIdentity(kind, body) {
    var b = body || {};
    switch (kind) {
      case "lane":
        return "lane|" + String(b.type || "") + "|" + String(b.lane || "");
      case "sweep":
        return "sweep";
      case "reprocess":
        return "reprocess|" + String(b.kind || "");
      case "relaunch":
        return "relaunch|" + String(b.kind || "") + "|" + String(b.company || "") + "|" + String(b.role || "");
      case "title":
        return "title|" + (Array.isArray(b.titles) ? b.titles.join("") : "");
    }
    return kind + "|";
  }

  function addPendingControl(kind, body, logEntry) {
    pendingControls.push({ kind: kind, body: body || null, logEntry: logEntry || null, seen: false, missingStamp: null });
    savePendingRecords();
  }

  /* A stable request id generated the way the live page's own
     newRequestId generates it: a random UUID, with the same
     fallback shape when crypto.randomUUID is unavailable. */
  function makeRequestId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    } catch (e) {}
    return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }

  /* Mirror of the live server's requestStamp: the stamp a control
     request is queued under is the client's stable id and tap-time
     requested_at when it sent them (the id is what the acks later
     echo), otherwise generated here. A client stamp from the
     future is clamped to now — the queue's mark-then-consume
     rule compares requested_at against fetch stamps, and a future
     stamp would leave the request unmarkable. */
  function requestStamp(args) {
    var now = new Date();
    var requestedAt = now.toISOString();
    if (args && args.requested_at) {
      var ms = Date.parse(args.requested_at);
      if (!isNaN(ms) && ms <= now.getTime() + 60000) {
        requestedAt = new Date(ms).toISOString();
      }
    }
    return {
      id: args && args.id != null && String(args.id).length > 0 ? String(args.id) : makeRequestId(),
      requested_at: requestedAt
    };
  }

  /* —— Fetched control state ——
     Everything one fetched tracker.json states about control
     requests, extracted once per fetch: the pending channels
     (legacy snapshot arrays, or split out of controls.pending —
     the retooled durable queue, whose entries are log entries of
     the form {action, ...body}), the verbatim pending log entries
     for control_log, and the normalized acks. */
  var CHANNEL_FOR_ACTION = { lanecontrol: "lane", sweepcontrol: "sweep", reprocesscontrol: "reprocess", relaunchcontrol: "relaunch", titlecontrol: "title" };
  var ACTION_FOR_KIND = { lane: "lanecontrol", sweep: "sweepcontrol", reprocess: "reprocesscontrol", relaunch: "relaunchcontrol", title: "titlecontrol" };

  function bodyWithoutAction(entry) {
    var out = {};
    Object.keys(entry || {}).forEach(function (k) { if (k !== "action") out[k] = entry[k]; });
    return out;
  }

  function normalizeAcks(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (a) {
      if (typeof a === "string" && a) { out.push({ id: a, actuated_at: "", effect: null }); return; }
      if (a && typeof a === "object") {
        var id = a.id != null ? String(a.id) : (a.request_id != null ? String(a.request_id) : "");
        if (!id) return;
        out.push({ id: id, actuated_at: typeof a.actuated_at === "string" ? a.actuated_at : (typeof a.at === "string" ? a.at : ""), effect: a.effect != null ? a.effect : null });
      }
    });
    return out;
  }

  function extractFetchedControls(raw) {
    var fetched = {
      channels: { lane: [], sweep: null, reprocess: [], relaunch: [], title: [] },
      pendingEntries: [],
      acks: [],
      ackIds: {},
      pendingIds: {},
      priorities: null,
      scoped: null,
      sweepState: null
    };
    function pushChannel(kind, body) {
      if (!body || typeof body !== "object") return;
      if (kind === "sweep") { fetched.channels.sweep = body; return; }
      var id = controlIdentity(kind, body);
      var arr = fetched.channels[kind];
      for (var i = 0; i < arr.length; i++) if (controlIdentity(kind, arr[i]) === id) return;
      arr.push(body);
    }
    /* Legacy snapshot channels. */
    (Array.isArray(raw.lane_control_requests) ? raw.lane_control_requests : []).forEach(function (b) { pushChannel("lane", b); });
    if (raw.sweep_control_request) pushChannel("sweep", raw.sweep_control_request);
    (Array.isArray(raw.reprocess_requests) ? raw.reprocess_requests : []).forEach(function (b) { pushChannel("reprocess", b); });
    (Array.isArray(raw.relaunch_requests) ? raw.relaunch_requests : []).forEach(function (b) { pushChannel("relaunch", b); });
    (Array.isArray(raw.title_control_requests) ? raw.title_control_requests : []).forEach(function (b) { pushChannel("title", b); });
    /* The retooled controls block: pending log entries verbatim,
       split into channels by their action; acks; lane priority /
       scope / sweep state. */
    var controls = raw.controls && typeof raw.controls === "object" ? raw.controls : null;
    if (controls && Array.isArray(controls.pending)) {
      controls.pending.forEach(function (entry) {
        if (!entry || typeof entry !== "object") return;
        fetched.pendingEntries.push(entry);
        var kind = CHANNEL_FOR_ACTION[String(entry.action || "")];
        if (kind) pushChannel(kind, bodyWithoutAction(entry));
      });
      if (Array.isArray(controls.priority_lanes)) fetched.priorities = controls.priority_lanes.slice();
      if (Array.isArray(controls.scoped_lanes)) fetched.scoped = controls.scoped_lanes.slice();
      if (typeof controls.sweep_state === "string" && controls.sweep_state) fetched.sweepState = controls.sweep_state;
      fetched.acks = normalizeAcks(controls.acks);
    } else {
      fetched.acks = normalizeAcks(raw.control_acks);
    }
    /* When the document carries no log of its own, synthesize the
       pending log entries from the pending channels so the bundle's
       control_log derivations see the same requests either way. */
    if (!fetched.pendingEntries.length) {
      Object.keys(ACTION_FOR_KIND).forEach(function (kind) {
        var bodies = kind === "sweep" ? (fetched.channels.sweep ? [fetched.channels.sweep] : []) : fetched.channels[kind];
        bodies.forEach(function (b) {
          var entry = { action: ACTION_FOR_KIND[kind] };
          Object.keys(b).forEach(function (k) { entry[k] = b[k]; });
          fetched.pendingEntries.push(entry);
        });
      });
    }
    fetched.pendingEntries.forEach(function (e) { if (e && e.id != null && String(e.id)) fetched.pendingIds[String(e.id)] = true; });
    Object.keys(fetched.channels).forEach(function (kind) {
      var bodies = kind === "sweep" ? (fetched.channels.sweep ? [fetched.channels.sweep] : []) : fetched.channels[kind];
      bodies.forEach(function (b) { if (b && b.id != null && String(b.id)) fetched.pendingIds[String(b.id)] = true; });
    });
    fetched.acks.forEach(function (a) { fetched.ackIds[a.id] = true; });
    return fetched;
  }

  /* Reconcile the local records against one fetched document,
     mirroring the server's mark-then-consume rule, extended with
     the ack rule: a record whose own id a fetch acks is actuated
     and retires at once (it moves to the acks side of the log); a
     record the fetch carries as pending is marked seen; a record
     no fetch has carried yet is NEVER dropped; a seen record the
     fetch omits is only marked with the fetch's stamp; a second
     fetch, stamped later than the mark, that still omits it has
     consumed it, so the record retires. */
  function reconcilePendingControls(fetched, stamp) {
    if (!pendingControls.length) return;
    var present = { lane: {}, sweep: {}, reprocess: {}, relaunch: {}, title: {} };
    Object.keys(present).forEach(function (kind) {
      var bodies = kind === "sweep" ? (fetched.channels.sweep ? [fetched.channels.sweep] : []) : fetched.channels[kind];
      bodies.forEach(function (b) { present[kind][controlIdentity(kind, b)] = true; });
    });
    var before = pendingControls.length;
    pendingControls = pendingControls.filter(function (rec) {
      var recId = rec.logEntry && rec.logEntry.id != null ? String(rec.logEntry.id) : (rec.body && rec.body.id != null ? String(rec.body.id) : "");
      if (recId && fetched.ackIds[recId]) return false;
      var isPresent = (rec.body && present[rec.kind] && present[rec.kind][controlIdentity(rec.kind, rec.body)]) || (recId && fetched.pendingIds[recId]);
      if (isPresent) {
        rec.seen = true;
        rec.missingStamp = null;
        return true;
      }
      if (!rec.seen) return true;
      if (rec.missingStamp == null) { rec.missingStamp = stamp; return true; }
      var stampMs = Date.parse(stamp);
      var missingMs = Date.parse(rec.missingStamp);
      if (!isNaN(stampMs) && !isNaN(missingMs) && stampMs > missingMs) return false;
      return true;
    });
    if (pendingControls.length !== before) savePendingRecords();
  }

  /* Compose the snapshot's control fields the way the live server's
     getTracker does: the fetched pending requests, with every
     still-pending local record laid over them (deduped by identity
     — the fetched copy of a relayed request IS the record). Local
     records are never written over the fetched arrays, so a fetch
     that omits a request cannot erase it from the page's view;
     only reconciliation (above) retires a record. */
  function composeControlFields(out, fetched) {
    function merged(fetchedArr, kind) {
      var arr = (fetchedArr || []).slice();
      var have = {};
      arr.forEach(function (b) { have[controlIdentity(kind, b)] = true; });
      pendingControls.forEach(function (rec) {
        if (rec.kind !== kind || !rec.body) return;
        var id = controlIdentity(kind, rec.body);
        if (!have[id]) { arr.push(rec.body); have[id] = true; }
      });
      return arr;
    }
    out.lane_control_requests = merged(fetched.channels.lane, "lane");
    out.reprocess_requests = merged(fetched.channels.reprocess, "reprocess");
    out.relaunch_requests = merged(fetched.channels.relaunch, "relaunch");
    out.title_control_requests = merged(fetched.channels.title, "title");
    /* Sweep is a single slot where the latest pending request wins —
       a local record is by construction the latest, so it takes the
       slot while it is pending; otherwise the fetched value stands. */
    var sweepRecs = pendingControls.filter(function (rec) { return rec.kind === "sweep" && rec.body; });
    out.sweep_control_request = sweepRecs.length ? sweepRecs[sweepRecs.length - 1].body : (fetched.channels.sweep || null);
    out.control_acks = fetched.acks;
    if (fetched.priorities) {
      out.lane_priorities = fetched.priorities.slice();
      out.lane_priority = fetched.priorities.length ? fetched.priorities[0] : undefined;
    }
    if (fetched.scoped) out.scoped_lanes = fetched.scoped.slice();
    if (fetched.sweepState) out.sweep_state = fetched.sweepState;
    return out;
  }

  /* The response's control_log (retool Part A.6 shape): the fetched
     pending entries verbatim, plus this browser's own records the
     fetched document does not carry yet and has not acked — a tap
     reads "Requested" off this list until its own id's ack. */
  function composeControlLog(fetched) {
    var pending = fetched.pendingEntries.slice();
    pendingControls.forEach(function (rec) {
      if (!rec.logEntry) return;
      var id = rec.logEntry.id != null ? String(rec.logEntry.id) : "";
      if (id && (fetched.pendingIds[id] || fetched.ackIds[id])) return;
      pending.push(rec.logEntry);
    });
    return { pending: pending, acks: fetched.acks };
  }

  function deriveProgress(state, progress) {
    if (typeof progress === "number" && isFinite(progress)) return Math.max(0, Math.min(100, progress));
    if (state === "done") return 100;
    if (state === "active") return 50;
    return 0;
  }

  /* Mirror of the live server's normalize(): fills the canonical
     top-level fields from wherever the writer put them, derives worker
     progress, drops live-only title fields on non-running snapshots,
     and — like the server's updateTracker merge — preserves the
     detailed lists (filings, parked/rejected lists, lane companies)
     from the last full snapshot of the same day when a push omits them. */
  function normalize(raw, preserveFrom) {
    if (!raw || typeof raw !== "object") return null;
    var d = JSON.parse(JSON.stringify(raw));
    var stages = {};
    var stageKeys = ["started","prep","linkedin_discovery","linkedin_filing","sector_search","sector_filing","stall_watch","quality_check","delivered"];
    stageKeys.forEach(function (k) {
      var s = (d.stages && d.stages[k]) || { state: "pending", detail: "", started_at: null, ended_at: null };
      stages[k] = { state: s.state, detail: s.detail || "", started_at: s.started_at != null ? s.started_at : null, ended_at: s.ended_at != null ? s.ended_at : null };
    });
    var workers = {};
    WORKER_KEYS.forEach(function (k) {
      var s = (d.workers && d.workers[k]) || { state: "pending", detail: "Waiting for the sector hunt to start", started_at: null, ended_at: null };
      workers[k] = { state: s.state, detail: s.detail || "", progress: deriveProgress(s.state, s.progress), started_at: s.started_at != null ? s.started_at : null, ended_at: s.ended_at != null ? s.ended_at : null };
    });
    var today = d.today || null;
    var out = {
      run_id: d.run_id || "", run_kind: d.run_kind || "sweep",
      status: d.status || "waiting",
      started_at: d.started_at || new Date().toISOString(),
      updated_at: d.updated_at || new Date().toISOString(),
      counts: d.counts || { evaluated: 0, filed: 0, parked: 0, rejected: 0 },
      today: today,
      today_filed_by_source: d.today_filed_by_source || (today && (today.today_filed_by_source || today.filed_by_source)) || undefined,
      today_filings: d.today_filings || (today && today.today_filings) || undefined,
      today_parked: d.today_parked || (today && today.today_parked) || undefined,
      today_rejected: d.today_rejected || (today && today.today_rejected) || undefined,
      lane_companies: d.lane_companies || undefined,
      reprocess_requests: d.reprocess_requests || [],
      relaunch_requests: d.relaunch_requests || [],
      title_control_requests: d.title_control_requests || [],
      rules_state: d.rules || d.rules_state || undefined,
      titles_state: d.titles_state || undefined,
      lane_priority: d.lane_priority || undefined,
      lane_priorities: d.lane_priorities || (d.lane_priority ? [d.lane_priority] : undefined),
      scoped_lanes: d.scoped_lanes || undefined,
      lane_control_requests: d.lane_control_requests || [],
      sweep_state: d.sweep_state || undefined,
      sweep_control_request: d.sweep_control_request != null ? d.sweep_control_request : null,
      /* Actuation acknowledgments: composed from the fetched
         controls.acks (or the legacy control_acks) in
         composeControlFields; defaulted here so the field always
         exists. The bundle matches this session's tap ids against
         these lists to show "Received — actuating", so nothing may
         rewrite, filter or drop an entry. */
      control_acks: Array.isArray(d.control_acks) ? d.control_acks : [],
      active_titles: d.status === "running" ? (d.active_titles || []) : [],
      searched_titles: d.searched_titles || [],
      evaluating_titles: d.status === "running" ? (d.evaluating_titles || []) : [],
      family_states: d.family_states || {},
      browser_label: d.browser_label || undefined,
      browser_detail: d.browser_detail || undefined,
      note: d.note || "",
      stages: stages,
      workers: workers
    };
    if (preserveFrom) {
      var sameDay = today && preserveFrom.today && today.date === preserveFrom.today.date;
      /* The lists are one day's rows: never carry them across a day
         boundary. (The by-source fields below were already gated on
         sameDay; the lists get the same rule via crossDay.) */
      var crossDay = !!(today && preserveFrom.today && today.date && preserveFrom.today.date && today.date !== preserveFrom.today.date);
      if (!crossDay && out.today_filings == null && preserveFrom.today_filings != null) out.today_filings = preserveFrom.today_filings;
      if (!crossDay && out.today_parked == null && preserveFrom.today_parked != null) out.today_parked = preserveFrom.today_parked;
      if (!crossDay && out.today_rejected == null && preserveFrom.today_rejected != null) out.today_rejected = preserveFrom.today_rejected;
      if (out.lane_companies == null && preserveFrom.lane_companies != null) out.lane_companies = preserveFrom.lane_companies;
      if (sameDay && out.today_filed_by_source == null && preserveFrom.today_filed_by_source != null) out.today_filed_by_source = preserveFrom.today_filed_by_source;
      if (sameDay && out.today && preserveFrom.today) {
        if (out.today.parked_by_source == null && preserveFrom.today.parked_by_source != null) out.today.parked_by_source = preserveFrom.today.parked_by_source;
        if (out.today.rejected_by_source == null && preserveFrom.today.rejected_by_source != null) out.today.rejected_by_source = preserveFrom.today.rejected_by_source;
        if (out.today.families_searched == null && preserveFrom.today.families_searched != null) out.today.families_searched = preserveFrom.today.families_searched;
      }
    }
    /* Local control state (lane priorities, titles / rules state)
       is applied by buildPayload AFTER the fetched control fields
       are composed: it wins over the fetched snapshot, exactly as
       the live backend's stored state wins over a sweep push, so a
       tap this browser just made mirrors at once even when the
       fetched document still shows the pre-tap state. */
    return out;
  }

  /* —— The retooled view-model ——
     tracker.json carries it at top level. Presence of any of its
     fields switches getTracker into view mode: the document's view
     fields pass through as the response's `view`, its lists fields
     as `lists`, and the snapshot fields the bundle still reads in
     raw form (worker rows for tap-state confirmation, stage states,
     family states) are built from the view's TYPED fields only —
     detail prose is display-only and never parsed for state. */
  function hasViewFields(raw) {
    return !!(raw && typeof raw === "object" && (raw.lanes != null || raw.searching_lanes != null || raw.titles != null || raw.controls != null || raw.generated_at != null));
  }

  function viewStatusOf(raw) {
    var s = typeof raw.status === "string" && raw.status ? raw.status : null;
    var run = raw.run && typeof raw.run === "object" ? raw.run : null;
    if (!s && run) s = typeof run.status === "string" && run.status ? run.status : (typeof run.state === "string" && run.state ? run.state : null);
    return s;
  }

  function buildView(raw) {
    return {
      generated_at: typeof raw.generated_at === "string" ? raw.generated_at : undefined,
      build_version: typeof raw.build_version === "string" ? raw.build_version : undefined,
      status: viewStatusOf(raw) || undefined,
      searching_lanes: Array.isArray(raw.searching_lanes) ? raw.searching_lanes : undefined,
      lanes: raw.lanes && typeof raw.lanes === "object" ? raw.lanes : undefined,
      today: raw.today && typeof raw.today === "object" ? raw.today : undefined,
      counts: raw.counts && typeof raw.counts === "object" ? raw.counts : undefined,
      titles: raw.titles != null ? raw.titles : undefined,
      stages: raw.stages && typeof raw.stages === "object" ? raw.stages : undefined,
      run: raw.run && typeof raw.run === "object" ? raw.run : undefined,
      note: typeof raw.note === "string" ? raw.note : undefined,
      pill: Array.isArray(raw.pill) ? raw.pill : undefined
    };
  }

  function buildLists(raw, out) {
    var lists = {};
    var any = false;
    if (out.today_filings != null) { lists.today_filings = out.today_filings; any = true; }
    if (out.today_parked != null) { lists.today_parked = out.today_parked; any = true; }
    if (out.today_rejected != null) { lists.today_rejected = out.today_rejected; any = true; }
    if (out.lane_companies != null) { lists.lane_companies = out.lane_companies; any = true; }
    if (!any) return null;
    lists.generated_at = typeof raw.lists_generated_at === "string" ? raw.lists_generated_at : (typeof raw.generated_at === "string" ? raw.generated_at : undefined);
    return lists;
  }

  /* One lane's view entry, looked up by lane key, falling back to a
     label match — the same lookup the bundle's viewLaneFor does. */
  function viewLaneFor(lanes, key, label) {
    if (!lanes || typeof lanes !== "object") return null;
    if (lanes[key]) return lanes[key];
    var keys = Object.keys(lanes);
    for (var i = 0; i < keys.length; i++) {
      var lane = lanes[keys[i]];
      if (label && (keys[i] === label || (lane && lane.label === label))) return lane;
    }
    return null;
  }

  /* Typed lane phase -> the snapshot's worker-row state. Only the
     "active" reading matters beyond display: it is how a restart
     tap confirms its lane is searching again. */
  function workerStateFromPhase(phase) {
    switch (String(phase || "").trim().toLowerCase()) {
      case "searching": case "evaluating": case "filing": return "active";
      case "done": case "pass-complete-carried": case "complete": case "completed": case "stopped": case "not-selected": return "done";
      default: return "pending";
    }
  }

  /* The same stage-state mapping the bundle applies to view stages
     (mapViewStageState), so the raw snapshot stages the tap-state
     derivations read carry snapshot-enum states. */
  function mapViewStageState(rawState) {
    var v = String(rawState || "").trim().toLowerCase();
    if (v === "active" || v === "searching" || v === "evaluating" || v === "filing" || v === "running" || v === "in_progress" || v === "in progress") return "active";
    if (v === "done" || v === "complete" || v === "completed" || v === "finished") return "done";
    if (v === "blocked" || v === "failed") return "blocked";
    return "pending";
  }

  /* Per-family entries from view.titles — mirrors the bundle's
     viewTitleEntries shapes: {families: {name: state | {state,
     lanes}}, family_lanes}, a bare record keyed by family, or an
     array of entries. */
  function viewTitleEntries(titles) {
    var out = [];
    function push(name, info, lanesHint) {
      if (typeof name !== "string" || !name) return;
      if (typeof info === "string") { out.push({ name: name, state: info }); return; }
      var rec = info && typeof info === "object" ? info : {};
      out.push({ name: name, state: typeof rec.state === "string" ? rec.state : "" });
    }
    if (Array.isArray(titles)) {
      titles.forEach(function (item) {
        var rec = item && typeof item === "object" ? item : {};
        push(rec.name != null ? rec.name : (rec.family != null ? rec.family : rec.title), item);
      });
      return out;
    }
    if (titles && typeof titles === "object") {
      var doc = titles;
      var familyLanes = doc.family_lanes && typeof doc.family_lanes === "object" ? doc.family_lanes : {};
      var families = doc.families && typeof doc.families === "object" ? doc.families : doc;
      Object.keys(families).forEach(function (name) { push(name, families[name], familyLanes[name]); });
    }
    return out;
  }

  /* —— Master-switch reconciliation ——
     controls.sweep_state is the switch the Start / Stop button
     renders ("Sweep is off" whenever it is not "running"). The run
     fields in the same document can still carry the moment the
     last run froze — lanes mid-search, a stage still active,
     searching_lanes populated, run.activity.searching true — and
     every live-looking derivation in the bundle (the headline, the
     lane cards, the coverage counts, the step list) reads those
     fields, so the page claimed the sweep was searching under its
     own off switch. The switch wins: when it is not "running",
     live-activity claims in the view are downgraded to their
     stopped record before anything renders. Coverage numbers,
     details and history stay — they are the last run's record,
     not a claim that it is still moving.
     The downgrade covers the run's own status too (view.status,
     run.status, run.state): the bundle keys its run clock, its
     stall notes and several step states off status === "running",
     and merges the view's status over the snapshot's, so a frozen
     "running" left here kept the page's lower half treating the
     run as live — the run line's total kept counting up from a
     run that ended when the switch went off, and the Today card
     diagnosed a "stalled" run — under a headline that correctly
     read "Sweep is off". The pill goes too: it is the bundle's
     present-tense "now searching" feed and the bundle gates it
     only on the document being fresh, never on the switch, so a
     fresh document published as the sweep stopped would have
     rendered NOW SEARCHING under its own off switch. */
  function reconcileSweepOff(view, raw) {
    var controls = raw && raw.controls && typeof raw.controls === "object" ? raw.controls : null;
    var sweepState = controls && typeof controls.sweep_state === "string" && controls.sweep_state ? controls.sweep_state
      : (typeof raw.sweep_state === "string" && raw.sweep_state ? raw.sweep_state : null);
    if (!sweepState || sweepState === "running") return view;
    var out = {};
    Object.keys(view).forEach(function (k) { out[k] = view[k]; });
    out.searching_lanes = [];
    if (typeof out.status === "string" && /^(running|active)$/i.test(out.status.trim())) out.status = "stopped";
    if (Array.isArray(out.pill)) out.pill = [];
    if (view.lanes && typeof view.lanes === "object") {
      var lanes = {};
      Object.keys(view.lanes).forEach(function (k) {
        var lane = view.lanes[k];
        if (!lane || typeof lane !== "object") { lanes[k] = lane; return; }
        var copy = {};
        Object.keys(lane).forEach(function (f) { copy[f] = lane[f]; });
        var phase = String(copy.phase || "").trim().toLowerCase();
        if (phase === "searching" || phase === "evaluating" || phase === "filing") {
          copy.phase = "stopped";
          copy.current = null;
        }
        lanes[k] = copy;
      });
      out.lanes = lanes;
    }
    if (view.stages && typeof view.stages === "object") {
      var stages = {};
      Object.keys(view.stages).forEach(function (k) {
        var st = view.stages[k];
        if (!st || typeof st !== "object") { stages[k] = st; return; }
        var copy = {};
        Object.keys(st).forEach(function (f) { copy[f] = st[f]; });
        var s = String(copy.state || "").trim().toLowerCase();
        if (s === "active" || s === "searching" || s === "evaluating" || s === "filing" || s === "running" || s === "in_progress" || s === "in progress") copy.state = "stopped";
        stages[k] = copy;
      });
      out.stages = stages;
    }
    if (view.run && typeof view.run === "object") {
      var run = {};
      Object.keys(view.run).forEach(function (k) { run[k] = view.run[k]; });
      if (run.activity && typeof run.activity === "object") {
        var act = {};
        Object.keys(run.activity).forEach(function (k) { act[k] = run.activity[k]; });
        act.searching = false;
        act.filing = false;
        run.activity = act;
      }
      if (typeof run.status === "string" && /^(running|active)$/i.test(run.status.trim())) run.status = "stopped";
      if (typeof run.state === "string" && /^(running|active)$/i.test(run.state.trim())) run.state = "stopped";
      run.live = false;
      out.run = run;
    }
    return out;
  }

  /* Fold the view-model's typed fields into the raw snapshot fields
     the bundle's non-render derivations still read in view mode
     (restart-tap confirmation reads worker rows and the LinkedIn
     discovery stage; the header's Updated line reads updated_at).
     Rendering itself reads `view` / `lists` — this only keeps the
     raw mirrors truthful, from typed fields alone. */
  function applyViewToSnapshot(out, raw) {
    var view = reconcileSweepOff(buildView(raw), raw);
    /* The snapshot status is the RECONCILED view's status, not the
       raw document's: with the switch off the raw run record still
       says "running", and the bundle's run clock, stall notes and
       step states key off this field. A finished run's own status
       (complete / failed / waiting) is history and passes through. */
    var status = typeof view.status === "string" && view.status ? view.status : viewStatusOf(raw);
    if (status === "running" || status === "complete" || status === "failed" || status === "waiting" || status === "stalled" || status === "stopped") out.status = status;
    if (view.generated_at) out.updated_at = view.generated_at;
    var run = raw.run && typeof raw.run === "object" ? raw.run : null;
    if (run) {
      var rid = run.id != null ? run.id : (run.run_id != null ? run.run_id : null);
      if (rid != null && String(rid)) out.run_id = String(rid);
      if (typeof run.kind === "string" && run.kind) out.run_kind = run.kind;
      if (typeof run.started_at === "string" && run.started_at) out.started_at = run.started_at;
    }
    /* Stage states from the view stages, mapped to the snapshot enum. */
    if (view.stages) {
      Object.keys(out.stages).forEach(function (k) {
        var vs = view.stages[k];
        if (!vs || typeof vs !== "object") return;
        out.stages[k] = {
          state: mapViewStageState(vs.state),
          detail: typeof vs.detail === "string" ? vs.detail : out.stages[k].detail,
          started_at: vs.started_at != null ? vs.started_at : out.stages[k].started_at,
          ended_at: vs.ended_at != null ? vs.ended_at : out.stages[k].ended_at
        };
      });
    }
    /* Worker rows from the typed lane phases. */
    if (view.lanes) {
      WORKER_KEYS.forEach(function (k) {
        var lane = viewLaneFor(view.lanes, k);
        if (!lane || typeof lane !== "object") return;
        var state = workerStateFromPhase(lane.phase);
        var total = typeof lane.families_total === "number" ? lane.families_total : 0;
        var searched = typeof lane.families_searched === "number" ? lane.families_searched : 0;
        var progress = total > 0 ? Math.max(0, Math.min(100, Math.round(100 * searched / total))) : deriveProgress(state, null);
        out.workers[k] = {
          state: state,
          detail: typeof lane.detail === "string" ? lane.detail : (String(lane.phase || "").toLowerCase() === "not-selected" ? "Not selected — skipped" : ""),
          progress: progress,
          started_at: lane.started_at != null ? lane.started_at : null,
          ended_at: lane.ended_at != null ? lane.ended_at : null
        };
      });
      /* LinkedIn's raw mirrors: its discovery / filing stage states
         (the restart-tap confirmation reads them) and the legacy
         browser label / detail. The lane card itself renders from
         the view lane. */
      var li = viewLaneFor(view.lanes, "LINKEDIN", "LinkedIn");
      if (li && typeof li === "object") {
        var phase = String(li.phase || "").toLowerCase();
        if (phase === "searching" || phase === "evaluating") out.stages.linkedin_discovery.state = "active";
        if (phase === "filing") out.stages.linkedin_filing.state = "active";
        if (typeof li.detail === "string" && li.detail) out.browser_detail = li.detail;
        if (li.current && typeof li.current === "object") {
          var parts = [];
          if (li.current.company) parts.push(String(li.current.company));
          if (li.current.title) parts.push(String(li.current.title));
          if (parts.length) out.browser_label = parts.join(" — ");
        }
      }
    }
    /* Family states / title lists from view.titles. */
    var entries = viewTitleEntries(raw.titles);
    if (entries.length) {
      var familyStates = {};
      var searchedTitles = [];
      var activeTitles = [];
      entries.forEach(function (e) {
        familyStates[e.name] = e.state;
        var s = String(e.state || "").trim().toLowerCase();
        if (s === "searched" || s === "complete" || s === "completed" || s === "done") searchedTitles.push(e.name);
        if (s === "searching" || s === "active" || s === "evaluating") activeTitles.push(e.name);
      });
      out.family_states = familyStates;
      out.searched_titles = searchedTitles;
      if (out.status === "running") out.active_titles = activeTitles;
    }
    return view;
  }

  /* —— Daily boundary ——
     The Today counters and lists are one calendar day's numbers
     (America/Chicago) and reset at midnight CT. A payload stamped
     with any other day must never render those numbers as today's:
     swap the stale day for a fresh, empty today dated with the
     current CT date, in every copy the bundle reads (the view's
     today block, the snapshot's today block, and the today lists
     in both the snapshot fields and `lists`). Run-scoped state —
     the run header, lane phases, the "This run" totals in counts —
     is not day data and passes through untouched. The payload's day
     comes from its today block's own date stamp; when that is
     absent, from the document's generated / updated stamp read in
     CT. A payload with no readable day stamp is left alone: its
     day cannot be proven wrong. */
  function currentDateCT() {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }
  function ctDateOf(iso) {
    if (typeof iso !== "string" || !iso) return null;
    var t = new Date(iso);
    if (isNaN(t.getTime())) return null;
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
    } catch (e) { return null; }
  }
  function emptiedLike(v) { return Array.isArray(v) ? [] : {}; }
  function enforceCurrentDay(out) {
    if (!out || typeof out !== "object") return out;
    var viewToday = out.view && typeof out.view.today === "object" ? out.view.today : null;
    var snapToday = typeof out.today === "object" ? out.today : null;
    var day = null;
    if (viewToday && typeof viewToday.date === "string" && viewToday.date) day = viewToday.date;
    else if (snapToday && typeof snapToday.date === "string" && snapToday.date) day = snapToday.date;
    if (!day) day = ctDateOf(out.view && out.view.generated_at) || ctDateOf(out.updated_at);
    var now = currentDateCT();
    if (!day || day === now) return out;
    var fresh = { date: now, evaluated: 0, filed: 0, parked: 0, rejected: 0, families_searched: 0 };
    out.today = fresh;
    if (out.view) out.view.today = { date: now, evaluated: 0, filed: 0, parked: 0, rejected: 0, families_searched: 0 };
    if (out.today_filed_by_source != null) out.today_filed_by_source = {};
    if (out.today_filings != null) out.today_filings = emptiedLike(out.today_filings);
    if (out.today_parked != null) out.today_parked = emptiedLike(out.today_parked);
    if (out.today_rejected != null) out.today_rejected = emptiedLike(out.today_rejected);
    if (out.lists) {
      if (out.lists.today_filings != null) out.lists.today_filings = emptiedLike(out.lists.today_filings);
      if (out.lists.today_parked != null) out.lists.today_parked = emptiedLike(out.lists.today_parked);
      if (out.lists.today_rejected != null) out.lists.today_rejected = emptiedLike(out.lists.today_rejected);
    }
    return out;
  }

  /* Build one full getTracker response from one fetched document:
     the normalized snapshot with its control fields composed from
     the fetched control state plus the pending local records, the
     local overlay applied, and — in view mode — the view / lists
     passthrough and the typed-field mirrors. */
  function buildPayload(raw, preserveFrom) {
    var fetched = extractFetchedControls(raw);
    var out = normalize(raw, preserveFrom);
    if (!out) return null;
    composeControlFields(out, fetched);
    Object.keys(overlay).forEach(function (k) { out[k] = overlay[k]; });
    var view = null;
    var lists = null;
    if (hasViewFields(raw)) {
      view = applyViewToSnapshot(out, raw);
      lists = buildLists(raw, out);
      if (view.generated_at) lastViewGeneratedAt = view.generated_at;
      if (lists && lists.generated_at) lastListsGeneratedAt = lists.generated_at;
      else if (view.generated_at) lastListsGeneratedAt = view.generated_at;
    }
    out.view = view;
    out.lists = lists;
    /* Final guard, both modes: the master switch outranks the run
       status in the snapshot fields as well. A legacy document (no
       view fields, so no reconcileSweepOff pass) can carry status
       "running" under a stopped switch, and every status-keyed
       derivation in the bundle — the run clock that totals to
       "now", the stall diagnosis on the Today card, the live step
       states — would treat the frozen run as live. */
    if (out.sweep_state && out.sweep_state !== "running" && out.status === "running") out.status = "stopped";
    out.control_log = composeControlLog(fetched);
    enforceCurrentDay(out);
    return out;
  }

  function fallbackPayload() {
    var fb = window.__SWEEP_FALLBACK__ || null;
    if (!fb) return null;
    var out = buildPayload(fb, null);
    if (out) { Object.keys(overlay).forEach(function (k) { out[k] = overlay[k]; }); }
    return out;
  }

  async function fetchAndBuild() {
    var res = await realFetch(SNAPSHOT_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("snapshot fetch " + res.status);
    var json = await res.json();
    if (!json || typeof json !== "object") throw new Error("snapshot invalid");
    /* Retire any local control records this fetch proves actuated
       BEFORE composing the view, so the refresh that first shows a
       request acked or consumed is the one that moves the page's
       pending state for it. */
    var fetched = extractFetchedControls(json);
    var stamp = typeof json.generated_at === "string" && json.generated_at ? json.generated_at
      : (typeof json.updated_at === "string" && json.updated_at ? json.updated_at : new Date().toISOString());
    reconcilePendingControls(fetched, stamp);
    var n = buildPayload(json, lastSnapshot || fallbackPayload());
    if (!n) throw new Error("snapshot invalid");
    return n;
  }

  async function getTracker() {
    try {
      var n = await fetchAndBuild();
      lastSnapshot = n;
      return n;
    } catch (e) {
      /* A cached payload held across midnight is re-checked against
         the daily boundary before it can render again. */
      if (lastSnapshot) return enforceCurrentDay(JSON.parse(JSON.stringify(lastSnapshot)));
      var fb = fallbackPayload();
      if (fb) { lastSnapshot = fb; return fb; }
      throw e;
    }
  }

  /* pullview: force a fresh tracker.json fetch (the in-app action
     pulls view.json + lists.json into the server store; here the
     single tracker.json document carries both, and the bundle's
     follow-up getTracker invalidation renders it). A failed pull
     keeps the previously served view and reports ok:false with
     the last known generated_at stamps. */
  async function pullView() {
    try {
      var n = await fetchAndBuild();
      lastSnapshot = n;
      return { ok: true, view_generated_at: lastViewGeneratedAt, lists_generated_at: lastListsGeneratedAt };
    } catch (e) {
      return { ok: false, view_generated_at: lastViewGeneratedAt, lists_generated_at: lastListsGeneratedAt };
    }
  }

  /* ---- Control outbox: record every control tap to GitHub ----
     Entries are queued in localStorage first (so a reload never loses
     one), then flushed in the background to control-requests.json in
     HueTX/sweep-tracker via the Contents API. Flushing drains the
     queue until it is empty (an entry queued mid-flush is written
     by the same flush's next pass), runs the moment a token is
     saved after the prompt, and runs on load when a token is
     stored. Any failure — dismissed prompt, 401/403/404, offline —
     leaves the entry queued; a failed WRITE also raises the
     shim-owned failure line in the controls area (see the
     control-send failure line below), which stays until a flush
     succeeds and re-opens the token prompt when tapped. The
     durable local request records (already composed into the page)
     carry the on-screen "Requested" state until the request's own
     ack arrives in tracker.json. */
  function loadControlQueue() {
    try {
      var raw = storageGet(QUEUE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }
  function saveControlQueue(queue) {
    try { storageSet(QUEUE_KEY, JSON.stringify(queue)); } catch (e) {}
  }
  function getStoredToken() {
    var t = storageGet(TOKEN_KEY);
    return t && String(t).trim() ? String(t).trim() : null;
  }
  var TOKEN_PROMPT = "To send tracker controls to the sweep, paste a GitHub fine-grained personal access token scoped to the HueTX/sweep-tracker repo (Contents: read and write). It is stored only in this browser.";
  var TOKEN_REPLACE_PROMPT = "The saved key couldn't send your controls — it may lack Contents read/write on HueTX/sweep-tracker, or it may have been replaced. Paste a GitHub fine-grained personal access token scoped to that repo (Contents: read and write) to replace it. It is stored only in this browser.";
  function promptForToken(message) {
    var entered = null;
    try { entered = window.prompt(message); } catch (e) { entered = null; }
    if (entered && String(entered).trim()) {
      var token = String(entered).trim();
      storageSet(TOKEN_KEY, token);
      return token;
    }
    return null;
  }
  function ensureToken() {
    var existing = getStoredToken();
    if (existing) return existing;
    /* No once-per-load gate: a dismissed prompt must not strand the
       queue for the rest of the load. Flushes are coalesced (see
       scheduleControlFlush), so one burst of taps raises at most one
       prompt, and a later tap re-offers it while entries remain
       queued. */
    return promptForToken(TOKEN_PROMPT);
  }
  function makeControlId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    } catch (e) {}
    return "ctrl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  }
  function b64EncodeUtf8(str) {
    return window.btoa(unescape(encodeURIComponent(str)));
  }
  function b64DecodeUtf8(b64) {
    return decodeURIComponent(escape(window.atob(String(b64 || "").replace(/\s/g, ""))));
  }
  function githubHeaders(token) {
    return {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }
  async function writeControlEntries(token, entries) {
    /* One initial attempt plus exactly one re-read/re-merge retry on a
       409 sha conflict, per spec. Returns true only when GitHub holds
       every entry, so the caller can drop just those from the queue. */
    for (var attempt = 0; attempt < 2; attempt++) {
      var sha = null;
      var existingPending = [];
      var getRes = await realFetch(CONTROL_API_URL + "?ref=main", { cache: "no-store", headers: githubHeaders(token) });
      if (getRes.status === 404) {
        sha = null;
        existingPending = [];
      } else if (!getRes.ok) {
        return false;
      } else {
        var fileJson = await getRes.json();
        sha = fileJson && fileJson.sha ? fileJson.sha : null;
        try {
          var decoded = fileJson && fileJson.content ? b64DecodeUtf8(fileJson.content) : "";
          var parsedFile = decoded ? JSON.parse(decoded) : null;
          if (parsedFile && Array.isArray(parsedFile.pending)) existingPending = parsedFile.pending;
          else if (Array.isArray(parsedFile)) existingPending = parsedFile;
        } catch (e) { existingPending = []; }
      }
      var seen = {};
      existingPending.forEach(function (en) { if (en && en.id) seen[en.id] = true; });
      var merged = existingPending.slice();
      entries.forEach(function (en) { if (en && en.id && !seen[en.id]) { var clean = {}; Object.keys(en).forEach(function (k) { if (k !== "overlayPatch") clean[k] = en[k]; }); merged.push(clean); seen[en.id] = true; } });
      var putBody = {
        message: "tracker control: " + entries.map(function (en) { return en.action; }).join(", "),
        content: b64EncodeUtf8(JSON.stringify({ pending: merged }, null, 2)),
        branch: "main"
      };
      if (sha) putBody.sha = sha;
      var putHeaders = githubHeaders(token);
      putHeaders["Content-Type"] = "application/json";
      var putRes = await realFetch(CONTROL_API_URL, { method: "PUT", headers: putHeaders, body: JSON.stringify(putBody) });
      if (putRes.ok) return true;
      if (putRes.status === 409 && attempt === 0) continue;
      return false;
    }
    return false;
  }
  /* —— Control-send failure line ——
     A failed write to control-requests.json is visible, never silent: the
     shim owns one line in the controls area (set just above the
     Search coverage section) that stays until a later flush
     succeeds. Tapping it re-opens the token prompt so a bad saved
     key can be replaced; saving a key there flushes the queue at
     once. Queued entries are never dropped on failure — they leave
     the local queue only when GitHub confirms the write. */
  var CONTROL_ERROR_ID = "sweepControlSendError";
  var controlSendFailed = false;
  var controlErrorObserver = null;
  var controlErrorDomWait = false;
  function startControlErrorObserver() {
    if (controlErrorObserver || typeof MutationObserver === "undefined" || typeof document === "undefined" || !document.body) return;
    controlErrorObserver = new MutationObserver(function () {
      if (!controlSendFailed) return;
      var el = document.getElementById(CONTROL_ERROR_ID);
      if (!el || !el.isConnected) renderControlError();
    });
    controlErrorObserver.observe(document.body, { childList: true, subtree: true });
  }
  function renderControlError() {
    if (!controlSendFailed) return;
    if (typeof document === "undefined") return;
    if (!document.body) {
      if (!controlErrorDomWait && document.readyState === "loading") {
        controlErrorDomWait = true;
        document.addEventListener("DOMContentLoaded", function () { renderControlError(); });
      }
      return;
    }
    var el = document.getElementById(CONTROL_ERROR_ID);
    if (el && el.isConnected) { startControlErrorObserver(); return; }
    if (!el) {
      el = document.createElement("button");
      el.type = "button";
      el.id = CONTROL_ERROR_ID;
      el.textContent = "Controls couldn't be sent — the saved key may lack Contents read/write on HueTX/sweep-tracker; taps stay queued on this device. Tap to enter a new key.";
      el.setAttribute("style", "display:block;width:100%;box-sizing:border-box;margin:48px 0 -36px;padding:12px 14px;border:1px solid var(--red, #d64545);border-radius:12px;background:var(--red-soft, #fbe3e1);color:var(--red-ink, #b03a37);font-family:inherit;font-size:14px;font-weight:600;line-height:1.45;text-align:left;cursor:pointer;");
      el.addEventListener("click", function () {
        var token = promptForToken(TOKEN_REPLACE_PROMPT);
        if (token) flushControlQueue(false).catch(function () {});
      });
    }
    var section = document.querySelector('section[aria-label="Search coverage"]');
    if (section && section.parentNode) section.parentNode.insertBefore(el, section);
    else {
      var root = document.querySelector("[data-generated-space-root]") || document.body;
      root.appendChild(el);
    }
    startControlErrorObserver();
  }
  function showControlError() {
    controlSendFailed = true;
    renderControlError();
  }
  function clearControlError() {
    controlSendFailed = false;
    if (controlErrorObserver) { controlErrorObserver.disconnect(); controlErrorObserver = null; }
    if (typeof document !== "undefined") {
      var el = document.getElementById(CONTROL_ERROR_ID);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  }
  /* Coalesced flush scheduling: one pending timer at most, so a
     burst of taps schedules a single flush (and at most one token
     prompt), while a tap that lands after the timer fired schedules
     a fresh one — which is what re-offers the prompt after a
     dismissal and what drains entries queued mid-flush. */
  var controlFlushTimer = null;
  var controlFlushAllowPrompt = false;
  function scheduleControlFlush(allowPrompt) {
    if (allowPrompt) controlFlushAllowPrompt = true;
    if (controlFlushTimer != null) return;
    controlFlushTimer = setTimeout(function () {
      controlFlushTimer = null;
      var ap = controlFlushAllowPrompt;
      controlFlushAllowPrompt = false;
      flushControlQueue(ap).catch(function () {});
    }, 0);
  }
  async function flushControlQueue(allowPrompt) {
    if (flushingControls) return;
    flushingControls = true;
    try {
      /* Drain until empty: every pass re-reads the queue, so an
         entry queued while a pass was awaiting the network is
         written by the next pass of THIS flush — its own scheduled
         flush may have no-opped against the in-flight guard, and
         nothing else would ever come back for it. The loop ends
         when the queue empties, when no token is available, or
         when a write fails (the entries stay queued and the
         failure line shows). */
      while (true) {
        var entries = loadControlQueue();
        if (!entries.length) { clearControlError(); return; }
        var token = allowPrompt ? ensureToken() : getStoredToken();
        if (!token) return;
        var snapshot = entries.slice();
        var ok = false;
        try { ok = await writeControlEntries(token, snapshot); } catch (e) { ok = false; }
        if (!ok) { showControlError(); return; }
        var written = {};
        snapshot.forEach(function (en) { if (en && en.id) written[en.id] = true; });
        var remaining = loadControlQueue().filter(function (en) { return !(en && written[en.id]); });
        saveControlQueue(remaining);
        /* The writes landed: promote the taps' staged mirrors. */
        snapshot.forEach(function (en) { if (en && en.overlayPatch) applyOverlayPatch(en.overlayPatch); });
        clearControlError();
        if (!remaining.length) return;
        /* Keep draining only while another pass can make progress:
           what remains must include an entry this pass did not just
           write. (An id-less legacy row can never be carried by the
           Contents write; if nothing else remains, stop rather
           than spin — it stays queued for the next flush.) */
        var canProgress = remaining.some(function (en) { return en && en.id && !written[en.id]; });
        if (!canProgress) return;
      }
    } finally { flushingControls = false; }
  }
  function queueControlAction(action, args) {
    /* Shim v2: the entry carries the tap's OWN client-generated UUID
       — args.id, which the bundle mints at tap time for every
       single-request call — so the id the sync later acks is the id
       this entry was written under. A lanecontrol batch carries one
       id per lane in args.ids (verbatim in args below); its entry id
       is a fresh UUID naming the batch write itself. */
    var entry = {
      id: args && args.id != null && String(args.id).length > 0 ? String(args.id) : makeControlId(),
      action: String(action),
      args: JSON.parse(JSON.stringify(args || {})),
      requested_at: new Date().toISOString()
    };
    var stagedPatch = takeStagedPatch(args);
    if (stagedPatch) entry.overlayPatch = stagedPatch;
    var queue = loadControlQueue();
    queue.push(entry);
    saveControlQueue(queue);
    /* Background write: the response (and the request records already
       composed) never wait on GitHub or on the one-time token prompt.
       The write returning ok only means the request is queued — it
       never clears a "Requested" state; only the request's own ack
       in tracker.json does. */
    scheduleControlFlush(true);
    return entry;
  }
  function isControlAction(action) {
    if (!action) return false;
    return CONTROL_ACTIONS.indexOf(String(action).toLowerCase()) !== -1;
  }
  /* Leftover queued controls from a previous visit flush silently on
     load when a token is already stored — never a prompt on load. */
  scheduleControlFlush(false);

  function currentPriorities() {
    var s = lastSnapshot || fallbackPayload() || {};
    if (s.lane_priorities != null) return s.lane_priorities.slice();
    if (s.lane_priority) return [s.lane_priority];
    return [];
  }

  function applyControl(action, args) {
    var now = new Date().toISOString();
    if (action === "lanecontrol") {
      var lanes = (args.lanes && args.lanes.length ? args.lanes : args.lane ? [args.lane] : []);
      lanes = lanes.filter(function (l, i) { return lanes.indexOf(l) === i; });
      if (!lanes.length) throw new Error("lanecontrol: no lane given");
      /* Mirror the live server's queue bodies exactly: one shared
         requested_at for the batch (the client's tap-time stamp,
         clamped by requestStamp), every entry carrying its own
         stable id — the client's per-lane id from `ids` when sent,
         the single-call `id` for a one-lane call, otherwise one
         generated here — and a whole-selection restart (the caller
         passed `lanes`) declares the selection on every per-lane
         request; a single-lane restart carries no `lanes` marker.
         A priority request carries the tap's `desired` end state
         verbatim when the client sent it. Each body also becomes a
         verbatim log entry ({action, ...body}) for control_log. */
      var selectionLanes = (args.type === "restart" && args.lanes && args.lanes.length) ? lanes : null;
      var batchRequestedAt = requestStamp({ requested_at: args.requested_at }).requested_at;
      lanes.forEach(function (lane) {
        var id = (args.ids && args.ids[lane]) || (lanes.length === 1 ? args.id : undefined) || makeRequestId();
        var body = { type: args.type, lane: lane, requested_at: batchRequestedAt, id: String(id) };
        if (selectionLanes) body.lanes = selectionLanes;
        if (args.type === "priority" && typeof args.desired === "boolean") body.desired = args.desired;
        var logEntry = { action: "lanecontrol" };
        Object.keys(body).forEach(function (k) { logEntry[k] = body[k]; });
        addPendingControl("lane", body, logEntry);
      });
      if (args.type === "priority") {
        var cur = currentPriorities();
        var next;
        if (typeof args.desired === "boolean") {
          /* The tap names its desired end state: make every target
             lane's membership match it. */
          next = args.desired
            ? cur.concat(lanes.filter(function (l) { return cur.indexOf(l) === -1; }))
            : cur.filter(function (l) { return lanes.indexOf(l) === -1; });
        } else {
          var allAlready = lanes.every(function (l) { return cur.indexOf(l) !== -1; });
          next = allAlready ? cur.filter(function (l) { return lanes.indexOf(l) === -1; }) : cur.concat(lanes.filter(function (l) { return cur.indexOf(l) === -1; }));
        }
        var prioPatch = { lane_priorities: next };
        prioPatch.lane_priority = next.length ? next[0] : undefined;
        stageOverlayPatch(args, prioPatch);
      }
      return { ok: true };
    }
    if (action === "sweepcontrol") {
      /* Body shape mirrors the server's queue entry: the type plus
         the requestStamp pair (id, requested_at) — and, when the
         request carries a lane selection (a start with lanes
         attached), the lanes themselves, so the selection rides
         on the Start request into the control file and its log
         entry instead of being dropped here. */
      var sweepStamp = requestStamp(args);
      var sweepBody = { type: args.type, id: sweepStamp.id, requested_at: sweepStamp.requested_at };
      if (args.lanes && args.lanes.length) sweepBody.lanes = args.lanes.slice();
      var sweepLogEntry = { action: "sweepcontrol", type: sweepBody.type };
      if (sweepBody.lanes) sweepLogEntry.lanes = sweepBody.lanes.slice();
      sweepLogEntry.id = sweepBody.id;
      sweepLogEntry.requested_at = sweepBody.requested_at;
      addPendingControl("sweep", sweepBody, sweepLogEntry);
      return { ok: true };
    }
    if (action === "reprocesscontrol") {
      var reprocessStamp = requestStamp(args);
      var reprocessBody = { kind: args.kind, id: reprocessStamp.id, requested_at: reprocessStamp.requested_at };
      addPendingControl("reprocess", reprocessBody, { action: "reprocesscontrol", kind: reprocessBody.kind, id: reprocessBody.id, requested_at: reprocessBody.requested_at });
      return { ok: true };
    }
    if (action === "relaunchcontrol") {
      var relaunchStamp = requestStamp(args);
      var relaunchBody = { company: args.company, role: args.role, where: args.where, kind: args.kind, id: relaunchStamp.id, requested_at: relaunchStamp.requested_at };
      addPendingControl("relaunch", relaunchBody, { action: "relaunchcontrol", company: relaunchBody.company, role: relaunchBody.role, where: relaunchBody.where, kind: relaunchBody.kind, id: relaunchBody.id, requested_at: relaunchBody.requested_at });
      return { ok: true };
    }
    if (action === "titlecontrol") {
      var titles = (args.titles || []).map(function (t) { return String(t).trim(); }).filter(function (t, i, a) { return t && a.indexOf(t) === i; });
      if (!titles.length) throw new Error("titlecontrol: no titles given");
      var titleStamp = requestStamp(args);
      var titleBody = { titles: titles, id: titleStamp.id, requested_at: titleStamp.requested_at };
      addPendingControl("title", titleBody, { action: "titlecontrol", titles: titles, id: titleBody.id, requested_at: titleBody.requested_at });
      return { ok: true };
    }
    if (action === "titlescontrol") {
      /* The state is STAGED as the local mirror and promoted only
         when this request's control-requests.json write lands (see
         stageOverlayPatch), AND the request itself joins the durable
         records under its own id — it is written to control-requests.json
         like every other control and stays in control_log.pending
         until its own ack. */
      var titlesStamp = requestStamp(args);
      var addedTitles = args.added_titles || [];
      var removedTitles = args.removed_titles || [];
      stageOverlayPatch(args, { titles_state: { added_titles: addedTitles, removed_titles: removedTitles, updated_at: now } });
      addPendingControl("titles", null, { action: "titlescontrol", added_titles: addedTitles, removed_titles: removedTitles, id: titlesStamp.id, requested_at: titlesStamp.requested_at });
      return { ok: true };
    }
    if (action === "rulescontrol") {
      /* Same contract as titlescontrol: staged local mirror
         (promoted on write success) plus a durable request record
         under the tap's own id, queued to control-requests.json. */
      var rulesStamp = requestStamp(args);
      var removed = (args.removed_rule_ids || []).map(function (s) { return String(s).trim(); }).filter(function (s, i, a) { return s && a.indexOf(s) === i; });
      var disabled = (args.disabled_rule_ids || []).map(function (s) { return String(s).trim(); }).filter(function (s, i, a) { return s && a.indexOf(s) === i && removed.indexOf(s) === -1; });
      var added = (args.added_rules || []).map(function (r) { return { id: String(r.id).trim(), name: String(r.name).trim(), description: String(r.description).trim() }; }).filter(function (r) { return r.id && r.name && r.description; });
      stageOverlayPatch(args, { rules_state: { follow_all: !!args.follow_all, disabled_rule_ids: disabled, added_rules: added, removed_rule_ids: removed, updated_at: now } });
      addPendingControl("rules", null, { action: "rulescontrol", follow_all: !!args.follow_all, disabled_rule_ids: disabled, added_rules: added, removed_rule_ids: removed, id: rulesStamp.id, requested_at: rulesStamp.requested_at });
      return { ok: true };
    }
    if (action === "updateTracker") {
      var n = buildPayload(args, lastSnapshot);
      if (n) lastSnapshot = n;
      return { ok: true };
    }
    throw new Error("unknown action " + action);
  }

  function jsonResponse(payload, status) {
    return new Response(JSON.stringify(payload), { status: status || 200, headers: { "content-type": "application/json" } });
  }

  window.fetch = function (input, init) {
    var url = "";
    try { url = typeof input === "string" ? input : (input && input.url) || ""; } catch (e) {}
    var isActions = /\/actions(\?|#|$)/.test(url) || /\/actions$/.test(url);
    if (!isActions) return realFetch(input, init);
    return (async function () {
      try {
        var bodyText = init && init.body ? String(init.body) : "";
        var parsed = bodyText ? JSON.parse(bodyText) : {};
        var action = parsed.action;
        var args = parsed.args || {};
        if (action === "getTracker") {
          var snap = await getTracker();
          return jsonResponse({ data: snap });
        }
        if (action === "pullview") {
          var pulled = await pullView();
          return jsonResponse({ data: pulled });
        }
        /* Priority taps carry `desired` (the membership the user
           wants after the tap). The bundle always sends it; if a
           caller ever omits it, derive it from the pre-tap
           priorities BEFORE applyControl changes anything, so the
           queued request and the control-requests.json entry both carry the
           same explicit end state. */
        if (action === "lanecontrol" && args.type === "priority" && typeof args.desired !== "boolean") {
          var targets = (args.lanes && args.lanes.length ? args.lanes : args.lane ? [args.lane] : []);
          if (targets.length) {
            var curPri = currentPriorities();
            var everyAlready = targets.every(function (l) { return curPri.indexOf(l) !== -1; });
            args = Object.assign({}, args, { desired: !everyAlready });
          }
        }
        var result = applyControl(action, args);
        /* The request records are already composed above (the tap
           reads "Requested" from them until its own ack). Record the
           exact tap to GitHub in the background so the sweep system
           receives it just as an in-app tap delivers it. A
           queue/write failure never changes this response. */
        if (isControlAction(action)) {
          try { queueControlAction(action, args); } catch (e) {}
        }
        return jsonResponse({ data: result });
      } catch (err) {
        return jsonResponse({ error: String(err && err.message || err) }, 200);
      }
    })();
  };
})();
