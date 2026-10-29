'use strict';

// M9-D604 — mudança de fórmula cria nova versão; versão histórica reproduz o snapshot (BI-008). Banco descartável (ver m9d603.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const sup = require('./analytics.m9d603.support');
const registry = require('../src/features/analytics/metrics');
const { calcHash } = require('../src/features/analytics/metrics/calcHash');
const { sequelize } = require('./testHelpers');
const { correlationIdMiddleware } = require('../src/middlewares/correlationId.middleware');
const tenantMiddleware = require('../src/middlewares/tenant.middleware');
const errorHandler = require('../src/middlewares/errorHandler');

const { inTx, ctxOf, metricInput } = sup;
const NOW = new Date('2026-10-28T15:00:00Z'); // 28/10/2026 em São Paulo
const V2_FORMULA = `module.exports = { id: 'fin.m9d604_soma_sem_hoje', version: 1,
  compute: (rows) => ({ value: String(rows.filter((r) => !r.today).reduce((a, r) => a + Number(r.v), 0)) }),
  testCases: [{ name: 'ignora hoje', input: [{ v: 1 }, { v: 2, today: true }], expected: { value: '1' } }] };`;
let env;
let catalog;
const committedCodes = new Set(); // métricas gravadas com commit definitivo: removidas no after (senão quebram a consistência da M9-D603 em reexecução)

/** Remove, como superusuário do banco descartável, tudo o que os testes com commit deixaram (o gatilho de imutabilidade é contornado só aqui). */
async function purgeCommitted() {
  if (!committedCodes.size) return;
  const codes = [...committedCodes];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    const ids = '(SELECT id FROM analytics.metric_definitions WHERE metric_code IN (:codes))';
    await env.admin.query(`DELETE FROM analytics.metric_snapshots WHERE metric_id IN ${ids}`, { replacements: { codes }, transaction });
    await env.admin.query(`DELETE FROM analytics.metric_versions WHERE metric_id IN ${ids}`, { replacements: { codes }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE metric_code IN (:codes)', { replacements: { codes }, transaction });
  });
  committedCodes.clear();
}

before(async () => {
  env = await sup.setup();
  fs.writeFileSync(path.join(env.formulaDir, 'soma_sem_hoje.js'), V2_FORMULA);
  catalog = registry.createFormulaCatalog(env.formulaDir);
});
after(async () => {
  await purgeCommitted();
  await sup.teardown(env);
});

const inA = (fn, opts) => inTx(env.tenantA, opts || {}, fn);
const ctx = (perms) => ctxOf(env.tenantA, perms);
const publishV1 = (tx, extra) => registry.publishMetric(metricInput(env, extra), ctx(), tx, { catalog });
const publishV2 = (code, tx, extra = {}, options = {}) => registry.publishVersion(code, {
  version: 2, validFrom: '2026-11-01', changeReason: 'Recebíveis do dia deixam de entrar no caixa livre.',
  formulaId: 'fin.m9d604_soma_sem_hoje', formulaSemantic: 'Soma dos saldos sem os recebíveis do dia.', ...extra,
}, ctx(), tx, { catalog, now: NOW, ...options });

async function expectErr(promise, status, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.statusCode, status, `${e.code}: ${e.message}`);
    assert.equal(e.code, code);
    return true;
  });
}

const versionRows = async (code, tx) => (await sequelize.query(
  `SELECT v.version, v.formula_id, v.revision, to_char(v.valid_until, 'YYYY-MM-DD') AS valid_until, to_char(v.valid_from, 'YYYY-MM-DD') AS valid_from,
          v.formula_semantic, v.id, d.current_version_id, d.id AS metric_id
     FROM analytics.metric_versions v JOIN analytics.metric_definitions d ON d.id = v.metric_id WHERE d.metric_code = :code ORDER BY v.version`,
  { replacements: { code }, transaction: tx }
))[0];

async function snapshot(def, version, asOfDate, value, rows, tx) {
  return sup.metrics.recordSnapshot({
    groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, metricId: def.id, metricVersionId: version.id, scopeType: 'COMPANY',
    scopeId: env.tenantA.companyId, periodStart: '2026-10-01', periodEnd: '2026-10-31', asOfDate, valueNumeric: value, status: 'OK',
    calcHash: calcHash({ metricCode: def.metric_code, version: version.version, inputs: rows, params: {} }),
  }, tx);
}

test('m9d604 fórmula alterada cria nova versão e nunca altera a anterior', async () => {
  await inA(async (tx) => {
    const { definition, version: v1 } = await publishV1(tx);
    const before1 = (await versionRows(definition.metric_code, tx))[0];
    const { version: v2 } = await publishV2(definition.metric_code, tx);
    const rows = await versionRows(definition.metric_code, tx);
    assert.equal(rows.length, 2);
    assert.equal(v2.version, 2);
    assert.deepEqual({ ...rows[0], valid_until: null, current_version_id: null }, { ...before1, valid_until: null, current_version_id: null }, 'a v1 só pode ter a vigência fechada');
    assert.equal(rows[0].valid_until, '2026-11-01');
    assert.equal(rows[1].valid_from, '2026-11-01');
    assert.equal(rows[1].current_version_id, v2.id);
    assert.equal(v1.id, rows[0].id);
    const [[audit]] = await sequelize.query(
      `SELECT after_json FROM audit.audit_log WHERE action = 'analytics.metric.version_published' AND entity_id = :id`, { replacements: { id: v2.id }, transaction: tx }
    );
    assert.ok(audit.after_json.changes.formulaId, 'auditoria traz a diferença campo a campo');
    assert.equal(audit.after_json.changes.formulaId.before, 'fin.m9d603_soma');
    assert.equal(audit.after_json.changes.formulaId.after, 'fin.m9d604_soma_sem_hoje');
    const [[ev]] = await sequelize.query(
      `SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'analytics.metric.version_published' AND aggregate_id = :id`,
      { replacements: { id: definition.id }, transaction: tx }
    );
    assert.equal(ev.n, 1);
  });
});

test('m9d604 motivo é obrigatório (mínimo configurável) e nova versão sem mudança é recusada', async () => {
  await inA(async (tx) => {
    const { definition } = await publishV1(tx);
    await expectErr(publishV2(definition.metric_code, tx, { changeReason: undefined }), 400, 'ANALYTICS_CHANGE_REASON_REQUIRED');
    await expectErr(publishV2(definition.metric_code, tx, { changeReason: 'curto' }), 400, 'ANALYTICS_CHANGE_REASON_REQUIRED');
    await expectErr(publishV2(definition.metric_code, tx, { formulaId: 'fin.m9d603_soma', formulaSemantic: undefined }), 422, 'ANALYTICS_VERSION_NO_CHANGES');
    await expectErr(publishV2(definition.metric_code, tx, {}, { reasonMinChars: 80 }), 400, 'ANALYTICS_CHANGE_REASON_REQUIRED');
    await expectErr(registry.publishVersion(definition.metric_code, { version: 2 }, ctx([]), tx, { catalog, now: NOW }), 403, 'PERMISSION_DENIED');
    assert.equal((await versionRows(definition.metric_code, tx)).length, 1);
  });
});

test('m9d604 consulta asOf usa a versão vigente na data', async () => {
  await inA(async (tx) => {
    const { definition, version: v1 } = await publishV1(tx);
    const { version: v2 } = await publishV2(definition.metric_code, tx);
    await snapshot(definition, v1, '2026-10-31', '120000', [{ v: 100000 }, { v: 20000 }], tx);
    await snapshot(definition, v2, '2026-11-01', '100000', [{ v: 100000 }], tx);
    const read = (asOfDate) => registry.readMetricAsOf(ctx(['analytics:read']), {
      metricCode: definition.metric_code, scopeType: 'COMPANY', scopeId: env.tenantA.companyId, asOfDate,
    }, tx);
    const a = await read('2026-10-31');
    const b = await read('2026-11-01');
    assert.deepEqual([a.version, a.value, a.formulaId], [1, '120000.0000', 'fin.m9d603_soma']);
    assert.deepEqual([b.version, b.value, b.formulaId], [2, '100000.0000', 'fin.m9d604_soma_sem_hoje']);
  });
});

test('m9d604 versão histórica reproduz o snapshot (mesmo valor e calc_hash)', async () => {
  await inA(async (tx) => {
    const { definition, version: v1 } = await publishV1(tx);
    const inputs = [{ v: 100000 }, { v: 20000, today: true }];
    const original = registry.recalculate({ formula: catalog.get(v1.formula_id), metricCode: definition.metric_code, version: 1, inputs, params: {}, asOfDate: '2026-10-31' });
    await snapshot(definition, v1, '2026-10-31', original.value, inputs, tx);
    await publishV2(definition.metric_code, tx);
    const saved = (await registry.readMetricAsOf(ctx(['analytics:read']), {
      metricCode: definition.metric_code, scopeType: 'COMPANY', scopeId: env.tenantA.companyId, asOfDate: '2026-10-31',
    }, tx));
    const again = await registry.recalculateHistorical(ctx(['analytics:read']), { metricCode: definition.metric_code, asOfDate: '2026-10-31', inputs, params: {} }, tx, { catalog });
    assert.equal(again.version, 1, 'recalcula com a versão da época, não com a v2');
    assert.equal(again.value, original.value);
    assert.equal(again.calcHash, saved.calcHash);
    assert.equal(again.calcHash, original.calcHash);
  });
});

test('m9d604 edição direta de campo numérico é recusada', async () => {
  await inA(async (tx) => {
    const { definition } = await publishV1(tx);
    for (const patch of [{ formulaSemantic: 'outra' }, { unit: 'PERCENT' }, { filters: { status: 'ALL' } }, { valueNature: 'PLANNED' }, { dimensions: ['x'] }, { formulaParams: { horizonte: 7 } }]) {
      await expectErr(registry.updateDefinition(definition.metric_code, patch, ctx(), tx), 409, 'ANALYTICS_METRIC_REQUIRES_NEW_VERSION');
    }
    assert.equal((await versionRows(definition.metric_code, tx)).length, 1);
  });
});

test('m9d604 mudança só de descrição não cria versão', async () => {
  await inA(async (tx) => {
    const { definition } = await publishV1(tx);
    await registry.updateDefinition(definition.metric_code, { description: 'Descrição nova do caixa livre.', name: 'Caixa livre (corrigido)' }, ctx(), tx);
    const rows = await versionRows(definition.metric_code, tx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].revision, 1, 'sobe a revisão de texto');
    const [[d]] = await sequelize.query('SELECT name, description FROM analytics.metric_definitions WHERE id = :id', { replacements: { id: definition.id }, transaction: tx });
    assert.deepEqual([d.name, d.description], ['Caixa livre (corrigido)', 'Descrição nova do caixa livre.']);
    const [[a]] = await sequelize.query(`SELECT before_json, after_json FROM audit.audit_log WHERE action = 'analytics.metric.update_text' AND entity_id = :id`, { replacements: { id: definition.id }, transaction: tx });
    assert.equal(a.before_json.description, 'Saldo disponível menos obrigações.');
    assert.equal(a.after_json.description, 'Descrição nova do caixa livre.');
    await registry.updateDefinition(definition.metric_code, { description: 'Descrição nova do caixa livre.' }, ctx(), tx);
    assert.equal((await versionRows(definition.metric_code, tx))[0].revision, 1, 'sem mudança real não sobe a revisão');
  });
});

test('m9d604 versão com início no passado é recusada', async () => {
  await inA(async (tx) => {
    const { definition, version: v1 } = await publishV1(tx);
    await snapshot(definition, v1, '2026-10-20', '5', [{ v: 5 }], tx);
    await expectErr(publishV2(definition.metric_code, tx, { validFrom: '2026-10-27' }), 422, 'ANALYTICS_VALID_FROM_PAST');
    await publishV2(definition.metric_code, tx, { validFrom: '2026-10-28' }, { now: NOW });
    const [[n]] = await sequelize.query('SELECT count(*)::int AS n, max(revision_no) AS r FROM analytics.metric_snapshots WHERE metric_id = :id', { replacements: { id: definition.id }, transaction: tx });
    assert.deepEqual([n.n, Number(n.r)], [1, 1], 'nenhum snapshot antigo foi reescrito');
  });
});

test('m9d604 duas versões simultâneas em 2 conexões', async () => {
  const { definition } = await inA((tx) => publishV1(tx), { commit: true });
  committedCodes.add(definition.metric_code);
  const attempt = () => inA((tx) => publishV2(definition.metric_code, tx), { commit: true });
  const results = await Promise.allSettled([attempt(), attempt()]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.statusCode, 409);
  assert.equal(bad[0].reason.code, 'ANALYTICS_METRIC_VERSION_CONFLICT');
  const rows = await inA((tx) => versionRows(definition.metric_code, tx));
  assert.deepEqual(rows.map((r) => r.version), [1, 2]);
});

test('m9d604 falha no meio desfaz fechamento da anterior', async () => {
  await inA(async (tx) => {
    const { definition } = await publishV1(tx);
    const boom = () => { throw new Error('falha simulada ao publicar o evento'); };
    await assert.rejects(publishV2(definition.metric_code, tx, {}, { publishEvent: boom }), /falha simulada/);
    const rows = await versionRows(definition.metric_code, tx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].valid_until, null, 'a vigência da v1 continua aberta');
    assert.equal(rows[0].current_version_id, rows[0].id);
  });
});

test('m9d604 asOf sem snapshot devolve 404 sem calcular', async () => {
  await inA(async (tx) => {
    const { definition } = await publishV1(tx);
    const [[b4]] = await sequelize.query('SELECT count(*)::int AS n FROM analytics.metric_snapshots WHERE metric_id = :id', { replacements: { id: definition.id }, transaction: tx });
    await expectErr(registry.readMetricAsOf(ctx(['analytics:read']), {
      metricCode: definition.metric_code, scopeType: 'COMPANY', scopeId: env.tenantA.companyId, asOfDate: '2026-10-15',
    }, tx), 404, 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE');
    await expectErr(registry.readMetricAsOf(ctx(['analytics:read']), {
      metricCode: definition.metric_code, scopeType: 'COMPANY', scopeId: env.tenantA.companyId, asOfDate: '2025-01-01',
    }, tx), 404, 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE');
    const [[af]] = await sequelize.query('SELECT count(*)::int AS n FROM analytics.metric_snapshots WHERE metric_id = :id', { replacements: { id: definition.id }, transaction: tx });
    assert.equal(af.n, b4.n, 'a leitura não grava snapshot nenhum');
  });
});

test('m9d604 GET /analytics/metrics/:code?asOf= devolve a versão da época (HTTP)', async () => {
  const code = metricInput(env).metricCode;
  committedCodes.add(code);
  await inA(async (tx) => {
    const r1 = await registry.publishMetric(metricInput(env, { metricCode: code }), ctx(), tx, { catalog });
    const r2 = await publishV2(code, tx);
    await snapshot(r1.definition, r1.version, '2026-10-31', '120000', [{ v: 120000 }], tx);
    await snapshot(r1.definition, r2.version, '2026-11-01', '100000', [{ v: 100000 }], tx);
  }, { commit: true });
  const { createAnalyticsRouter } = require('../src/features/analytics');
  const auth = (req, res, next) => { req.auth = { ...env.tenantA, permissions: ['analytics:read'] }; next(); };
  const app = express();
  app.use(correlationIdMiddleware);
  app.use('/v1', createAnalyticsRouter({ authChain: [auth, tenantMiddleware] }));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1/analytics/metrics/${code}`;
  try {
    const get = async (qs) => { const res = await fetch(`${base}${qs}`); return { status: res.status, body: await res.json() }; };
    const a = await get('?asOf=2026-10-31');
    const b = await get('?asOf=2026-11-01');
    const c = await get('?asOf=2026-09-01');
    const patch = await fetch(base, { method: 'PATCH' });
    assert.equal(a.status, 200);
    assert.deepEqual([a.body.data.version, a.body.data.value], [1, '120000.0000']);
    assert.deepEqual([b.body.data.version, b.body.data.value], [2, '100000.0000']);
    assert.equal(c.status, 404);
    assert.equal(c.body.error.code, 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE');
    assert.equal(patch.status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
