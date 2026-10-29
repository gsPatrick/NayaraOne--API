'use strict';

// Apoio dos testes da M9-D712: catálogo de fórmulas de teste com uma fórmula por métrica da tabela de criticidade e um read model único
// de teste. Banco descartável (127.0.0.1); a semente de teste roda em transação revertida.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sup = require('../../analytics.m9d603.support');
const registry = require('../../../src/features/analytics/metrics');
const { listCriticalityRows } = require('../../../src/features/analytics/metrics/seed');

async function setup() {
  const base = await sup.setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d712-formulas-'));
  for (const row of listCriticalityRows()) {
    const file = row.code.replace('.', '_');
    fs.writeFileSync(path.join(dir, `${file}.js`), `module.exports = { id: '${row.formulaId}', version: 1, compute: () => ({ value: '1' }),
      testCases: [{ name: 'um', input: [], expected: { value: '1' } }] };`);
  }
  return { ...base, seedDir: dir, catalog: registry.createFormulaCatalog(dir), rows: listCriticalityRows().map((r) => ({ ...r, sourceReadModel: base.readModel })) };
}

async function teardown(env) {
  fs.rmSync(env.seedDir, { recursive: true, force: true });
  await sup.teardown(env);
}

const GLOBAL_CTX = { groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] };
const todayMinus = (days) => new Date(Date.now() - days * 86400000);

module.exports = { setup, teardown, inTx: sup.inTx, ctxOf: sup.ctxOf, GLOBAL_CTX, todayMinus, sequelize: sup.sequelize };
