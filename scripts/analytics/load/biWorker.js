'use strict';

/**
 * M9-D699 (3.2 fase 2) — processo filho com a "pilha de BI": servidor Express com o router REAL de /analytics (guarda de método, transação
 * somente leitura, cache, métrica, painel e drill-down) e os usuários simulados que abrem os painéis por HTTP. Fica em processo separado
 * para o relógio de eventos do fluxo operacional (processo pai) não competir com o do BI; quem compete é o banco, que é o que se mede.
 * A autenticação é simulada por cabeçalho (como nos testes do BI): servidor local em 127.0.0.1, banco descartável, nenhum token forjado.
 */
const http = require('node:http');
const express = require('express');
const { createRecorder } = require('./stats');

const DB_GUARD = process.env.DATABASE_ADMIN_URL || '';
if (!/@127\.0\.0\.1:/.test(DB_GUARD) || (!process.env.DISPOSABLE_DB && !process.env.CI)) {
  console.error('biWorker: recusado — só roda em banco descartável em 127.0.0.1.');
  process.exit(2);
}

const { correlationIdMiddleware } = require('../../../src/middlewares/correlationId.middleware');
const tenantMiddleware = require('../../../src/middlewares/tenant.middleware');
const errorHandler = require('../../../src/middlewares/errorHandler');
const { createAnalyticsRouter } = require('../../../src/features/analytics');
const { sequelize } = require('../../../src/models');

let server;
let baseUrl;

async function start(config) {
  const fakeAuth = (req, res, next) => {
    const t = config.tenants[Number(req.get('x-load-tenant') || 0)];
    req.auth = { groupId: t.groupId, companyId: t.companyId, userId: t.userId, roles: [], permissions: config.permissions };
    next();
  };
  const app = express();
  app.use(correlationIdMiddleware);
  app.use(express.json());
  app.get('/v1/noop', (req, res) => res.json({ ok: true, at: 'neutral' })); // carga neutra da linha de base: mesmo HTTP e JSON, nenhuma consulta ao banco
  app.use('/v1', createAnalyticsRouter({ authChain: [fakeAuth, tenantMiddleware] }));
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
}

async function get(path, tenantIndex, timeoutMs) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch(`${baseUrl}${path}`, { headers: { 'x-load-tenant': String(tenantIndex) }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => null);
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.status, body };
  } catch (err) {
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: 0, error: err.name };
  }
}

const served = (r) => r.status > 0 && r.status < 500;
const failureOf = (r) => (r.status === 0 ? `TIMEOUT_${r.error}` : `HTTP_${r.status}`);

/** Abrir um painel: a composição e o valor de cada indicador dele (o que a tela faz); mede o conjunto. */
async function openPanel(code, tenantIndex, config, rec) {
  const first = await get(`/analytics/dashboards/${code}`, tenantIndex, config.requestTimeoutMs);
  let total = first.ms;
  let ok = served(first);
  const widgets = ok && first.body && first.body.data ? first.body.data.widgets || [] : [];
  let sourceRef = null;
  for (const w of widgets.filter((x) => x.metricCode)) {
    const m = await get(`/analytics/metrics/${w.metricCode}?asOf=${config.asOf}`, tenantIndex, config.requestTimeoutMs);
    total += m.ms;
    ok = ok && served(m);
    if (!served(m)) rec.record(`falha:${code}`, m.ms, false, failureOf(m));
    if (!sourceRef && m.body && m.body.data && m.body.data.sourceRefs && m.body.data.sourceRefs[0]) sourceRef = { code: w.metricCode, ref: m.body.data.sourceRefs[0] };
  }
  if (!served(first)) rec.record(`falha:${code}`, first.ms, false, failureOf(first));
  rec.record(`panel:${code}`, total, ok, ok ? null : failureOf(first));
  return sourceRef;
}

/** Ler o valor de um indicador publicado (o que um card faz) e devolver a origem dele para o drill-down. */
async function readMetric(code, tenantIndex, config, rec) {
  const m = await get(`/analytics/metrics/${code}?asOf=${config.asOf}`, tenantIndex, config.requestTimeoutMs);
  rec.record(`metric:${code}`, m.ms, served(m), served(m) ? null : failureOf(m));
  if (!served(m)) rec.record(`falha:metric:${code}`, m.ms, false, failureOf(m));
  const ref = m.body && m.body.data && m.body.data.sourceRefs && m.body.data.sourceRefs[0];
  return ref ? { code, ref } : null;
}

async function drill(sourceRef, tenantIndex, config, rec) {
  const { ref, code } = sourceRef;
  const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature, page: '1', pageSize: '20' });
  const r = await get(`/analytics/metrics/${code}/drilldown?${q}`, tenantIndex, config.requestTimeoutMs);
  rec.record('drilldown', r.ms, served(r), served(r) ? null : failureOf(r));
}

const pause = (ms) => (ms > 0 ? new Promise((resolve) => { setTimeout(resolve, ms); }) : Promise.resolve());

/** Usuário do BI: abre os painéis e lê os indicadores com uma pausa de leitura entre as ações (config.thinkMs), alternando drill-down. */
async function user(index, config, rec, deadline) {
  const tenantIndex = index % config.tenants.length;
  let round = 0;
  while (Date.now() < deadline) {
    for (let p = 0; p < config.panels.length; p += 1) {
      if (Date.now() >= deadline) break;
      const ref = await openPanel(config.panels[p], tenantIndex, config, rec);
      if (ref && (p + round) % 2 === 0) await drill(ref, tenantIndex, config, rec); // alterna painel e drill-down
      await pause(config.thinkMs);
    }
    const metrics = config.metrics || [];
    for (let k = 0; k < metrics.length; k += 1) {
      if (Date.now() >= deadline) break;
      const code = metrics[(k + index * 7) % metrics.length]; // cada usuário começa num ponto diferente: com a janela curta, todos os indicadores são lidos
      const ref = await readMetric(code, tenantIndex, config, rec);
      if (ref && (k + round) % 2 === 1) await drill(ref, tenantIndex, config, rec);
      await pause(config.thinkMs);
    }
    round += 1;
  }
}

/** Na linha de base o BI não consulta o banco, mas a máquina e o processo ficam ocupados do mesmo jeito (mesmo HTTP, mesmo JSON): só muda o banco. */
async function neutralUser(config, rec, deadline) {
  while (Date.now() < deadline) {
    const r = await get('/noop', 0, config.requestTimeoutMs);
    rec.record('neutral', r.ms, served(r), served(r) ? null : failureOf(r));
    await pause(config.thinkMs);
  }
}

async function run(config) {
  const rec = createRecorder();
  const deadline = Date.now() + config.durationMs;
  const one = config.neutral ? () => neutralUser(config, rec, deadline) : (i) => user(i, config, rec, deadline);
  await Promise.all(Array.from({ length: config.users }, (_, i) => one(i)));
  return rec.raw();
}

process.on('message', async (msg) => {
  try {
    if (msg.cmd === 'start') { await start(msg.config); process.send({ type: 'ready' }); }
    if (msg.cmd === 'run') process.send({ type: 'done', raw: await run(msg.config) });
    if (msg.cmd === 'stop') { server.close(); await sequelize.close(); process.exit(0); }
  } catch (err) {
    process.send({ type: 'error', message: err.message });
  }
});
