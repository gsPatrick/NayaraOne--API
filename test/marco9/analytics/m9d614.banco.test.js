'use strict';

// M9-D614 — guardas do "Não improvisar" que precisam de banco e servidor: regra 4 (hash do código da fórmula) e regra 7 (403 sem permissão).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const express = require('express');
const http = require('node:http');
const sup = require('../../analytics.m9d603.support');
const registry = require('../../../src/features/analytics/metrics');
const guards = require('../../../scripts/analytics/guardrails');
const http7 = require('../_helpers/analyticsHttpEnv');

const { inTx, ctxOf, metricInput } = sup;
let env;
let catalog;
let httpEnv;

before(async () => {
  env = await sup.setup();
  httpEnv = await http7.setup();
  fs.writeFileSync(path.join(env.formulaDir, 'caixa_v2.js'), formula('fin.m9d614_caixa_v2', "'dois'"));
  catalog = registry.createFormulaCatalog(env.formulaDir);
});
after(async () => {
  await http7.teardown(httpEnv).catch(() => {});
  await sup.teardown(env).catch(() => {});
});

const formula = (id, marker) => `module.exports = { id: '${id}', version: 1, compute: (rows) => ({ value: String(rows.length) }),
  testCases: [{ name: ${marker}, input: [{}, {}], expected: { value: '2' } }] };`;
const inA = (fn) => inTx(env.tenantA, {}, fn);

test('m9d614 regra4 hash da fórmula muda sem versão reprova', async () => {
  await inA(async (tx) => {
    const { definition } = await registry.publishMetric(metricInput(env, { formulaId: 'fin.m9d603_soma' }), ctxOf(env.tenantA), tx, { catalog });
    const file = path.join(env.formulaDir, 'soma.js');
    const stored = (await registry.listPublishedVersionHashes(tx)).find((r) => r.metricCode === definition.metric_code);
    assert.equal(stored.formulaCodeHash, createHash('sha256').update(fs.readFileSync(file)).digest('hex'), 'a versão guarda o SHA-256 do arquivo da fórmula');
    const mine = async (cat) => guards.checkRule4((await registry.listPublishedVersionHashes(tx)).filter((r) => r.metricCode === definition.metric_code), cat);
    assert.deepEqual((await mine(catalog)).violations, [], 'código igual ao publicado: verde');

    // O arquivo muda (o teste continua verde) sem publicar a v2: o guarda reprova com a mensagem do livro.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("name: 'dois itens'", "name: 'dois itens alterado'"));
    const bad = await mine(registry.createFormulaCatalog(env.formulaDir));
    assert.equal(bad.violations.length, 1);
    assert.equal(bad.violations[0].rule, 4);
    assert.match(bad.violations[0].message, /Fórmula alterada sem nova versão: publique a v2/);

    // Publicar a v2 com OUTRA fórmula (id novo) deixa a v1 reproduzível e o guarda verde de novo, depois de restaurar o arquivo da v1.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("name: 'dois itens alterado'", "name: 'dois itens'"));
    const fresh = registry.createFormulaCatalog(env.formulaDir);
    await registry.publishVersion(definition.metric_code, {
      version: 2, validFrom: '2026-11-01', changeReason: 'Nova fórmula do caixa livre sem recebíveis do dia.', formulaId: 'fin.m9d614_caixa_v2',
    }, ctxOf(env.tenantA), tx, { catalog: fresh, now: new Date('2026-10-28T15:00:00Z') });
    const rows = (await registry.listPublishedVersionHashes(tx)).filter((r) => r.metricCode === definition.metric_code);
    assert.equal(rows.length, 2);
    assert.deepEqual(guards.checkRule4(rows, fresh).violations, []);

    // Sem hash gravado, ou com a fórmula removida do código, também reprova.
    assert.equal(guards.checkRule4([{ metricCode: 'fin.x', version: 1, formulaId: 'fin.m9d603_soma', formulaCodeHash: null }], fresh).violations.length, 1);
    assert.equal(guards.checkRule4([{ metricCode: 'fin.x', version: 1, formulaId: 'fin.sumiu', formulaCodeHash: 'a'.repeat(64) }], fresh).violations.length, 1);
  });
});

test('m9d614 regra7 drill-down e export sem permissão dão 403', async () => {
  const call = (method, url) => httpEnv.call(method, url, { perms: [] });
  const real = await guards.checkRule7(httpEnv.router, call);
  assert.deepEqual(real.violations, [], real.violations.map(guards.formatViolation).join('\n'));

  // Fixture: um router com drill-down aberto (200 sem permissão) e outro com export protegido (403).
  const router = express.Router();
  router.get('/analytics/metrics/:code/drilldown', (req, res) => res.json({ ok: true }));
  router.post('/analytics/exports', (req, res) => res.status(403).json({ error: 'sem permissão' }));
  router.get('/analytics/metrics/:code', (req, res) => res.json({ ok: true }));
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const fixtureCall = async (method, url) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method });
      return { status: res.status };
    };
    const bad = await guards.checkRule7(router, fixtureCall);
    assert.equal(bad.scanned, 2, 'só as rotas de drill-down e export são percorridas');
    assert.deepEqual(bad.violations.map((v) => v.file), ['GET /analytics/metrics/:code/drilldown']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
