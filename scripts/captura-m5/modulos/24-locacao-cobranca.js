'use strict';
/**
 * Locação — Cobrança por competência (bloco "Correções pós-auditoria — Cobrança de locação"):
 * competência única, componentes separados, pagamento parcial que recompõe saldo, multa/juros/carência
 * e régua (cadência) pelo Motor de Regras, acordo versionado que não apaga a dívida, eventos e APIs.
 */
const { preparo, contratoLocacao, noTenant } = require('../apoio-locacao/preparo');

const RQ = {
  status: 'M5-A0325-ad4afe', tabelas: 'M5-A0327-22b135', competencia: 'M5-A0329-5e6273', motor: 'M5-A0330-f7218c',
  eventos: 'M5-A0342-a3762d', apis: 'M5-A0343-c56197', testes: 'M5-A0345-019723', dod: 'M5-A0346-86010e',
};

module.exports = async function locacaoCobranca(R) {
  const lc = await preparo(R);
  const H = (o) => R.http(o);
  const ct = await contratoLocacao(R, 'LC-CO-P1', { propertyId: lc.imovel, locadorId: lc.locador, locatarioId: lc.locatario, valor: 2500 });
  const c = {};
  const { seedBillingRules } = require('../../../scripts/seedBillingRules');
  await R.servico({ id: 'LC-CO-P2', req: [RQ.motor], titulo: 'Preparação: publica no Motor de Regras do tenant A as regras de locação (REG-LOC-001 multa/juros, 002 carência, 003 reajuste, 004 régua) pelo seed oficial', chamada: 'scripts/seedBillingRules.seedBillingRules(tenant A)', fn: noTenant(R, (tx, t) => seedBillingRules({ groupId: t.groupId, companyId: t.companyId, userId: t.userId }, tx)), esperado: {} });

  const itens = [
    { componentType: 'RENT', amount: 2500, description: 'Aluguel' },
    { componentType: 'CONDO', amount: 600.1, description: 'Condomínio' },
    { componentType: 'IPTU', amount: 120.35, description: 'IPTU (parcela)' },
  ];
  await H({ id: 'LC-CO-01', req: [RQ.competencia], titulo: 'Competência sem componentes é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/billing/schedules', corpo: { contractId: ct.id, period: '2030-01', dueDate: '2030-01-10' }, esperado: { status: 400, codigo: 'BILLING_SCHEDULE_VALIDATION' } });
  await H({ id: 'LC-CO-02', req: [RQ.competencia], titulo: 'Competência fora do formato AAAA-MM é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/billing/schedules', corpo: { contractId: ct.id, period: '01/2030', dueDate: '2030-01-10', items: itens }, esperado: { status: 400, codigo: 'BILLING_SCHEDULE_VALIDATION' } });
  await H({ id: 'LC-CO-03', req: [RQ.competencia], titulo: 'Componente fora da lista é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/billing/schedules', corpo: { contractId: ct.id, period: '2030-01', dueDate: '2030-01-10', items: [{ componentType: 'GORJETA', amount: 10 }] }, esperado: { status: 400, codigo: 'BILLING_SCHEDULE_VALIDATION' } });
  await H({ id: 'LC-CO-04', req: ['M5-A0325-ad4afe', RQ.competencia, RQ.apis, RQ.eventos, RQ.testes], titulo: 'Gera a competência 2030-01 com aluguel, condomínio e IPTU separados (total 3.220,45)', quem: 'A:gestor', metodo: 'POST', rota: '/billing/schedules', corpo: { contractId: ct.id, period: '2030-01', dueDate: '2030-01-10', items: itens }, esperado: { status: 201 }, guardar: (b, x, passo) => { c.s1 = b.data.id; if (Number(b.data.totalAmount) !== 3220.45) passo.ok = false; } });
  await H({ id: 'LC-CO-05', req: [RQ.competencia, RQ.testes], titulo: 'Competência duplicada (mesmo contrato e mês) é bloqueada', quem: 'A:gestor', metodo: 'POST', rota: '/billing/schedules', corpo: { contractId: ct.id, period: '2030-01', dueDate: '2030-01-15', items: itens }, esperado: { status: 409, codigo: 'BILLING_SCHEDULE_DUPLICATE_PERIOD' } });
  await H({ id: 'LC-CO-06', req: [RQ.competencia], titulo: 'Competência com os componentes em itens próprios', quem: 'A:gestor', metodo: 'GET', rota: () => `/billing/schedules/${c.s1}`, esperado: { status: 200 }, guardar: (b, x, passo) => { if (!b.data.items || b.data.items.length !== 3) passo.ok = false; } });
  await R.sqlCatalogo({ id: 'LC-CO-07', req: [RQ.competencia, RQ.tabelas], descricao: 'Índice único (contract_id, period) em finance.billing_schedules', sql: "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'finance' AND tablename = 'billing_schedules' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%contract_id%' AND indexdef ILIKE '%period%'", avaliar: (rows) => rows.length >= 1 });
  await H({ id: 'LC-CO-08', req: [RQ.competencia, RQ.testes], titulo: 'Pagamento parcial de 1.000,00 recompõe o saldo (2.220,45) e deixa PARTIALLY_PAID', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/schedules/${c.s1}/payments`, corpo: { amountPaid: 1000 }, esperado: { status: 200 }, guardar: (b, x, passo) => { if (b.data.status !== 'PARTIALLY_PAID' || Number(b.data.balance) !== 2220.45) passo.ok = false; } });
  await H({ id: 'LC-CO-09', req: [RQ.competencia], titulo: 'Pagamento acima do saldo é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/schedules/${c.s1}/payments`, corpo: { amountPaid: 5000 }, esperado: { status: 400, codigo: 'BILLING_SCHEDULE_OVERPAYMENT' } });
  await H({ id: 'LC-CO-10', req: [RQ.apis], titulo: 'Leitura (sem billing:update) não registra pagamento', quem: 'A:leitura', metodo: 'POST', rota: () => `/billing/schedules/${c.s1}/payments`, corpo: { amountPaid: 10 }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-CO-11', req: [RQ.testes], titulo: 'Tenant B não lê a competência do tenant A (RLS)', quem: 'B:gestor', metodo: 'GET', rota: () => `/billing/schedules/${c.s1}`, esperado: { status: 404 } });

  // ---------- caso de cobrança: carência, multa e juros pelo Motor de Regras ----------
  await H({ id: 'LC-CO-12', req: [RQ.motor], titulo: 'Atraso de 2 dias está dentro da carência (REG-LOC-002): caso não é aberto', quem: 'A:gestor', metodo: 'POST', rota: '/billing/collection-cases', corpo: () => ({ billingScheduleId: c.s1, daysPastDue: 2 }), esperado: { status: 409, codigo: 'COLLECTION_CASE_WITHIN_GRACE_PERIOD' } });
  await H({ id: 'LC-CO-13', req: [RQ.motor, RQ.apis, RQ.eventos, RQ.dod], titulo: 'Atraso de 33 dias: caso aberto com multa 2% e juros 1% a.m. sobre o saldo, pró-rata após 3 dias de carência', quem: 'A:gestor', metodo: 'POST', rota: '/billing/collection-cases', corpo: () => ({ billingScheduleId: c.s1, daysPastDue: 33 }), esperado: { status: 201 }, guardar: (b, x, passo) => { c.caso = b.data.id; if (Number(b.data.penaltyAmount) !== 44.41 || Number(b.data.interestAmount) !== 22.2 || Number(b.data.originalDebtAmount) !== 2220.45) passo.ok = false; } });
  await H({ id: 'LC-CO-14', req: [RQ.motor], titulo: 'Segundo caso para a mesma competência é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/billing/collection-cases', corpo: () => ({ billingScheduleId: c.s1, daysPastDue: 40 }), esperado: { status: 409, codigo: 'COLLECTION_CASE_DUPLICATE' } });
  await R.sqlTenant({ id: 'LC-CO-15', req: [RQ.motor, RQ.dod], quem: 'A:gestor', descricao: 'Caso gravado com as versões das regras de multa/juros e carência do Motor de Regras', sql: 'SELECT cc.original_debt_amount, cc.penalty_amount, cc.interest_amount, cc.grace_days_applied, rv1.status AS regra_multa, r1.code AS cod_multa, rv2.status AS regra_carencia, r2.code AS cod_carencia FROM finance.collection_cases cc JOIN core.rule_versions rv1 ON rv1.id = cc.penalty_rule_version_id JOIN core.rules r1 ON r1.id = rv1.rule_id JOIN core.rule_versions rv2 ON rv2.id = cc.grace_rule_version_id JOIN core.rules r2 ON r2.id = rv2.rule_id WHERE cc.id = :id', replacements: () => ({ id: c.caso }), avaliar: (rows) => rows.length === 1 && rows[0].cod_multa === 'REG-LOC-001' && rows[0].cod_carencia === 'REG-LOC-002' && rows[0].grace_days_applied === 3 });

  // ---------- acordo versionado não apaga a dívida ----------
  await H({ id: 'LC-CO-16', req: [RQ.motor], titulo: 'Acordo sem parcelas e valor é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/collection-cases/${c.caso}/agreements`, corpo: { notes: 'sem dados' }, esperado: { status: 400, codigo: 'COLLECTION_AGREEMENT_VALIDATION' } });
  await H({ id: 'LC-CO-17', req: [RQ.motor, RQ.apis], titulo: 'Acordo v1: 3 parcelas, 2.287,06', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/collection-cases/${c.caso}/agreements`, corpo: { installments: 3, agreedAmount: 2287.06, notes: 'Primeira proposta' }, esperado: { status: 201 } });
  await H({ id: 'LC-CO-18', req: [RQ.motor, RQ.apis], titulo: 'Acordo v2 substitui o v1 sem apagá-lo: 4 parcelas, 2.300,00', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/collection-cases/${c.caso}/agreements`, corpo: { installments: 4, agreedAmount: 2300, notes: 'Renegociado' }, esperado: { status: 201 } });
  await R.sqlTenant({ id: 'LC-CO-19', req: [RQ.motor], quem: 'A:gestor', descricao: 'Histórico do acordo (v1 e v2) preservado e dívida original intacta', sql: "SELECT status, original_debt_amount, current_balance, jsonb_array_length(agreements_json::jsonb) AS versoes, agreements_json FROM finance.collection_cases WHERE id = :id", replacements: () => ({ id: c.caso }), avaliar: (rows) => rows.length === 1 && rows[0].versoes === 2 && Number(rows[0].original_debt_amount) === 2220.45 && rows[0].status === 'AGREEMENT' });
  await R.sqlTenant({ id: 'LC-CO-20', req: [RQ.eventos], quem: 'A:gestor', descricao: 'Outbox: billing.generated da competência e charge.overdue do caso', sql: "SELECT event_type, aggregate_id FROM integration.outbox_events WHERE (event_type = 'billing.generated' AND aggregate_id = :s) OR (event_type = 'charge.overdue' AND aggregate_id = :k)", replacements: () => ({ s: c.s1, k: c.caso }), avaliar: (rows) => rows.length === 2 });

  // ---------- régua de cobrança (cadência) pelo Motor de Regras ----------
  await H({ id: 'LC-CO-21', req: [RQ.motor], titulo: 'Régua vigente (REG-LOC-004) e histórico de versões', quem: 'A:gestor', metodo: 'GET', rota: '/billing/collection-cadence', esperado: { status: 200 } });
  await H({ id: 'LC-CO-22', req: [RQ.motor], titulo: 'Leitura (sem billing:cadence:manage) não publica régua', quem: 'A:leitura', metodo: 'POST', rota: '/billing/collection-cadence/versions', corpo: { steps: [{ code: 'NOTICE_D1', offsetDays: 1, action: 'NOTIFY' }] }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-CO-23', req: [RQ.motor, RQ.dod], titulo: 'Publica nova versão da régua: lembrete D-3, aviso D+1, tarefa D+15, jurídico D+30', quem: 'A:gestor', metodo: 'POST', rota: '/billing/collection-cadence/versions', corpo: { steps: [{ code: 'REMINDER_D-3', offsetDays: -3, action: 'NOTIFY' }, { code: 'NOTICE_D1', offsetDays: 1, action: 'NOTIFY' }, { code: 'TASK_D15', offsetDays: 15, action: 'TASK' }, { code: 'LEGAL_D30', offsetDays: 30, action: 'ESCALATE_LEGAL' }] }, esperado: { status: 201 } });
  await H({ id: 'LC-CO-24', req: [RQ.motor], titulo: 'Régua com etapa inválida é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/billing/collection-cadence/versions', corpo: { steps: [{ code: 'x', offsetDays: 9999, action: 'APAGAR_DIVIDA' }] }, esperado: { status: 400 } });
  await H({ id: 'LC-CO-25', req: [RQ.competencia, RQ.motor], titulo: 'Competência 2030-02 em aberto para a régua', quem: 'A:gestor', metodo: 'POST', rota: '/billing/schedules', corpo: { contractId: ct.id, period: '2030-02', dueDate: '2030-02-10', items: [{ componentType: 'RENT', amount: 2500 }] }, esperado: { status: 201 }, guardar: (b) => { c.s2 = b.data.id; } });
  const cad = require('../../../src/features/billing/collectionCadence.service');
  const quando = new Date('2030-02-11T15:00:00Z');
  await R.servico({ id: 'LC-CO-26', req: [RQ.motor, RQ.dod], titulo: 'Job da régua no dia 11/02/2030 (D+1): executa o aviso D+1 da versão publicada', chamada: 'collectionCadence.service.runCollectionCadence(tx, { now: 2030-02-11, contractId })', fn: noTenant(R, (tx) => cad.runCollectionCadence(tx, { now: quando, contractId: ct.id })), esperado: {} });
  await R.servico({ id: 'LC-CO-27', req: [RQ.motor, RQ.dod], titulo: 'Job da régua de novo no mesmo dia não repete a etapa (idempotente)', chamada: 'collectionCadence.service.runCollectionCadence(tx, { now: 2030-02-11, contractId }) — 2ª vez', fn: noTenant(R, (tx) => cad.runCollectionCadence(tx, { now: quando, contractId: ct.id })), esperado: {} });
  await H({ id: 'LC-CO-28', req: [RQ.motor], titulo: 'Etapas executadas da régua para a competência 2030-02', quem: 'A:gestor', metodo: 'GET', rota: () => `/billing/collection-cadence/steps?billingScheduleId=${c.s2}`, esperado: { status: 200 } });
  await R.sqlTenant({ id: 'LC-CO-29', req: [RQ.motor, RQ.dod], quem: 'A:gestor', descricao: 'Uma linha por etapa da régua (sem duplicar) e a dívida da competência intocada', sql: "SELECT s.step_code, count(*)::int AS vezes, max(b.balance) AS saldo FROM finance.collection_cadence_steps s JOIN finance.billing_schedules b ON b.id = s.billing_schedule_id WHERE s.billing_schedule_id = :id GROUP BY s.step_code", replacements: () => ({ id: c.s2 }), avaliar: (rows) => rows.length >= 1 && rows.every((r) => r.vezes === 1 && Number(r.saldo) === 2500) });

  // ---------- quitação ----------
  await H({ id: 'LC-CO-30', req: [RQ.competencia], titulo: 'Pagamento do saldo restante quita a competência 2030-01 (PAID)', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/schedules/${c.s1}/payments`, corpo: { amountPaid: 2220.45 }, esperado: { status: 200 }, guardar: (b, x, passo) => { if (b.data.status !== 'PAID' || Number(b.data.balance) !== 0) passo.ok = false; } });
  await H({ id: 'LC-CO-31', req: [RQ.competencia], titulo: 'Competência quitada não aceita novo pagamento', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/schedules/${c.s1}/payments`, corpo: { amountPaid: 1 }, esperado: { status: 409, codigo: 'BILLING_SCHEDULE_ALREADY_PAID' } });

  R.ctx.lcCobranca = { contrato: ct.id, ...c };
};
