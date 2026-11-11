'use strict';
/**
 * Locação — Reajuste de aluguel (bloco "Correções pós-auditoria — Reajuste"): registro com
 * index_code/period/raw/applied/old/new/rule_version, fonte de índice via adapter, e fonte indisponível
 * = PENDING_SOURCE (nunca percentual inventado). O caminho "fonte disponível" usa o adapter de teste
 * injetado na camada de serviço (a captura não chama a rede do IBGE/FGV).
 */
const { preparo, contratoLocacao, noTenant } = require('../apoio-locacao/preparo');

const RQ = {
  registro: 'M5-A0332-29fd72', pending: 'M5-A0333-f14aaf', eventos: 'M5-A0342-a3762d', apis: 'M5-A0343-c56197',
  testes: 'M5-A0345-019723', dod: 'M5-A0346-86010e', tabelas: 'M5-A0327-22b135',
};

module.exports = async function locacaoReajuste(R) {
  const lc = await preparo(R);
  const H = (o) => R.http(o);
  const ct = await contratoLocacao(R, 'LC-RJ-P1', { propertyId: lc.imovel, locadorId: lc.locador, locatarioId: lc.locatario, valor: 2500 });
  const a = {};
  const rota = '/billing/rent-adjustments';

  await H({ id: 'LC-RJ-01', req: [RQ.registro], titulo: 'Reajuste sem índice e valor anterior é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { contractId: ct.id, period: '2030-01' }, esperado: { status: 400, codigo: 'RENT_ADJUSTMENT_VALIDATION' } });
  await H({ id: 'LC-RJ-02', req: [RQ.registro], titulo: 'Competência do índice fora do formato é recusada', quem: 'A:gestor', metodo: 'POST', rota, corpo: { contractId: ct.id, indexCode: 'INPC', period: '2030/01', oldRentAmount: 2500 }, esperado: { status: 400, codigo: 'RENT_ADJUSTMENT_VALIDATION' } });
  await H({ id: 'LC-RJ-03', req: ['M5-A0325-ad4afe', RQ.pending, RQ.registro, RQ.apis, RQ.testes, RQ.eventos], titulo: 'Índice sem fonte (INPC): reajuste fica PENDING_SOURCE, sem percentual nem aluguel novo', quem: 'A:gestor', metodo: 'POST', rota, corpo: { contractId: ct.id, indexCode: 'INPC', period: '2030-01', oldRentAmount: 2500 }, esperado: { status: 201 }, guardar: (b, x, passo) => { a.pend = b.data.id; if (b.data.status !== 'PENDING_SOURCE' || b.data.rawIndexValue !== null || b.data.appliedPercentage !== null || b.data.newRentAmount !== null) passo.ok = false; } });
  await H({ id: 'LC-RJ-04', req: ['M5-A0332-29fd72', RQ.pending, RQ.dod], titulo: 'IGP-M em modo manual (adapter da FGV sem rede): PENDING_SOURCE', quem: 'A:gestor', metodo: 'POST', rota, corpo: { contractId: ct.id, indexCode: 'IGPM', period: '2030-02', oldRentAmount: 2500 }, esperado: { status: 201 }, guardar: (b, x, passo) => { a.igpm = b.data.id; if (b.data.status !== 'PENDING_SOURCE' || b.data.newRentAmount !== null) passo.ok = false; } });
  await H({ id: 'LC-RJ-05', req: [RQ.registro], titulo: 'Segundo reajuste para a mesma competência é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { contractId: ct.id, indexCode: 'INPC', period: '2030-01', oldRentAmount: 2500 }, esperado: { status: 409, codigo: 'RENT_ADJUSTMENT_DUPLICATE_PERIOD' } });
  await H({ id: 'LC-RJ-06', req: [RQ.apis], titulo: 'Leitura (sem billing:create) não pede reajuste', quem: 'A:leitura', metodo: 'POST', rota, corpo: { contractId: ct.id, indexCode: 'INPC', period: '2030-03', oldRentAmount: 2500 }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });

  const svc = require('../../../src/features/billing/rentAdjustment.service');
  const { createMockIndexSourceAdapter } = require('../../../src/features/billing/adapters/IndexSourceAdapter');
  const fonte = createMockIndexSourceAdapter({ 'IPCA:2030-03': 4.5, 'IPCA:2030-04': 4.5 });
  const pedir = (period, extra) => noTenant(R, (tx, t) => svc.requestRentAdjustment({ groupId: t.groupId, companyId: t.companyId, contractId: ct.id, indexCode: 'IPCA', period, oldRentAmount: 2500, ...extra }, t.userId, tx, fonte));
  await R.servico({ id: 'LC-RJ-07', req: [RQ.registro, RQ.dod], titulo: 'Fonte disponível (adapter): IPCA 4,5% aplicado, 2.500,00 -> 2.612,50, com a versão da regra REG-LOC-003', chamada: 'rentAdjustment.service.requestRentAdjustment(IPCA 2030-03, adapter de fonte)', fn: pedir('2030-03'), esperado: {}, guardar: (r, x, passo) => { a.aplicado = r.id; if (Number(r.newRentAmount) !== 2612.5 || r.status !== 'APPLIED' || !r.ruleVersionId) passo.ok = false; } });
  await R.servico({ id: 'LC-RJ-08', req: [RQ.registro], titulo: 'Percentual negociado (3%) diferente do índice bruto (4,5%): raw e applied guardados separados', chamada: 'rentAdjustment.service.requestRentAdjustment(IPCA 2030-04, appliedPercentageOverride 3)', fn: pedir('2030-04', { appliedPercentageOverride: 3 }), esperado: {}, guardar: (r, x, passo) => { a.negociado = r.id; if (Number(r.rawIndexValue) !== 4.5 || Number(r.appliedPercentage) !== 3 || Number(r.newRentAmount) !== 2575) passo.ok = false; } });
  await R.sqlTenant({
    id: 'LC-RJ-09', req: [RQ.registro, RQ.pending, RQ.tabelas], quem: 'A:gestor', descricao: 'Registro completo: index_code, period, raw, applied, old, new, rule_version e status',
    sql: 'SELECT ra.index_code, ra.period, ra.raw_index_value, ra.applied_percentage, ra.old_rent_amount, ra.new_rent_amount, ra.status, r.code AS regra, rv.version_number FROM finance.rent_adjustments ra LEFT JOIN core.rule_versions rv ON rv.id = ra.rule_version_id LEFT JOIN core.rules r ON r.id = rv.rule_id WHERE ra.contract_id = :c ORDER BY ra.period',
    replacements: () => ({ c: ct.id }),
    avaliar: (rows) => rows.length === 4 && rows.filter((r) => r.status === 'PENDING_SOURCE').every((r) => r.raw_index_value === null && r.new_rent_amount === null) && rows.filter((r) => r.status === 'APPLIED').every((r) => r.regra === 'REG-LOC-003'),
  });
  await R.sqlTenant({ id: 'LC-RJ-10', req: [RQ.eventos], quem: 'A:gestor', descricao: 'Outbox: rent.adjusted para cada reajuste (com o status no payload)', sql: "SELECT aggregate_id, idempotency_key FROM integration.outbox_events WHERE event_type = 'rent.adjusted' AND aggregate_id IN (:ids)", replacements: () => ({ ids: [a.pend, a.igpm, a.aplicado, a.negociado] }), avaliar: (rows) => rows.length === 4 });
  await H({ id: 'LC-RJ-11', req: [RQ.apis, RQ.registro], titulo: 'Lista os reajustes do contrato', quem: 'A:gestor', metodo: 'GET', rota: `${rota}?contractId=${ct.id}`, esperado: { status: 200 } });
  await H({ id: 'LC-RJ-12', req: [RQ.testes], titulo: 'Tenant B não lê o reajuste do tenant A', quem: 'B:gestor', metodo: 'GET', rota: () => `${rota}/${a.aplicado}`, esperado: { status: 404 } });
  R.ctx.lcReajuste = { contrato: ct.id };
};
