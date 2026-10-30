'use strict';

// M9-D809 — AUD-013 (JUR-007): vistoria assinada é imutável. Pela API real, em banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d809.aud013.test.js"
process.env.PORT = process.env.M9D809_AUD013_PORT || '21713';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTenantTransaction } = require('../../testHelpers');
const { iniciar, encerrar, operacaoDoContrato, conferirNoContrato } = require('../_helpers/m9d809Http');
const { vistoriaAssinada } = require('../_helpers/m9d809Legal');
const { FileLink } = require('../../../src/models');

let api;
before(async () => { api = await iniciar(21713); });
after(async () => { await encerrar(); });

test('m9d809 AUD-013 anexar mídia em vistoria assinada devolve 409 e o contrato OpenAPI documenta o 409', async (t) => {
  if (api.skip) return t.skip(api.skip);
  const { http } = api;
  const { inspectionId, itemId, fileId } = await vistoriaAssinada(http.tenants.A);

  const res = await http.call('gestor', 'POST', `/legal/inspections/items/${itemId}/media`, { fileId, mediaType: 'PHOTO' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'LEGAL_INSPECTION_IMMUTABLE_AFTER_SIGNATURE');
  assert.equal(res.body.success, false);
  const anexos = await withTenantTransaction(http.tenants.A, (transaction) => FileLink.count({ where: { relatedEntityType: 'InspectionItem', relatedEntityId: itemId }, transaction }));
  assert.equal(anexos, 0, 'nada foi anexado à vistoria assinada');

  // o 409 consta no contrato público e a resposta real obedece ao que o contrato descreve (esquema, cabeçalhos, formato único de erro e código no catálogo)
  const { op } = operacaoDoContrato('POST /legal/inspections/items/{itemId}/media');
  assert.ok(op, 'a operação consta no contrato');
  assert.ok(Object.keys(op.operation.responses).includes('409'), 'o 409 está documentado');
  assert.deepEqual(conferirNoContrato('POST /legal/inspections/items/{itemId}/media', res), []);

  // a imutabilidade vale também para item novo, e a leitura continua permitida
  const novoItem = await http.call('gestor', 'POST', `/legal/inspections/${inspectionId}/items`, { itemName: 'Sala', condition: 'GOOD' });
  assert.equal(novoItem.status, 409);
  const leitura = await http.call('gestor', 'GET', `/legal/inspections/items/${itemId}/media`);
  assert.equal(leitura.status, 200);
});
