/*
 * OpsPilot Observability API
 *
 * HTTP endpoints for querying metrics, logs, traces, and running analysis.
 * Used by Grafana-style charts, Splunk-like search, SQL console, Unix shell, and Copilot brain.
 *
 * Usage:
 *   const api = new SimulatorAPI(simulator);
 *   const server = api.listen(3000);
 *   // or use directly without Express:
 *   const metrics = api.queryMetrics({component: 'card-switch', metric: 'error_rate'});
 */

(function (root) {
  'use strict';

  // Time-series metric query engine
  // Input: {component, metric, from_t, to_t, aggregation}
  // Output: [{t, v}, ...] time-series points
  function MetricsQuery(sim) {
    this.sim = sim;
  }

  MetricsQuery.prototype.query = function (filter) {
    const comp = this.sim.c[filter.component];
    if (!comp || !comp.hist) return { error: `Component not found: ${filter.component}` };

    const metric = filter.metric;
    const times = this.sim.history.t; // simulated second of each sample, shared by every metric
    const from_t = filter.from_t !== undefined ? filter.from_t : (times[0] !== undefined ? times[0] : 0);
    const to_t = filter.to_t !== undefined ? filter.to_t : this.sim.t;
    const agg = filter.aggregation || 'none'; // none, avg, max, min, p95

    // Get historical snapshots for this component
    const hist = comp.hist[metric];
    if (!hist || !Array.isArray(hist)) {
      return { error: `Metric not found: ${metric}` };
    }

    // hist[i] was sampled at times[i]; both arrays are trimmed together, so they stay aligned
    let points = [];
    for (let i = 0; i < hist.length; i++) {
      const t = times[i];
      if (t !== undefined && t >= from_t && t <= to_t) {
        points.push({ t, v: hist[i] });
      }
    }

    // Apply aggregation if requested
    if (agg !== 'none' && points.length > 1) {
      points = [this._aggregate(points, agg)];
    }

    return { points, metric, component: filter.component, from_t, to_t };
  };

  MetricsQuery.prototype._aggregate = function (points, agg) {
    const values = points.map(p => p.v);
    let result;

    switch (agg) {
      case 'avg':
        result = values.reduce((a, b) => a + b, 0) / values.length;
        break;
      case 'max':
        result = Math.max(...values);
        break;
      case 'min':
        result = Math.min(...values);
        break;
      case 'p95':
        values.sort((a, b) => a - b);
        result = values[Math.floor(values.length * 0.95)];
        break;
      default:
        result = values[values.length - 1];
    }

    return { t: Math.floor((points[0].t + points[points.length - 1].t) / 2), v: result };
  };

  // Event (logs) query engine
  // Input: {component, level, keywords, from_t, to_t}
  // Output: [{t, level, component, message, ...}, ...]
  function EventsQuery(sim) {
    this.sim = sim;
  }

  EventsQuery.prototype.query = function (filter) {
    const from_t = filter.from_t || (this.sim.bp.start - 3600);
    const to_t = filter.to_t || this.sim.t;
    const component = filter.component;
    const levels = filter.level ? (Array.isArray(filter.level) ? filter.level : [filter.level]) : [];
    const keywords = filter.keywords ? (Array.isArray(filter.keywords) ? filter.keywords : [filter.keywords]) : [];

    let events = [];

    // Collect events from all components (or just one if specified)
    const components = component ? [this.sim.c[component]] : Object.values(this.sim.c);

    components.forEach(comp => {
      if (!comp || !comp.logs) return;
      comp.logs.forEach(log => {
        if (log.t < from_t || log.t > to_t) return;
        if (levels.length > 0 && !levels.includes(log.level)) return;
        if (keywords.length > 0 && !keywords.some(kw => log.msg.toLowerCase().includes(kw.toLowerCase()))) return;

        events.push({
          timestamp: log.t,
          component: log.id,
          level: log.level,
          message: log.msg,
          time_str: this.sim.time(log.t, true) // "HH:MM:SS"
        });
      });
    });

    // Sort by time, most recent first
    events.sort((a, b) => b.timestamp - a.timestamp);

    return { events, count: events.length, from_t, to_t };
  };

  // Trace (causal request flow) query engine
  // For now, simplified: shows component dependencies and latencies
  function TracesQuery(sim) {
    this.sim = sim;
  }

  TracesQuery.prototype.query = function (filter) {
    // Minimal trace support: identify slow paths in the flow
    // In full implementation, would track per-request causality
    const component = filter.component;
    const min_latency_ms = filter.min_latency_ms || 0;
    const status = filter.status || 'all'; // error, success, all

    const comp = this.sim.c[component];
    if (!comp || !comp.hist) {
      return { error: `Component not found: ${component}` };
    }

    // Return component metadata and dependencies for now
    return {
      component,
      type: comp.type,
      latency_p99_ms: comp.hist.latency_ms ? Math.round(comp.hist.latency_ms[comp.hist.latency_ms.length - 1] * 100) / 100 : 0,
      error_rate: comp.hist.error_rate ? comp.hist.error_rate[comp.hist.error_rate.length - 1] : 0,
      upstream: this.sim.bp.ups[component] || [],
      downstream: this.sim.bp.downs[component] || []
    };
  };

  // SQL-like query engine (read-only)
  // Supports SELECT from logs, components, metrics
  function SQLQuery(sim) {
    this.sim = sim;
  }

  SQLQuery.prototype.query = function (sql) {
    // Minimal SQL: parse simple SELECT statements
    const upper = sql.toUpperCase();

    // SELECT FROM components
    if (/SELECT.*FROM\s+components/i.test(sql)) {
      const comps = this.sim.bp.components.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        role: c.role || null
      }));
      return { rows: comps, count: comps.length };
    }

    // SELECT FROM events/logs
    if (/SELECT.*FROM\s+(events|logs)/i.test(sql)) {
      const events = [];
      Object.values(this.sim.c).forEach(comp => {
        if (comp.logs) {
          comp.logs.forEach(log => {
            events.push({
              timestamp: log.t,
              component: log.id,
              level: log.level,
              message: log.msg
            });
          });
        }
      });
      return { rows: events, count: events.length };
    }

    // SELECT FROM alerts
    if (/SELECT.*FROM\s+alerts/i.test(sql)) {
      return { rows: this.sim.alerts || [], count: (this.sim.alerts || []).length };
    }

    return { error: 'Unsupported query. Try: SELECT * FROM components; SELECT * FROM events; SELECT * FROM alerts;' };
  };

  // Main API class
  function SimulatorAPI(sim) {
    this.sim = sim;
    this.metrics = new MetricsQuery(sim);
    this.events = new EventsQuery(sim);
    this.traces = new TracesQuery(sim);
    this.sql = new SQLQuery(sim);
  }

  // Direct query methods (used without Express)
  SimulatorAPI.prototype.queryMetrics = function (filter) {
    return this.metrics.query(filter);
  };

  SimulatorAPI.prototype.queryEvents = function (filter) {
    return this.events.query(filter);
  };

  SimulatorAPI.prototype.queryTraces = function (filter) {
    return this.traces.query(filter);
  };

  SimulatorAPI.prototype.querySQL = function (sql) {
    return this.sql.query(sql);
  };

  // Express middleware setup
  SimulatorAPI.prototype.listen = function (port) {
    if (typeof require !== 'function') {
      throw new Error('Express integration only works in Node.js');
    }

    const express = require('express');
    const app = express();
    app.use(express.json());

    const self = this;

    // POST /api/v1/metrics - query time-series metrics
    app.post('/api/v1/metrics', (req, res) => {
      const result = self.metrics.query(req.body);
      res.json(result);
    });

    // POST /api/v1/events - search logs
    app.post('/api/v1/events', (req, res) => {
      const result = self.events.query(req.body);
      res.json(result);
    });

    // POST /api/v1/traces - query request flows
    app.post('/api/v1/traces', (req, res) => {
      const result = self.traces.query(req.body);
      res.json(result);
    });

    // POST /api/v1/sql - run SQL queries
    app.post('/api/v1/sql', (req, res) => {
      const result = self.sql.query(req.body.query);
      res.json(result);
    });

    // POST /api/v1/health - health check
    app.post('/api/v1/health', (req, res) => {
      res.json({
        status: 'ok',
        simulator_time: self.sim.time(),
        components: Object.keys(self.sim.c).length,
        events_logged: Object.values(self.sim.c).reduce((n, c) => n + (c.logs ? c.logs.length : 0), 0)
      });
    });

    const server = app.listen(port, () => {
      console.log(`OpsPilot API listening on port ${port}`);
    });

    return server;
  };

  // Export for Node.js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SimulatorAPI;
  }
  // Export for browser
  if (typeof root !== 'undefined') {
    root.SimulatorAPI = SimulatorAPI;
  }
})(typeof global !== 'undefined' ? global : typeof window !== 'undefined' ? window : this);
