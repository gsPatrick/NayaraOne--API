'use strict';

// Verificação independente do Marco 5, linha 14 (JUR-013 "Contrato pertence à empresa correta e não mistura documentos/
// financeiro"): o lançamento financeiro só se vincula a contrato da própria empresa. A FK finance.financial_entries.contract_id
// -> legal.contracts não passa pela RLS: antes, B gravava lançamento apontando o contrato de A. HTTP real, dois tenants do seed.
process.env.PORT = process.env.M5FECH_CT_PORT || '5534';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./m5fech.contratos.helpers');

let pular = null;
before(async () => { pular = await h.pronto(); });
after(h.encerrar);

async function lancamento(quem, extra) {
  const cc = await h.http(quem, 'POST', '/finance/cost-centers', { code: `M5CT-${h.sfx()}`, name: 'Centro de custo fictício M5CT' });
  assert.equal(cc.status, 201, JSON.stringify(cc.body));
  return h.http(quem, 'POST', '/finance/entries', { entryType: 'DEBIT', nature: 'PAYABLE', amount: 120, dueAt: '2030-01-10', description: `M5CT JUR-013 ${h.sfx()}`, costCenterId: cc.data.id, ...extra });
}
const contarDoContrato = async (quem, contractId) => (await h.sql(quem, 'SELECT count(*)::int AS n FROM finance.financial_entries WHERE contract_id = :id', { id: contractId }))[0].n;

test('linha 14 JUR-013: lançamento da empresa B não aponta contrato da empresa A (400, nada gravado); o da própria empresa é aceito', async (t) => {
  if (pular) return t.skip(pular);
  const deA = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 });
  assert.equal(deA.status, 201);
  const cruzado = await lancamento('B:gestor', { contractId: deA.data.id });
  assert.equal(cruzado.status, 400, JSON.stringify(cruzado.body));
  assert.equal(cruzado.code, 'FINANCE_ENTRY_CONTRACT_NOT_IN_COMPANY');
  assert.equal(await contarDoContrato('A:gestor', deA.data.id), 0, 'nenhum lançamento de B ficou ligado ao contrato de A');
  const [linhaB] = await h.sql('B:gestor', 'SELECT count(*)::int AS n FROM finance.financial_entries WHERE contract_id = :id', { id: deA.data.id });
  assert.equal(linhaB.n, 0);

  const inventado = await lancamento('A:gestor', { contractId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(inventado.code, 'FINANCE_ENTRY_CONTRACT_NOT_IN_COMPANY', 'contrato inexistente também é recusado');
  const objeto = await lancamento('A:gestor', { contractId: { id: deA.data.id } });
  assert.equal(objeto.status, 400, 'tipo errado vira 400, nunca 500');

  const proprio = await lancamento('A:gestor', { contractId: deA.data.id });
  assert.equal(proprio.status, 201, JSON.stringify(proprio.body));
  assert.equal(proprio.data.contractId, deA.data.id);
  assert.equal(await contarDoContrato('A:gestor', deA.data.id), 1);
});
