'use strict';

// M9-D809 — AUD-017 (JUR-012): a linha do tempo do contrato reúne aditivo, notificação e inadimplência e a resposta segue o esquema do contrato. Pela API real, banco descartável.
process.env.PORT = process.env.M9D809_AUD017_PORT || '21717';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, encerrar, conferirNoContrato } = require('../_helpers/m9d809Http');
const { contratoComLinhaDoTempo } = require('../_helpers/m9d809Legal');

let api;
before(async () => { api = await iniciar(21717); });
after(async () => { await encerrar(); });

test('m9d809 AUD-017 a timeline do contrato reúne aditivo, notificação e inadimplência e segue o esquema do contrato', async (t) => {
  if (api.skip) return t.skip(api.skip);
  const { http } = api;
  const ids = await contratoComLinhaDoTempo(http.tenants.A);

  const res = await http.call('gestor', 'GET', `/legal/contracts/${ids.contractId}/timeline`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const itens = res.body.data.items;
  const tipos = itens.map((i) => i.type);
  for (const esperado of ['AMENDMENT', 'NOTICE', 'DELINQUENCY']) assert.ok(tipos.includes(esperado), `a timeline traz ${esperado}`);
  assert.equal(itens.find((i) => i.referenceId === ids.amendmentId).type, 'AMENDMENT');
  assert.equal(itens.find((i) => i.referenceId === ids.noticeId).type, 'NOTICE');
  assert.equal(itens.find((i) => i.referenceId === ids.collectionId).type, 'DELINQUENCY');
  const datas = itens.map((i) => new Date(i.occurredAt || 0).getTime());
  assert.deepEqual([...datas].sort((a, b) => a - b), datas, 'ordem cronológica');

  // a resposta é válida contra o OpenAPI (esquema, cabeçalhos e envelope)
  assert.deepEqual(conferirNoContrato('GET /legal/contracts/{id}/timeline', res), []);

  // outra empresa não enxerga a linha do tempo
  const outra = await http.call('gestorB', 'GET', `/legal/contracts/${ids.contractId}/timeline`);
  assert.equal(outra.status, 404);
  assert.equal(outra.body.success, false);
});
