/*
 * OpsPilot Drill Simulator — investigation tools.
 *
 * The tools a support engineer actually reaches for, all reading the live simulation:
 *   - Splunk-style log search      search(sim, query)
 *   - read-only SQL console        sql(sim, dbId, statement)
 *   - read-only Unix shell         shell(sim, host, commandLine)
 *   - host inventory               hosts(sim)
 * Nothing here can change the system. Changes go through approved actions only.
 */
(function (root) {
  'use strict';
  const S = (typeof module === 'object' && module.exports) ? require('./engine.js') : root.OpsSim;
  const fmt = S.fmtInt, clk = S.clockStr;

  // ================================================================ Splunk-style search
  // Supported: free text, "quoted phrases", NOT term, component=tam*, level=ERROR, earliest=-15m
  // Pipes: | stats count by component|level   | top pattern   | timechart count   | head 20
  function tokenize(q) {
    const out = []; const re = /"([^"]*)"|(\S+)/g; let m;
    while ((m = re.exec(q))) out.push(m[1] !== undefined ? { phrase: m[1] } : { word: m[2] });
    return out;
  }
  function wildcard(v) { return new RegExp('^' + String(v).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'); }
  function normalize(msg) { // same idea as the command center's log analyzer: turn variable parts into placeholders
    return msg
      .replace(/\b[A-Z]{2,}-\d+(?:-\d+)?\b/g, '<ID>')
      .replace(/\b\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\b/g, '<N>')
      .replace(/\b\d+(?:\.\d+)?(ms|s|%)?\b/g, (_, u) => '<N>' + (u || ''))
      .replace(/\s+/g, ' ').trim();
  }
  function search(sim, query) {
    query = String(query || '').trim() || '*';
    const [head, ...pipes] = query.split('|').map(s => s.trim());
    const filters = { terms: [], not: [], component: null, level: null, earliest: null };
    let negate = false;
    tokenize(head).forEach(tk => {
      if (tk.phrase !== undefined) { (negate ? filters.not : filters.terms).push(tk.phrase.toLowerCase()); negate = false; return; }
      const w = tk.word;
      if (w === 'NOT') { negate = true; return; }
      const kv = /^(\w+)=(.+)$/.exec(w);
      if (kv) {
        const k = kv[1].toLowerCase(), v = kv[2].replace(/^"|"$/g, '');
        if (k === 'index' || k === 'sourcetype') return;
        if (k === 'component' || k === 'source' || k === 'host') filters.component = wildcard(v);
        else if (k === 'level' || k === 'log_level') filters.level = wildcard(v);
        else if (k === 'earliest') { const m = /^-(\d+)([mh])$/.exec(v); if (m) filters.earliest = sim.t - (+m[1]) * (m[2] === 'h' ? 3600 : 60); }
        else filters.terms.push(w.toLowerCase());
        return;
      }
      if (w === '*') return;
      (negate ? filters.not : filters.terms).push(w.toLowerCase()); negate = false;
    });
    let events = [];
    Object.values(sim.c).forEach(s => s.logs.forEach(l => events.push(l)));
    events = events.filter(l => {
      if (filters.earliest !== null && l.t < filters.earliest) return false;
      if (filters.component && !filters.component.test(l.id) && !filters.component.test(sim.c[l.id].def.name)) return false;
      if (filters.level && !filters.level.test(l.level)) return false;
      const text = (l.msg + ' ' + l.id + ' ' + l.level).toLowerCase();
      return filters.terms.every(t => text.includes(t)) && !filters.not.some(t => text.includes(t));
    }).sort((a, b) => b.t - a.t);
    const result = { query, count: events.length, events: events.slice(0, 200), table: null, hist: histogram(events, sim) };
    for (const p of pipes) {
      let m;
      if ((m = /^stats\s+count(?:\s+by\s+(\w+))?$/i.exec(p))) {
        const by = (m[1] || '').toLowerCase();
        if (!by) { result.table = { cols: ['count'], rows: [[events.length]] }; continue; }
        const key = by === 'level' ? (l => l.level) : by === 'component' || by === 'source' || by === 'host' ? (l => l.id) : by === 'pattern' ? (l => normalize(l.msg)) : null;
        if (!key) return { error: `stats can group by component, level or pattern, not "${m[1]}".` };
        result.table = groupCount(events, key, by);
      } else if ((m = /^top(?:\s+limit=(\d+))?\s+(\w+)$/i.exec(p))) {
        const by = m[2].toLowerCase(), lim = +(m[1] || 10);
        const key = by === 'pattern' || by === 'message' ? (l => normalize(l.msg)) : by === 'level' ? (l => l.level) : by === 'component' ? (l => l.id) : null;
        if (!key) return { error: `top works on pattern, level or component, not "${m[2]}".` };
        const t = groupCount(events, key, by); t.rows = t.rows.slice(0, lim);
        const total = events.length || 1; t.cols.push('percent'); t.rows.forEach(r => r.push((100 * r[1] / total).toFixed(1) + '%'));
        result.table = t;
      } else if (/^timechart(\s+span=\w+)?\s+count(\s+by\s+level)?$/i.test(p)) {
        result.table = { cols: ['_time', 'count'], rows: result.hist.map(h => [h.label, h.n]) };
      } else if ((m = /^head(?:\s+(\d+))?$/i.exec(p))) {
        result.events = result.events.slice(0, +(m[1] || 10));
      } else return { error: `Unsupported command "${p.split(' ')[0]}". Try: stats count by component, top pattern, timechart count, head 20.` };
    }
    return result;
  }
  function groupCount(events, key, by) {
    const m = new Map(); events.forEach(e => { const k = key(e); m.set(k, (m.get(k) || 0) + 1); });
    return { cols: [by, 'count'], rows: [...m.entries()].sort((a, b) => b[1] - a[1]) };
  }
  function histogram(events, sim) {
    const end = Math.floor(sim.t / 60), start = end - 29, bins = [];
    for (let m = start; m <= end; m++) bins.push({ m, label: clk(m * 60), n: 0, err: 0 });
    events.forEach(e => { const i = Math.floor(e.t / 60) - start; if (i >= 0 && i < bins.length) { bins[i].n++; if (e.level !== 'INFO') bins[i].err++; } });
    return bins;
  }

  // ================================================================ read-only SQL console
  // SELECT cols|*|count(*) FROM t [WHERE a op b [AND ...]] [GROUP BY c] [ORDER BY c [DESC]] [LIMIT n]
  // SHOW TABLES, DESCRIBE t. Anything that changes data is refused.
  function tables(sim, dbId) {
    const T = {};
    const db = sim.c[dbId];
    // v$session (Oracle) or pg_stat_activity (Postgres): who holds this database's connections
    const pg = S.isPg(db);
    const ORA2PG = { ACTIVE: 'active', INACTIVE: 'idle', WAITING: 'active', 'SQL*Net message from client': 'Client: ClientRead', 'ON CPU': null, 'db file scattered read': 'IO: DataFileRead', 'enq: TX - row lock contention': 'Lock: transactionid', 'log file switch (archiving needed)': 'IO: WALWrite', 'resmgr:cpu quantum': null };
    const toPg = r => r.map(v => typeof v === 'string' ? (v in ORA2PG ? ORA2PG[v] : v.replace(/:(\d)/g, '$$$1').replace(/\/\*\+ FULL\(h\) \*\/ /, '')) : v);
    T[pg ? 'pg_stat_activity' : 'v$session'] = () => {
      const t = sessionView();
      return pg ? { cols: ['pid', 'usename', 'application_name', 'state', 'seconds_in_query', 'connections_held', 'query', 'wait_event'], rows: t.rows.map(toPg) } : t;
    };
    function sessionView() {
      const rows = [];
      const users = Object.values(sim.c).filter(s => s.type === 'service' && (s.def.uses || []).includes(dbId));
      const hf = sim.hostFault(db);
      if (db.fault && db.fault.type === 'pool_exhausted') {
        rows.push([482, 'RPT_USER', 'month_end_recon_report', 'ACTIVE', Math.round((sim.t - db.fault.since) / 1) + 840, db.def.pool_size - 4, `SELECT /*+ FULL(h) */ * FROM ${db.def.big_table || 'HISTORY'} h WHERE trade_date >= :1`, 'db file scattered read']);
        users.forEach((u, i) => rows.push([600 + i, 'APP_USER', u.def.id, 'WAITING', 31, 1, 'waiting for connection', 'enq: TX - row lock contention']));
      } else {
        const wait = hf === 'disk_full' ? 'log file switch (archiving needed)' : hf === 'cpu_runaway' ? 'resmgr:cpu quantum' : null;
        users.forEach((u, i) => { for (let k = 0; k < u.instances; k++) rows.push([600 + i * 10 + k, 'APP_USER', `${u.def.id}-${k + 1}`, wait ? 'WAITING' : k % 2 ? 'INACTIVE' : 'ACTIVE', wait ? Math.round(Math.min(900, sim.t - db.host.fault.since)) : Math.floor(sim.rand() * 3), Math.max(1, Math.round(db.used / Math.max(1, u.instances))), wait || k % 2 ? 'INSERT INTO ' + (db.def.big_table || 'ORDERS') + ' VALUES (:1, :2, ...)' : 'SELECT ... FROM ORDERS WHERE id = :1', wait || (k % 2 ? 'SQL*Net message from client' : 'ON CPU')]); });
        rows.push([501, 'RPT_USER', 'daily_volume_report', 'INACTIVE', 3, 1, null, 'SQL*Net message from client']);
      }
      return { cols: ['sid', 'username', 'program', 'status', 'seconds_in_call', 'connections_held', 'sql_text', 'event'], rows };
    }
    const sources = Object.values(sim.c).filter(s => s.type === 'source');
    if (sources.length) T.sessions = () => ({
      cols: ['session_id', 'participant', 'role', 'status', 'msgs_per_min', 'limit_per_min', 'last_seq_sent', 'expected_seq', 'queued_orders', 'last_reject_reason'],
      rows: sources.map(s => {
        const why = sim.sourceDown(s), down = why === 'seq';
        return [sim.sessionId(s), s.def.name, s.def.role || 'Participant', why ? 'LOGON_REJECTED' : 'CONNECTED', Math.round(sim.metric(s.def.id, 'out_rate')), Math.round(s.def.rate_per_min * 1.5), down ? s.seqOut - 334 : s.seqOut, s.seqOut, Math.round(s.held), why === 'seq' ? 'MsgSeqNum too low' : why === 'clock' ? 'SendingTime accuracy problem' : null];
      }),
    });
    const rejecters = Object.values(sim.c).filter(s => s.type === 'service' && s.rejectLog);
    T.rejects = () => {
      const rows = [];
      rejecters.forEach(s => s.rejectLog.slice().reverse().forEach((r, i) => {
        if (rows.length > 400) return;
        rows.push([clk(r.t, true), s.def.id, r.symbol || `ACC-${48000 + ((r.t / 5 + i) % 900 | 0)}`, r.kind === 'stale' ? 'SSI_NOT_FOUND' : 'PRICE_OUTSIDE_BAND', r.kind === 'stale' ? `no SSI in ${r.ref}` : `band not updated for ${r.ca}`, Math.max(1, Math.round(r.n)), s.def.rejects === 'return' ? 'RETURNED_TO_SENDER' : (s.rejected >= 1 ? 'IN_EXCEPTION_QUEUE' : 'REPROCESSED')]);
      }));
      return { cols: ['time', 'component', 'key', 'reason_code', 'reason', 'count', 'state'], rows };
    };
    Object.values(sim.c).filter(s => s.type === 'ref_data').forEach(r => {
      T[`${r.def.id}_load_log`] = () => {
        const rows = [], every = r.def.refresh_every_min * 60;
        const failing = r.fault && r.fault.type === 'feed_failed';
        for (let k = 0; k < 8; k++) {
          const t = r.lastRefresh - k * every;
          rows.push([clk(t), 'SUCCESS', r.records - k * 13, null]);
        }
        if (failing) for (let t = r.lastRefresh + every; t <= sim.t; t += every) rows.unshift([clk(t), 'FAILED', 0, 'sftp connection refused']);
        const missed = sim.issuersOf(r.def.id).filter(i => i.fault && i.fault.type === 'announcement_missed');
        if (missed.length) rows[0][3] = `skipped: ${missed.map(m => m.fault.ca).join(', ')} (unknown ISIN format)`;
        return { cols: ['load_time', 'status', 'records', 'notes'], rows };
      };
    });
    const issuers = Object.values(sim.c).filter(s => s.type === 'issuer');
    if (issuers.length) {
      T.corporate_actions = () => ({
        cols: ['ca_id', 'issuer', 'symbol', 'type', 'effective', 'status', 'error'],
        rows: issuers.map((s, i) => {
          const missed = s.fault && s.fault.type === 'announcement_missed';
          return [missed ? s.fault.ca : `CA-2026-0${40 + i * 7}`, s.def.name, s.def.symbol || s.def.id.toUpperCase(), ['DIVIDEND', 'SPLIT 1:2', 'BONUS 1:1'][i % 3], missed ? 'TODAY' : 'PAST', missed ? 'SKIPPED' : 'APPLIED', missed ? 'Unknown ISIN format INE0KST01X12' : null];
        }),
      });
      T.instruments = () => ({
        cols: ['symbol', 'issuer', 'last_price', 'band_low', 'band_high', 'band_basis'],
        rows: issuers.map((s, i) => {
          const missed = s.fault && s.fault.type === 'announcement_missed';
          const px = [412.5, 1203.4, 286.1][i % 3], basis = missed ? px * 2 : px;
          return [s.def.symbol || s.def.id.toUpperCase(), s.def.name, px, +(basis * 0.9).toFixed(2), +(basis * 1.1).toFixed(2), missed ? 'PRE-CORPORATE-ACTION PRICE' : 'CURRENT'];
        }),
      });
    }
    return T;
  }
  function sql(sim, dbId, statement) {
    const st = String(statement || '').trim().replace(/;\s*$/, '');
    if (!st) return { error: 'Type a SELECT statement, or SHOW TABLES.' };
    if (!sim.c[dbId] || sim.c[dbId].type !== 'database') return { error: 'Choose a database connection.' };
    const T = tables(sim, dbId), pg = S.isPg(sim.c[dbId]);
    const E = (ora, pgm) => pg ? 'ERROR: ' + pgm : ora;
    if (/^(update|delete|insert|drop|alter|truncate|create|grant|kill|merge|exec|call|begin|select\s+pg_terminate_backend|select\s+pg_cancel_backend)\b/i.test(st) || /alter\s+system/i.test(st))
      return { error: E('ORA-01031: insufficient privileges', 'permission denied (read-only role)') + '. This console is read-only; changes go through approved actions with a named approver.' };
    if (/^show\s+tables$/i.test(st)) return { cols: ['table'], rows: Object.keys(T).map(t => [t]) };
    let m = /^(?:describe|desc)\s+(\S+)$/i.exec(st);
    if (m) { const t = T[m[1].toLowerCase()]; if (!t) return { error: E(`ORA-04043: object ${m[1]} does not exist`, `relation "${m[1]}" does not exist`) }; return { cols: ['column'], rows: t().cols.map(c => [c]) }; }
    m = /^select\s+(.+?)\s+from\s+(\S+)(?:\s+where\s+(.+?))?(?:\s+group\s+by\s+(\w+))?(?:\s+order\s+by\s+(\w+)(?:\s+(asc|desc))?)?(?:\s+limit\s+(\d+))?$/is.exec(st);
    if (!m) return { error: 'Supported: SELECT columns FROM table [WHERE col = value AND ...] [GROUP BY col] [ORDER BY col DESC] [LIMIT n]; SHOW TABLES; DESCRIBE table.' };
    const [, colPart, tname, where, groupBy, orderBy, dir, limit] = m;
    const tf = T[tname.toLowerCase()];
    if (!tf) return { error: E(`ORA-00942: table or view "${tname}" does not exist`, `relation "${tname}" does not exist`) + '. Run SHOW TABLES.' };
    const t = tf();
    const ci = c => { const i = t.cols.indexOf(c.toLowerCase()); if (i < 0) throw new Error(E(`ORA-00904: "${c}": invalid identifier`, `column "${c}" does not exist`)); return i; };
    try {
      let rows = t.rows;
      if (where) {
        const conds = where.split(/\s+and\s+/i).map(c => {
          const mm = /^(\w+)\s*(=|!=|<>|>=|<=|>|<|\s+like\s+)\s*(.+)$/i.exec(c.trim());
          if (!mm) throw new Error(`Could not read condition "${c}". Use column = 'text' or column > 10.`);
          const i = ci(mm[1]), op = mm[2].trim().toLowerCase(); let v = mm[3].trim();
          const str = /^'.*'$/.test(v); v = str ? v.slice(1, -1) : Number(v);
          return r => {
            const x = r[i];
            if (op === 'like') return new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(String(x));
            const a = typeof v === 'number' ? Number(x) : String(x);
            return op === '=' ? a == v : op === '!=' || op === '<>' ? a != v : op === '>' ? a > v : op === '<' ? a < v : op === '>=' ? a >= v : a <= v;
          };
        });
        rows = rows.filter(r => conds.every(f => f(r)));
      }
      let cols = colPart.split(',').map(c => c.trim());
      let out;
      if (groupBy) {
        const gi = ci(groupBy), g = new Map();
        rows.forEach(r => g.set(r[gi], (g.get(r[gi]) || 0) + 1));
        out = { cols: [groupBy.toLowerCase(), 'count'], rows: [...g.entries()] };
      } else if (cols.length === 1 && /^count\(\*\)$/i.test(cols[0])) out = { cols: ['count'], rows: [[rows.length]] };
      else if (cols.length === 1 && cols[0] === '*') out = { cols: t.cols, rows };
      else { const idx = cols.map(ci); out = { cols: cols.map(c => c.toLowerCase()), rows: rows.map(r => idx.map(i => r[i])) }; }
      if (orderBy) {
        const oi = out.cols.indexOf(orderBy.toLowerCase()); if (oi < 0) throw new Error(E(`ORA-00904: "${orderBy}": invalid identifier`, `column "${orderBy}" does not exist`));
        out.rows = out.rows.slice().sort((a, b) => (a[oi] > b[oi] ? 1 : a[oi] < b[oi] ? -1 : 0) * (dir && dir.toLowerCase() === 'desc' ? -1 : 1));
      }
      out.rows = out.rows.slice(0, Math.min(500, +(limit || 200)));
      return out;
    } catch (e) { return { error: e.message }; }
  }

  // ================================================================ read-only Unix shell
  // Hosts exist only for systems the support team owns: services, Kafka brokers, loaders, databases, adapters.
  function hosts(sim) {
    const h = [];
    Object.values(sim.c).forEach(s => {
      const id = s.def.id;
      if (s.type === 'service') h.push({ host: `${id.replace(/_/g, '-')}-node1`, comp: id });
      if (s.type === 'kafka_topic') h.push({ host: `kafka-broker1`, comp: id });
      if (s.type === 'ref_data') h.push({ host: `${id.replace(/_/g, '-')}-loader`, comp: id });
      if (s.type === 'database') h.push({ host: `${id.replace(/_/g, '-')}-db1`, comp: id });
      if (s.type === 'external_party') h.push({ host: `${id.replace(/_/g, '-')}-adapter`, comp: id });
    });
    const seen = new Set();
    return h.filter(x => (seen.has(x.host) ? false : seen.add(x.host)));
  }
  const DENY = /^(rm|mv|cp|kill|pkill|killall|reboot|shutdown|halt|sudo|su|chmod|chown|dd|mkfs|truncate|vi|vim|nano|crontab|iptables|docker|scp|ssh)$/;
  function shell(sim, host, line) {
    const H = hosts(sim).find(h => h.host === host);
    if (!H) return 'ssh: Could not resolve hostname';
    line = String(line || '').trim();
    if (!line) return '';
    const segs = line.split('|').map(s => s.trim());
    let out = run(sim, H, segs[0]);
    for (const p of segs.slice(1)) {
      const a = p.split(/\s+/), lines = out.split('\n');
      if (a[0] === 'grep') { const inv = a[1] === '-v', ic = a.includes('-i'); const pat = a.filter(x => !x.startsWith('-')).slice(1).join(' ').replace(/^['"]|['"]$/g, ''); const re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ic ? 'i' : ''); out = lines.filter(l => re.test(l) !== inv).join('\n'); }
      else if (a[0] === 'tail' || a[0] === 'head') { const n = +((a.find(x => /^-?\d+$/.test(x)) || '-10').replace('-', '')) || 10; out = (a[0] === 'tail' ? lines.slice(-n) : lines.slice(0, n)).join('\n'); }
      else if (a[0] === 'wc' && a[1] === '-l') out = String(lines.filter(Boolean).length);
      else if (a[0] === 'sort') out = lines.sort().join('\n');
      else return `${a[0]}: not available in this support shell (pipes support grep, tail, head, wc -l, sort)`;
    }
    return out;
  }
  function run(sim, H, cmd) {
    const a = cmd.split(/\s+/), c = sim.c[H.comp], id = H.comp, d = c.def;
    if (DENY.test(a[0]) || (a[0] === 'systemctl' && a[1] !== 'status') || (a[0] === 'kubectl' && !['get', 'describe', 'logs', 'top'].includes(a[1])))
      return `Permission denied: ${H.host} is accessed with a read-only support account.\nChanges go through approved actions with a named approver.`;
    if (c.host && sim.inOutage(c)) return `ssh: connect to host ${H.host} port 22: Connection refused`;
    const hf = sim.hostFault(c), f = c.fault && c.fault.type;
    const logFile = `/var/log/app/${id}.log`;
    const logLines = () => c.logs.map(l => l.line);
    const oomDown = hf === 'memory_oom' && !sim.oomUp(c);
    const skew = hf === 'clock_skew' ? c.host.fault.params.seconds : 0;
    switch (a[0]) {
      case 'help': return ['Read-only support shell. Available:',
        '  hostname  uptime  date  df -h  free -m  ps aux  top  dmesg | tail',
        '  chronyc tracking   ulimit -n   lsof -p 3120 | wc -l',
        `  ls /var/log/app   tail -n 50 ${logFile}   grep ERROR ${logFile}`,
        '  cat /etc/app/application.yml   curl -s localhost:8080/health',
        ...(c.type === 'service' ? ['  kubectl get pods   kubectl describe pod <name>   kubectl top pods'] : []),
        ...(c.type === 'external_party' ? ['  openssl x509 -enddate -noout -in /etc/pki/tls/client.pem'] : []),
        ...(c.type === 'kafka_topic' ? [`  kafka-consumer-groups.sh --describe --group ${d.consumer_group || 'consumers'}`, '  kafka-topics.sh --describe --topic ' + d.name] : []),
        ...(c.type === 'database' ? ['  (use the Database tab for SQL)'] : []),
        'Pipes: | grep text   | tail -n 20   | head   | wc -l   | sort'].join('\n');
      case 'hostname': return H.host;
      case 'whoami': return 'support_ro';
      case 'date': return `Fri Oct  9 ${clk(sim.t + skew, true)} IST 2026`;
      case 'uptime': { const f2 = c.type === 'service' ? sim.serviceFactor(c) : 1; const load = hf === 'cpu_runaway' ? 15.8 : +(c.type === 'service' ? 1.2 + (1 - Math.min(1, f2)) * 2.5 : 0.6).toFixed(2); return ` ${clk(sim.t + skew, true)} up 41 days,  3:12,  1 user,  load average: ${load.toFixed(2)}, ${(load * 0.9).toFixed(2)}, ${(load * 0.8).toFixed(2)}`; }
      case 'df': {
        const rows = ['Filesystem      Size  Used Avail Use% Mounted on', '/dev/nvme0n1p1   50G   21G   29G  42% /'];
        if (c.host) { const pct = Math.round(sim.hostMetric(c, 'host_disk_pct')); const size = c.type === 'database' ? 500 : 100; const used = Math.round(size * pct / 100); rows.push(`/dev/nvme1n1    ${String(size + 'G').padStart(4)}  ${String(used + 'G').padStart(4)}  ${String((size - used) + 'G').padStart(4)} ${String(pct + '%').padStart(4)} ${S.mountOf(c)}`); }
        else rows.push('/dev/nvme1n1    200G   88G  112G  44% /data');
        rows.push('tmpfs            16G  1.1G   15G   7% /dev/shm');
        return rows.join('\n');
      }
      case 'free': { const used = hf === 'memory_oom' ? (oomDown ? 9120 : 61980) : c.type === 'database' && c.fault ? 58211 : 21480 + Math.round(sim.rand() * 900); return ['               total        used        free      shared  buff/cache   available', `Mem:           64215       ${used}       ${Math.max(220, 64215 - used - 8000)}         412        8000       ${Math.max(300, 64215 - used)}`, 'Swap:              0           0           0'].join('\n'); }
      case 'dmesg': {
        const out = ['[3542311.20] eth0: link up, 25000 Mbps, full duplex', '[3542390.71] EXT4-fs (nvme1n1): mounted filesystem with ordered data mode'];
        if (hf === 'memory_oom') for (let k = Math.max(1, c.oomRestarts - 3); k <= c.oomRestarts; k++) out.push(`[${3550000 + k * 180}.02] Memory cgroup out of memory: Killed process ${3120 + k} (java) total-vm:9873120kB, anon-rss:6291456kB, oom_score_adj:937`);
        if (hf === 'disk_full') out.push(`[${3550120}.44] EXT4-fs warning (device nvme1n1): ext4_da_writepages: No space left on device (${S.mountOf(c)})`);
        if (hf === 'clock_skew') out.push('[3550044.10] chronyd[611]: Can\'t synchronise: no selectable sources');
        return out.join('\n');
      }
      case 'chronyc': case 'timedatectl':
        if (hf === 'clock_skew') return ['Reference ID    : 00000000 ()', 'Stratum         : 0', `System time     : ${skew.toFixed(6)} seconds fast of NTP time`, 'Leap status     : Not synchronised', 'Note: no reachable NTP sources since ' + clk(c.host.fault.since)].join('\n');
        return ['Reference ID    : 0A000101 (ntp1.dc.internal)', 'Stratum         : 3', 'System time     : 0.000214 seconds slow of NTP time', 'Leap status     : Normal'].join('\n');
      case 'ulimit': return a[1] === '-n' ? '4096' : 'unlimited';
      case 'lsof': {
        if (!c.host) return 'lsof: no process 3120';
        const n = hf === 'fd_exhausted' ? 4096 : 280 + Math.round(sim.rand() * 60);
        const rows = ['COMMAND  PID USER   FD   TYPE DEVICE NAME'];
        for (let k = 0; k < n; k++) rows.push(hf === 'fd_exhausted' && k % 10 ? `java    3120 app  ${k + 20}u  IPv4 TCP ${H.host}:${40000 + k}->${c.type === 'external_party' ? 'api.' + id.replace(/_/g, '') + '.example' : '10.20.4.' + (k % 200)}:443 (CLOSE_WAIT)` : `java    3120 app  ${k + 20}u  IPv4 TCP ${H.host}:8443->10.20.4.${k % 200}:${50000 + k} (ESTABLISHED)`);
        return rows.join('\n');
      }
      case 'openssl': {
        if (c.type !== 'external_party') return 'Could not open file /etc/pki/tls/client.pem: No such file or directory';
        return hf === 'cert_expired' ? `notAfter=Oct  8 23:59:59 2026 GMT\n(expired: subject=CN=${id}-adapter, issuer=CN=Internal Issuing CA 2)` : 'notAfter=May 11 23:59:59 2027 GMT';
      }
      case 'ps': case 'top': {
        const rows = ['USER       PID %CPU %MEM COMMAND'];
        if (hf === 'cpu_runaway') rows.push('root      7731 98.2  1.1 /opt/backup/bin/backup_agent --full --target=/mnt/nfs/backup');
        if (c.type === 'database' && S.isPg(c)) {
          rows.push('postgres  1201  0.6  4.1 /usr/pgsql-15/bin/postgres -D /var/lib/pgsql/data', `postgres  1210  ${hf === 'disk_full' ? '0.0' : '0.3'}  0.2 postgres: walwriter${hf === 'disk_full' ? '   (blocked: No space left on device)' : ''}`, 'postgres  1209  0.2  0.9 postgres: checkpointer');
          if (c.fault && c.fault.type === 'pool_exhausted') rows.push('postgres  5872 96.4  9.4 postgres: rpt_user surveillance 10.20.4.17 SELECT  -- pid 482 long-running report');
        } else if (c.type === 'database') {
          rows.push(`oracle    4410  1.1 12.0 ora_pmon_${id.toUpperCase()}`);
          if (c.fault && c.fault.type === 'pool_exhausted') rows.push('oracle    5872 96.4  9.4 oracle' + id.toUpperCase() + ' (LOCAL=NO)  -- sid 482 month_end_recon_report');
          rows.push('oracle    4422  1.2  2.0 ora_lgwr_' + id.toUpperCase(), `oracle    4431  ${hf === 'disk_full' ? '0.0' : '0.4'}  0.5 ora_arc0_${id.toUpperCase()}${hf === 'disk_full' ? '   (stuck: destination full)' : ''}`);
        } else if (c.type === 'kafka_topic') rows.push('kafka     2211 14.2 18.5 java -Xmx8g kafka.Kafka /etc/kafka/server.properties');
        else if (!oomDown) rows.push(`app       ${3120 + (c.oomRestarts || 0)} ${hf === 'cpu_runaway' ? (1 + sim.rand() * 2).toFixed(1) : (30 + sim.rand() * 20).toFixed(1)} ${hf === 'memory_oom' ? '96.1' : '22.4'} java -Xmx6g -jar /opt/app/${id}.jar`);
        rows.push('root       811  0.3  0.1 /usr/sbin/sshd -D', 'node_exp   902  0.4  0.2 /usr/local/bin/node_exporter');
        return rows.join('\n');
      }
      case 'ls': return a[1] && a[1].startsWith('/etc') ? 'application.yml' : `${id}.log\n${id}.log.1.gz\ngc.log`;
      case 'cat': {
        if (!a[1] || !a[1].includes('application')) return `cat: ${a[1] || ''}: No such file or directory`;
        const cfg = [`# ${d.name}`, `component: ${id}`, `type: ${d.type}`];
        Object.entries(d).forEach(([k, v]) => { if (!['id', 'type', 'name'].includes(k)) cfg.push(`${k}: ${Array.isArray(v) ? '[' + v.join(', ') + ']' : v}`); });
        if (c.type === 'service' && (d.uses || []).some(u => sim.c[u].type === 'database')) cfg.push('datasource:', '  maximumPoolSize: 20', '  connectionTimeout: 30000');
        if (c.type === 'service') cfg.push('http.client:', f === 'config_change' ? `  read-timeout-ms: ${c.fault.params.timeout_ms}   # refreshed ${clk(c.fault.since)} from config-server, commit ${c.fault.commit}` : '  read-timeout-ms: 2000', '  max-retries: 3', 'jvm:', '  heap: 6g');
        if (c.type === 'external_party') cfg.push('api:', `  base-url: https://api.${id.replace(/_/g, '')}.example/v1`, `  retry-policy: ${c.backoff ? 'exponential-backoff (base 2s, jitter)' : 'immediate'}`, '  max-attempts: 5', `  client-secret: vault:secret/${id}/client`, 'tls:', '  client-cert: /etc/pki/tls/client.pem');
        if (c.type === 'kafka_topic') cfg.push('consumer:', '  session.timeout.ms: 10000', '  max.poll.records: 500');
        return cfg.join('\n');
      }
      case 'tail': case 'grep': case 'less': {
        const file = a[a.length - 1];
        if (!file.startsWith('/var/log/app/')) return `${a[0]}: ${file}: No such file or directory`;
        if (file !== logFile) return `${a[0]}: ${file}: No such file or directory (this host has ${logFile})`;
        if (a[0] === 'grep') { const ic = a.includes('-i'); const pat = a.slice(1, -1).filter(x => !x.startsWith('-')).join(' ').replace(/^['"]|['"]$/g, ''); const re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ic ? 'i' : ''); return logLines().filter(l => re.test(l)).join('\n'); }
        const n = +((a.find(x => /^-?\d+$/.test(x) && x !== a[a.length - 1]) || '-20').replace('-', '')) || 20;
        return logLines().slice(-n).join('\n');
      }
      case 'curl': {
        if (oomDown || hf === 'disk_full' && c.type === 'service') return 'curl: (7) Failed to connect to localhost port 8080: Connection refused';
        const h = sim.health(id);
        const checks = c.type === 'service' ? { instances: `${sim.metric(id, 'instances')}/${c.configured}`, queue: Math.round(sim.metric(id, 'backlog')), errorRate: +sim.metric(id, 'error_rate').toFixed(1) }
          : c.type === 'external_party' ? { upstream: ({ vendor: '503 Service Unavailable', auth: '401 Unauthorized', cert: 'TLS handshake failed', disk: 'spool write failed', restart: 'starting' })[sim.extDown(c)] || (f === 'api_rate_limited' ? '429 Too Many Requests' : '200 OK'), queue: Math.round(c.inbox) } : {};
        return JSON.stringify({ status: h === 'ok' ? 'UP' : h === 'warn' ? 'DEGRADED' : 'DOWN', component: id, checks }, null, 2);
      }
      case 'systemctl': return `● ${id}.service - ${d.name}\n   Loaded: loaded (/etc/systemd/system/${id}.service; enabled)\n   Active: active (running) since Tue 2026-08-28 06:00:12 IST; 41 days ago` + (a[2] && /chrony|ntp/.test(a[2]) ? (hf === 'clock_skew' ? '\n   (chronyd) Status: "no reachable sources"' : '') : '');
      case 'kubectl': {
        if (c.type !== 'service') return 'error: the server does not have resource type for this host';
        const pods = []; for (let k = 1; k <= c.configured; k++) pods.push({ name: `${id.replace(/_/g, '-')}-7f9c-${k}`, ok: k <= c.instances });
        const st = p => !p.ok ? 'Pending' : hf === 'memory_oom' ? (oomDown ? 'CrashLoopBackOff' : 'Running') : hf === 'disk_full' ? 'Error' : 'Running';
        const ready = p => st(p) === 'Running' ? '1/1' : '0/1';
        if (a[1] === 'get') return ['NAME' + ' '.repeat(26) + 'READY   STATUS             RESTARTS   AGE', ...pods.map(p => `${p.name.padEnd(30)}${ready(p)}     ${st(p).padEnd(19)}${String(hf === 'memory_oom' && p.ok ? c.oomRestarts : 0).padEnd(11)}${p.ok ? '41d' : Math.max(1, Math.round((sim.t - (c.fault ? c.fault.since : sim.t)) / 60)) + 'm'}`)].join('\n');
        if (a[1] === 'describe') {
          const p = pods.find(x => x.name === a[3] || x.name === a[2]); if (!p) return `Error from server (NotFound): pods "${a[3] || a[2] || ''}" not found. Run kubectl get pods.`;
          let ev = p.ok ? '  <none>' : `  Warning  FailedScheduling  0/6 nodes are available: 6 Insufficient memory.\n  Normal   Evicted (previous pod) The node was low on resource: memory.`;
          let last = '';
          if (p.ok && hf === 'memory_oom') { last = '\nLast State:   Terminated\n  Reason:     OOMKilled\n  Exit Code:  137\nLimits:\n  memory:     6Gi'; ev = `  Warning  BackOff  Back-off restarting failed container (restarts: ${c.oomRestarts})`; }
          if (p.ok && hf === 'disk_full') { last = '\nLast State:   Terminated\n  Reason:     Error\n  Exit Code:  1'; ev = `  Warning  Unhealthy  Liveness probe failed: write ${S.mountOf(c)}/app/${id}.log: no space left on device`; }
          return `Name:         ${p.name}\nStatus:       ${st(p)}${last}\nEvents:\n` + ev;
        }
        if (a[1] === 'top') return ['NAME' + ' '.repeat(26) + 'CPU(cores)   MEMORY(bytes)', ...pods.filter(p => st(p) === 'Running').map(p => `${p.name.padEnd(30)}${hf === 'cpu_runaway' ? (60 + sim.rand() * 40 | 0) : (400 + sim.rand() * 300 | 0)}m         ${hf === 'memory_oom' ? (5900 + sim.rand() * 250 | 0) : (3100 + sim.rand() * 900 | 0)}Mi`)].join('\n');
        if (a[1] === 'logs') return logLines().slice(-20).join('\n');
        return 'kubectl: supported here: get pods, describe pod <name>, top pods, logs';
      }
      case 'kafka-consumer-groups.sh': {
        if (c.type !== 'kafka_topic') return 'bash: kafka-consumer-groups.sh: command not found';
        const lines = [`GROUP${' '.repeat(12)}TOPIC${' '.repeat(12)}PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG     CONSUMER-ID`];
        c.parts.forEach((lag, i) => { const end = Math.floor(c.offsets[i]); const cur = Math.floor(end - lag); lines.push(`${(d.consumer_group || 'consumers').padEnd(17)}${d.name.padEnd(17)}${String(i).padEnd(11)}${String(cur).padEnd(16)}${String(end).padEnd(16)}${String(Math.round(lag)).padEnd(8)}consumer-${(i % sim._consumerCount(c)) + 1}`); });
        return lines.join('\n');
      }
      case 'kafka-topics.sh': {
        if (c.type !== 'kafka_topic') return 'bash: kafka-topics.sh: command not found';
        return `Topic: ${d.name}\tPartitionCount: ${d.partitions}\tReplicationFactor: 3\tConfigs: retention.ms=86400000\n` + c.parts.map((_, i) => `\tTopic: ${d.name}\tPartition: ${i}\tLeader: ${(i % 3) + 1}\tReplicas: 1,2,3\tIsr: 1,2,3`).join('\n');
      }
    }
    return `bash: ${a[0]}: command not found (type help)`;
  }

  const OpsTools = { search, sql, shell, hosts, normalize, tables };
  if (typeof module === 'object' && module.exports) module.exports = OpsTools;
  else root.OpsTools = OpsTools;
})(typeof globalThis !== 'undefined' ? globalThis : this);
