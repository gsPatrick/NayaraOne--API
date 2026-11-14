'use strict';
/**
 * Locação — Aluguel garantido x antecipação (bloco "Correções pós-auditoria"): o garantido gera a
 * obrigação da empresa com o proprietário + o crédito a recuperar do locatário; a antecipação é produto
 * separado com elegibilidade/proposta/aceite/pagamento/recuperação e principal e custo separados no
 * Financeiro. O contrato é levado a ACTIVE só por HTTP (máquina de estados real) e fica em R.ctx para o
 * módulo de encerramento.
 */
const { preparo, contratoLocacao, assinarContrato, transicao } = require('../apoio-locacao/preparo');

const RQ = {
  garantido: 'M5-A0335-97ffa9', antecipacao: 'M5-A0336-97de94', eventos: 'M5-A0342-a3762d', apis: 'M5-A0343-c56197',
  testes: 'M5-A0345-019723', dod: 'M5-A0346-86010e', tabelas: 'M5-A0327-22b135',
};

function contratoAtivo(R, lc) {
  // Uma única preparação por captura (os módulos 26 e 27 usam o mesmo contrato); se ela falhar, o 27 recebe o mesmo erro.
  if (!R.ctx.lcAtivoP) {
    R.ctx.lcAtivoP = (async () => {
      const ct = await contratoLocacao(R, 'LC-GR-P1', { propertyId: lc.imovel, locadorId: lc.locador, locatarioId: lc.locatario, valor: 2500 });
      await assinarContrato(R, 'LC-GR-P2', ct.id, { locadorId: lc.locador, locatarioId: lc.locatario });
      await transicao(R, 'LC-GR-P3', ct.id, 'ACTIVE', { titulo: 'Preparação: contrato SIGNED -> ACTIVE (gate de ativação reconfere documento e assinaturas)' });
      return ct;
    })();
  }
  return R.ctx.lcAtivoP;
}

module.exports = async function locacaoGarantido(R) {
  const lc = await preparo(R);
  const H = (o) => R.http(o);
  const ct = await contratoAtivo(R, lc);
  const g = {};

  // ---------- aluguel garantido ----------
  await H({ id: 'LC-GR-01', req: [RQ.garantido], titulo: 'Aluguel garantido sem início de cobertura é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/billing/guaranteed-rent', corpo: { contractId: ct.id }, esperado: { status: 400, codigo: 'GUARANTEED_RENT_VALIDATION' } });
  await H({ id: 'LC-GR-02', req: [RQ.garantido, RQ.apis], titulo: 'Contrato matriculado no aluguel garantido', quem: 'A:gestor', metodo: 'POST', rota: '/billing/guaranteed-rent', corpo: { contractId: ct.id, coverageStartsAt: '2030-01-01' }, esperado: { status: 201 }, guardar: (b) => { g.gr = b.data.id; } });
  await H({ id: 'LC-GR-03', req: [RQ.garantido], titulo: 'Matricular o mesmo contrato de novo é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/billing/guaranteed-rent', corpo: { contractId: ct.id, coverageStartsAt: '2030-01-01' }, esperado: { status: 409, codigo: 'GUARANTEED_RENT_DUPLICATE' } });
  await H({ id: 'LC-GR-04', req: [RQ.garantido], titulo: 'Pagamento do garantido sem competência é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/guaranteed-rent/${g.gr}/pay`, corpo: { amount: 2500 }, esperado: { status: 400, codigo: 'GUARANTEED_RENT_PAYMENT_VALIDATION' } });
  await H({ id: 'LC-GR-05', req: [RQ.garantido], titulo: 'Leitura (sem billing:approve) não paga o garantido', quem: 'A:leitura', metodo: 'POST', rota: () => `/billing/guaranteed-rent/${g.gr}/pay`, corpo: { period: '2030-01', amount: 2500 }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-GR-06', req: ['M5-A0325-ad4afe', RQ.garantido, RQ.apis, RQ.eventos, RQ.testes], titulo: 'Paga o garantido da competência 2030-01: obrigação ao proprietário + crédito a recuperar do locatário', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/guaranteed-rent/${g.gr}/pay`, corpo: { period: '2030-01', amount: 2500 }, esperado: { status: 200 }, guardar: (b) => { g.pagar = b.data.payableEntry.id; g.receber = b.data.receivableEntry.id; } });
  await H({ id: 'LC-GR-07', req: [RQ.garantido, RQ.dod], titulo: 'Pagar a mesma competência de novo é recusado (idempotência por competência)', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/guaranteed-rent/${g.gr}/pay`, corpo: { period: '2030-01', amount: 2500 }, esperado: { status: 409, codigo: 'GUARANTEED_RENT_PAYMENT_DUPLICATE' } });
  await R.sqlTenant({ id: 'LC-GR-08', req: [RQ.garantido], quem: 'A:gestor', descricao: 'Dois lançamentos do garantido: PAYABLE (empresa -> proprietário) e RECEIVABLE (locatário -> empresa), mesmo contrato e valor', sql: 'SELECT id, nature, entry_type, amount, contract_id, description FROM finance.financial_entries WHERE id IN (:a, :b) ORDER BY nature', replacements: () => ({ a: g.pagar, b: g.receber }), avaliar: (rows) => rows.length === 2 && rows.some((r) => r.nature === 'PAYABLE') && rows.some((r) => r.nature === 'RECEIVABLE') && rows.every((r) => r.contract_id === ct.id && Number(r.amount) === 2500) });
  await R.sqlTenant({ id: 'LC-GR-09', req: [RQ.eventos, RQ.garantido], quem: 'A:gestor', descricao: 'Outbox: guaranteed_rent.paid da competência', sql: "SELECT event_type, idempotency_key FROM integration.outbox_events WHERE event_type = 'guaranteed_rent.paid' AND aggregate_id = :id", replacements: () => ({ id: g.gr }), avaliar: (rows) => rows.length === 1 });

  // ---------- antecipação: produto separado ----------
  const rascunho = await contratoLocacao(R, 'LC-GR-P4', { propertyId: lc.imovel, locadorId: lc.locador, locatarioId: lc.locatario, valor: 2500 });
  await H({ id: 'LC-GR-10', req: [RQ.antecipacao], titulo: 'Elegibilidade: contrato que não está ACTIVE não pode antecipar', quem: 'A:gestor', metodo: 'POST', rota: '/billing/rent-advances', corpo: { contractId: rascunho.id, monthsAdvanced: 3, principalAmount: 7500, costAmount: 450 }, esperado: { status: 422, codigo: 'RENT_ADVANCE_NOT_ELIGIBLE' } });
  await H({ id: 'LC-GR-11', req: [RQ.antecipacao], titulo: 'Antecipação sem meses e principal é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/billing/rent-advances', corpo: { contractId: ct.id }, esperado: { status: 400, codigo: 'RENT_ADVANCE_VALIDATION' } });
  await H({ id: 'LC-GR-12', req: [RQ.antecipacao, RQ.apis], titulo: 'Pedido de antecipação (3 meses, principal 7.500,00, custo 450,00): ELIGIBILITY_PENDING', quem: 'A:gestor', metodo: 'POST', rota: '/billing/rent-advances', corpo: { contractId: ct.id, monthsAdvanced: 3, principalAmount: 7500, costAmount: 450 }, esperado: { status: 201 }, guardar: (b) => { g.adv = b.data.id; } });
  const adv = (sufixo) => () => `/billing/rent-advances/${g.adv}/${sufixo}`;
  await H({ id: 'LC-GR-13', req: [RQ.antecipacao], titulo: 'Pagar antes de proposta e aceite é recusado', quem: 'A:gestor', metodo: 'POST', rota: adv('pay'), corpo: {}, esperado: { status: 409, codigo: 'RENT_ADVANCE_INVALID_STATUS' } });
  await H({ id: 'LC-GR-14', req: [RQ.antecipacao, RQ.apis], titulo: 'Proposta da antecipação (PROPOSED)', quem: 'A:gestor', metodo: 'POST', rota: adv('propose'), corpo: {}, esperado: { status: 200 } });
  await H({ id: 'LC-GR-15', req: [RQ.antecipacao], titulo: 'Leitura (sem billing:approve) não aceita a antecipação', quem: 'A:leitura', metodo: 'POST', rota: adv('accept'), corpo: {}, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-GR-16', req: [RQ.antecipacao, RQ.apis], titulo: 'Aceite da antecipação (ACCEPTED)', quem: 'A:gestor', metodo: 'POST', rota: adv('accept'), corpo: {}, esperado: { status: 200 } });
  await H({ id: 'LC-GR-17', req: [RQ.antecipacao, RQ.apis, RQ.testes], titulo: 'Pagamento da antecipação: principal e custo em lançamentos separados', quem: 'A:gestor', metodo: 'POST', rota: adv('pay'), corpo: {}, esperado: { status: 200 } });
  await H({ id: 'LC-GR-18', req: [RQ.antecipacao], titulo: 'Recuperação acima do saldo é recusada', quem: 'A:gestor', metodo: 'POST', rota: adv('recover'), corpo: { amountRecovered: 99999 }, esperado: { status: 409, codigo: 'RENT_ADVANCE_RECOVERY_EXCEEDS_BALANCE' } });
  await H({ id: 'LC-GR-19', req: [RQ.antecipacao], titulo: 'Recuperação parcial (450,00 = custo primeiro): RECOVERING', quem: 'A:gestor', metodo: 'POST', rota: adv('recover'), corpo: { amountRecovered: 450 }, esperado: { status: 200 } });
  await H({ id: 'LC-GR-20', req: ['M5-A0325-ad4afe', RQ.antecipacao, RQ.eventos], titulo: 'Recuperação do principal (7.500,00): RECOVERED e advance.completed', quem: 'A:gestor', metodo: 'POST', rota: adv('recover'), corpo: { amountRecovered: 7500 }, esperado: { status: 200 }, guardar: (b, x, passo) => { if (!b.data || b.data.status !== 'RECOVERED') passo.ok = false; } });
  await R.sqlTenant({ id: 'LC-GR-21', req: [RQ.antecipacao], quem: 'A:gestor', descricao: 'Lançamentos da antecipação: principal e custo separados (valores 7.500,00 e 450,00)', sql: "SELECT nature, entry_type, amount, description FROM finance.financial_entries WHERE contract_id = :c AND (description ILIKE '%antecipa%') ORDER BY created_at", replacements: () => ({ c: ct.id }), avaliar: (rows) => rows.some((r) => Number(r.amount) === 7500) && rows.some((r) => Number(r.amount) === 450) });
  await R.sqlTenant({ id: 'LC-GR-22', req: [RQ.antecipacao, RQ.garantido, RQ.tabelas, RQ.testes], quem: 'A:gestor', descricao: 'Produtos em tabelas separadas: guaranteed_rent_contracts x rent_advances do mesmo contrato', sql: 'SELECT (SELECT count(*)::int FROM finance.guaranteed_rent_contracts WHERE contract_id = :c) AS garantido, (SELECT count(*)::int FROM finance.rent_advances WHERE contract_id = :c) AS antecipacoes, (SELECT status FROM finance.rent_advances WHERE id = :a) AS status_antecipacao', replacements: () => ({ c: ct.id, a: g.adv }), avaliar: (rows) => rows[0].garantido === 1 && rows[0].antecipacoes === 1 && rows[0].status_antecipacao === 'RECOVERED' });
  await R.sqlTenant({ id: 'LC-GR-23', req: [RQ.eventos, RQ.antecipacao], quem: 'A:gestor', descricao: 'Outbox: advance.completed da antecipação', sql: "SELECT event_type, idempotency_key FROM integration.outbox_events WHERE event_type = 'advance.completed' AND aggregate_id = :id", replacements: () => ({ id: g.adv }), avaliar: (rows) => rows.length === 1 });
  await H({ id: 'LC-GR-24', req: [RQ.testes], titulo: 'Tenant B não lê a antecipação do tenant A', quem: 'B:gestor', metodo: 'GET', rota: adv(''), esperado: { status: 404 } });

  await H({ id: 'LC-GR-25', req: [RQ.antecipacao, RQ.apis], titulo: 'Pentest: objeto no lugar do id do contrato na antecipação é 400, não 500', quem: 'A:gestor', metodo: 'POST', rota: '/billing/rent-advances', corpo: { contractId: { $gt: '' }, monthsAdvanced: 1, principalAmount: 100 }, esperado: { status: 400, codigo: 'RENT_ADVANCE_VALIDATION' } });
  await H({ id: 'LC-GR-26', req: [RQ.garantido], titulo: 'Pentest: competência longa demais no pagamento do garantido é 400', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/guaranteed-rent/${g.gr}/pay`, corpo: { period: 'x'.repeat(300), amount: 10 }, esperado: { status: 400, codigo: 'GUARANTEED_RENT_PAYMENT_VALIDATION' } });
  R.ctx.lcGarantido = { contrato: ct.id, ...g };
};

module.exports.contratoAtivo = contratoAtivo;
