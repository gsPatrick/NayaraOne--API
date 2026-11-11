'use strict';
/**
 * Locação — Encerramento (closeout) e travas finais (Caderno M5 §12, bloco "Correções pós-auditoria —
 * Utilidades/Eventos/APIs/Testes/DoD"): gate único bloqueia com cobrança em aberto e troca de
 * titularidade de água e luz pendente, publica closeout.blocked; resolvidas as pendências, closeout
 * concluído leva o contrato a CLOSED sem apagar obrigações nem créditos. Inclui a vistoria de outro
 * contrato do mesmo imóvel (não libera chaves) e o catálogo/RLS das tabelas da cobrança.
 */
const { preparo, arquivo, noTenant } = require('../apoio-locacao/preparo');
const { contratoAtivo } = require('./26-locacao-garantido');

const RQ = {
  evtInicia: 'M5-A0086-fda035', periodicidade: 'M5-A0094-c81c5a', pendencia: 'M5-A0096-30165c', titularidade: 'M5-A0095-1df93e', vistoria: 'M5-A0081-9fbe36', jur005: 'M5-A0303-33ee80',
  status: 'M5-A0325-ad4afe', tabelas: 'M5-A0327-22b135', encerra: 'M5-A0340-79a98a', eventos: 'M5-A0342-a3762d',
  apis: 'M5-A0343-c56197', testes: 'M5-A0345-019723', dod: 'M5-A0346-86010e', dod1: 'M5-A0171-80da7b', dod2: 'M5-A0270-5f73bd',
};
const TABELAS = ['billing_schedules', 'billing_schedule_items', 'rent_adjustments', 'collection_cases', 'guaranteed_rent_contracts', 'rent_advances', 'utility_accounts', 'utility_reimbursements', 'ownership_transfer_tasks'];

module.exports = async function locacaoEncerramento(R) {
  const lc = await preparo(R);
  const H = (o) => R.http(o);
  const ct = await contratoAtivo(R, lc);
  const e = {};
  const elig = `/billing/contracts/${ct.id}/closeout-eligibility`;
  const tipos = (b) => ((b && b.data && b.data.reasons) || []).map((r) => r.type);

  // ---------- vistoria de OUTRO contrato do mesmo imóvel não libera chaves ----------
  await H({ id: 'LC-EN-01', req: [RQ.vistoria], titulo: 'Entrega de chaves do contrato ACTIVE que não tem vistoria própria', quem: 'A:gestor', metodo: 'POST', rota: '/legal/key-deliveries', corpo: { contractId: ct.id, deliveredToPersonId: lc.locatario }, esperado: { status: 201 }, guardar: (b) => { e.kd = b.data.id; } });
  const viaPrevia = await arquivo(R, 'LC-EN-31', 'Via do termo de entrega assinada (arquivo fictício) para a primeira tentativa', 'termo-g0.pdf', `Termo 0 ${lc.sfx}`, 'application/pdf', [RQ.vistoria]);
  await H({ id: 'LC-EN-02', req: ['M5-A0257-fbc50c', RQ.vistoria, RQ.jur005], titulo: 'Vistoria de entrada assinada de outro contrato do mesmo imóvel não serve: entrega bloqueada', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/key-deliveries/${e.kd}/release`, corpo: { keysCount: 2, keysIdentification: '2 chaves', termSignedByPersonId: lc.locatario, termEvidenceFileId: viaPrevia }, esperado: { status: 409, codigo: 'LEGAL_KEY_DELIVERY_BLOCKED' } });
  await R.sqlTenant({ id: 'LC-EN-03', req: [RQ.vistoria], quem: 'A:leitura', descricao: 'O imóvel tem vistoria de entrada concluída e assinada em outro contrato; o contrato ACTIVE não tem nenhuma', sql: "SELECT i.contract_id, i.inspection_type, i.status, (SELECT count(*)::int FROM legal.inspection_signatures s WHERE s.inspection_id = i.id) AS assinaturas FROM legal.inspections i WHERE i.property_id = :p AND i.inspection_type = 'ENTRY' AND i.status = 'COMPLETED'", replacements: () => ({ p: lc.imovel }), avaliar: (rows) => rows.some((r) => r.assinaturas >= 2 && r.contract_id !== ct.id) && !rows.some((r) => r.contract_id === ct.id) });

  // ---------- pendências críticas bloqueiam ----------
  await H({ id: 'LC-EN-04', req: [RQ.encerra], titulo: 'Competência 2030-06 em aberto', quem: 'A:gestor', metodo: 'POST', rota: '/billing/schedules', corpo: { contractId: ct.id, period: '2030-06', dueDate: '2030-06-10', items: [{ componentType: 'RENT', amount: 2500 }] }, esperado: { status: 201 }, guardar: (b) => { e.s = b.data.id; } });
  for (const [id, tipo, chave] of [['LC-EN-05', 'WATER', 'agua'], ['LC-EN-06', 'ELECTRICITY', 'luz']]) {
    await H({ id, req: [RQ.titularidade, RQ.encerra], titulo: `Obrigação ${tipo === 'WATER' ? 'de água' : 'de luz'} com troca de titularidade para o locatário`, quem: 'A:gestor', metodo: 'POST', rota: '/billing/utility-obligations', corpo: { contractId: ct.id, utilityType: tipo, responsibleParty: 'TENANT', provider: `${tipo === 'WATER' ? 'Água' : 'Energia'} Fictícia`, accountNumber: `${chave}-${lc.sfx}`, transferRequired: true, transferFromPersonId: lc.locador, transferToPersonId: lc.locatario }, esperado: { status: 201 }, guardar: (b) => { e[chave] = b.data.transferTask.id; } });
  }
  await H({ id: 'LC-EN-07', req: [RQ.encerra, RQ.pendencia, RQ.apis], titulo: 'Elegibilidade: não elegível, com cobrança em aberto e troca de titularidade pendente', quem: 'A:gestor', metodo: 'GET', rota: elig, esperado: { status: 200 }, guardar: (b, x, passo) => { const t = tipos(b); if (b.data.eligible !== false || !t.includes('OPEN_BILLING') || !t.includes('PENDING_UTILITY_TRANSFER')) passo.ok = false; } });
  await H({ id: 'LC-EN-08', req: [RQ.encerra, RQ.pendencia, RQ.apis, RQ.testes, RQ.eventos], titulo: 'Encerrar com pendência crítica é bloqueado (CLOSEOUT_BLOCKED com os motivos)', quem: 'A:gestor', metodo: 'POST', rota: `/billing/contracts/${ct.id}/closeout`, corpo: {}, esperado: { status: 409, codigo: 'CLOSEOUT_BLOCKED' } });
  await R.sqlTenant({ id: 'LC-EN-09', req: [RQ.eventos, RQ.encerra, RQ.dod], quem: 'A:gestor', descricao: 'Outbox: closeout.blocked gravado mesmo com a recusa 409 (motivos no payload)', sql: "SELECT event_type, payload_json FROM integration.outbox_events WHERE event_type = 'closeout.blocked' AND aggregate_id = :c", replacements: () => ({ c: ct.id }), avaliar: (rows) => rows.length >= 1 });
  await R.sqlTenant({ id: 'LC-EN-10', req: [RQ.encerra], quem: 'A:gestor', descricao: 'Trilha de auditoria do encerramento bloqueado', sql: "SELECT action, after_json->'reasons' AS motivos FROM audit.audit_log WHERE action = 'billing.closeout.blocked' AND entity_id = :c", replacements: () => ({ c: ct.id }), avaliar: (rows) => rows.length >= 1 });
  await H({ id: 'LC-EN-11', req: [RQ.apis], titulo: 'Leitura (sem billing:update) não encerra', quem: 'A:leitura', metodo: 'POST', rota: `/billing/contracts/${ct.id}/closeout`, corpo: {}, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-EN-12', req: [RQ.testes], titulo: 'Tenant B não consulta o encerramento do contrato do tenant A', quem: 'B:gestor', metodo: 'GET', rota: elig, esperado: { status: 404 } });

  // ---------- keys.delivered inicia as obrigações da locação (Caderno §10; M5-D103) ----------
  await H({ id: 'LC-EN-23', req: [RQ.vistoria], titulo: 'Vistoria de entrada do próprio contrato ACTIVE', quem: 'A:gestor', metodo: 'POST', rota: '/legal/inspections', corpo: { propertyId: lc.imovel, contractId: ct.id, inspectionType: 'ENTRY' }, esperado: { status: 201 }, guardar: (b) => { e.ins = b.data.id; } });
  await H({ id: 'LC-EN-24', req: [RQ.vistoria], titulo: 'Conclui a vistoria de entrada', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${e.ins}/complete`, corpo: {}, esperado: { status: 200 } });
  const insp = require('../../../src/modules/legal/inspections/inspection.service');
  for (const [id, papel] of [['LC-EN-25', 'LANDLORD'], ['LC-EN-26', 'TENANT']]) {
    await R.servico({ id, req: [RQ.vistoria], titulo: `${papel === 'LANDLORD' ? 'Locador' : 'Locatário'} assina a vistoria de entrada (camada de serviço; a rota exige MFA)`, chamada: `inspections.service.signInspection(ins, {${papel}})`, fn: noTenant(R, (tx, t) => insp.signInspection(e.ins, { partyRole: papel, signaturePayload: `Aceite ${papel}` }, t.userId, tx)), esperado: {} });
  }
  const via = await arquivo(R, 'LC-EN-27', 'Via do termo de entrega assinada pelo locatário (arquivo fictício)', 'termo-g.pdf', `Termo ${lc.sfx}`, 'application/pdf', [RQ.evtInicia]);
  await H({ id: 'LC-EN-28', req: [RQ.evtInicia, RQ.vistoria], titulo: 'Chaves entregues com a vistoria do próprio contrato e o termo assinado', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/key-deliveries/${e.kd}/release`, corpo: { keysCount: 2, keysIdentification: '2 chaves da porta', termSignedByPersonId: lc.locatario, termEvidenceFileId: via }, esperado: { status: 200 } });
  const { OutboxEvent } = require('../../../src/models');
  const { runEventConsumers } = require('../../../src/engines/events/consumers');
  require('../../../src/features/billing/keysDeliveredObligations.consumer');
  await R.servico({
    id: 'LC-EN-29', req: [RQ.evtInicia, RQ.periodicidade, RQ.titularidade], titulo: 'Motor de eventos entrega keys.delivered aos consumidores: o da locação inicia as obrigações (início, próximo vencimento, prazo da troca de titularidade)',
    chamada: 'engines/events/consumers.runEventConsumers(keys.delivered)', esperado: {},
    fn: noTenant(R, async (tx) => { const ev = await OutboxEvent.findOne({ where: { eventType: 'keys.delivered', aggregateId: e.kd }, transaction: tx }); return { consumidores: await runEventConsumers(ev, tx) }; }),
    guardar: (r, x, passo) => { if (!r.consumidores.includes('locacao.obrigacoes')) passo.ok = false; },
  });
  await R.sqlTenant({
    id: 'LC-EN-30', req: [RQ.evtInicia, RQ.periodicidade, RQ.titularidade], quem: 'A:gestor', descricao: 'Água e luz com início = data da entrega (São Paulo), próximo vencimento pela periodicidade e a troca de titularidade com prazo de 30 dias da entrega',
    sql: "SELECT o.utility_type, o.periodicity, o.starts_on, o.next_due_on, t.due_date, (t.due_date - o.starts_on) AS prazo_dias FROM legal.lease_obligations o JOIN finance.ownership_transfer_tasks t ON t.utility_obligation_id = o.id WHERE o.contract_id = :c ORDER BY o.utility_type",
    replacements: () => ({ c: ct.id }), avaliar: (rows) => rows.length === 2 && rows.every((r) => r.starts_on && r.next_due_on && r.next_due_on > r.starts_on && Number(r.prazo_dias) === 30),
  });

  // ---------- resolve as pendências ----------
  await H({ id: 'LC-EN-13', req: [RQ.encerra], titulo: 'Quita a competência 2030-06', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/schedules/${e.s}/payments`, corpo: { amountPaid: 2500 }, esperado: { status: 200 } });
  const contaAgua = await arquivo(R, 'LC-EN-14', 'Comprovante: conta de água no nome do locatário (arquivo fictício)', 'agua-locatario.pdf', `Água locatário ${lc.sfx}`, 'application/pdf', [RQ.titularidade]);
  const contaLuz = await arquivo(R, 'LC-EN-15', 'Comprovante: conta de luz no nome do locatário (arquivo fictício)', 'luz-locatario.pdf', `Luz locatário ${lc.sfx}`, 'application/pdf', [RQ.titularidade]);
  await H({ id: 'LC-EN-16', req: [RQ.titularidade, RQ.apis], titulo: 'Água: troca de titularidade concluída com o comprovante', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/ownership-transfer-tasks/${e.agua}/complete`, corpo: { evidenceFileId: contaAgua }, esperado: { status: 200 } });
  await H({ id: 'LC-EN-17', req: [RQ.titularidade, RQ.apis], titulo: 'Luz: troca de titularidade concluída com o comprovante', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/ownership-transfer-tasks/${e.luz}/complete`, corpo: { evidenceFileId: contaLuz }, esperado: { status: 200 } });
  await H({ id: 'LC-EN-18', req: [RQ.encerra], titulo: 'Elegibilidade: sem pendências, elegível', quem: 'A:gestor', metodo: 'GET', rota: elig, esperado: { status: 200 }, guardar: (b, x, passo) => { if (b.data.eligible !== true) passo.ok = false; } });
  await H({ id: 'LC-EN-19', req: ['M5-A0325-ad4afe', RQ.encerra, RQ.apis, RQ.eventos, RQ.testes, RQ.dod], titulo: 'Encerramento concluído: o contrato vai de ACTIVE a CLOSED pelos gates jurídicos', quem: 'A:gestor', metodo: 'POST', rota: `/billing/contracts/${ct.id}/closeout`, corpo: {}, esperado: { status: 200 }, guardar: (b, x, passo) => { if (!b.data || b.data.status !== 'COMPLETED' || b.data.contractLifecycle !== 'CLOSED') passo.ok = false; } });
  await R.sqlTenant({
    id: 'LC-EN-20', req: [RQ.pendencia, RQ.eventos, RQ.dod1, RQ.dod2], quem: 'A:gestor', descricao: 'Contrato CLOSED, closeout.completed no outbox, e obrigações, tarefas e créditos do garantido continuam no banco (nada some)',
    sql: "SELECT c.status, (SELECT count(*)::int FROM integration.outbox_events WHERE event_type = 'closeout.completed' AND aggregate_id = c.id) AS concluido, (SELECT count(*)::int FROM legal.lease_obligations WHERE contract_id = c.id AND deleted_at IS NULL) AS obrigacoes, (SELECT count(*)::int FROM finance.ownership_transfer_tasks t JOIN legal.lease_obligations u ON u.id = t.utility_obligation_id WHERE u.contract_id = c.id AND t.status = 'COMPLETED') AS trocas, (SELECT count(*)::int FROM finance.financial_entries WHERE contract_id = c.id AND nature = 'RECEIVABLE') AS recebiveis FROM legal.contracts c WHERE c.id = :c",
    replacements: () => ({ c: ct.id }), avaliar: (rows) => rows[0].status === 'CLOSED' && rows[0].concluido === 1 && rows[0].obrigacoes === 2 && rows[0].trocas === 2 && rows[0].recebiveis >= 1,
  });

  // ---------- tabelas e RLS ----------
  await R.sqlCatalogo({ id: 'LC-EN-21', req: [RQ.tabelas, RQ.testes, RQ.status], descricao: 'As tabelas da cobrança/utilidades (9 em finance + legal.lease_obligations, o nome do livro) com RLS ligada e forçada e policy de isolamento; finance.utility_obligations é visão', sql: `SELECT n.nspname || '.' || c.relname AS tabela, c.relkind, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policies FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE (n.nspname = 'finance' AND c.relname IN (${TABELAS.map((t) => `'${t}'`).join(',')}, 'utility_obligations')) OR (n.nspname = 'legal' AND c.relname = 'lease_obligations') ORDER BY 1`, avaliar: (rows) => rows.length === TABELAS.length + 2 && rows.filter((r) => r.relkind === 'r').every((r) => r.relrowsecurity && r.relforcerowsecurity && r.policies >= 1) && rows.some((r) => r.tabela === 'finance.utility_obligations' && r.relkind === 'v') });
  // ---------- as mesmas tabelas lidas pela API (cada uma com linha real dos módulos anteriores) ----------
  const cob = R.ctx.lcCobranca || {};
  const gar = R.ctx.lcGarantido || {};
  const obr = R.ctx.lcObrigacoes || {};
  const rea = R.ctx.lcReajuste || {};
  const lista = (b) => (b && Array.isArray(b.data) ? b.data : []);
  const algum = (b, x, passo) => { if (lista(b).length < 1) passo.ok = false; };
  const leitura = (id, titulo, rota, guardar) => H({ id, req: [RQ.tabelas, RQ.apis], titulo, quem: 'A:gestor', metodo: 'GET', rota, esperado: { status: 200 }, guardar: guardar || algum });
  await leitura('LC-EN-32', 'billing_schedules pela API: competências do contrato da cobrança', `/billing/schedules?contractId=${cob.contrato}`);
  await leitura('LC-EN-33', 'billing_schedule_items pela API: a competência traz aluguel, condomínio e IPTU como itens', `/billing/schedules/${cob.s1}`, (b, x, passo) => { if (!b.data || !Array.isArray(b.data.items) || b.data.items.length !== 3) passo.ok = false; });
  await leitura('LC-EN-34', 'rent_adjustments pela API: reajustes do contrato', `/billing/rent-adjustments?contractId=${rea.contrato}`);
  await leitura('LC-EN-35', 'collection_cases pela API: caso de cobrança do contrato', `/billing/collection-cases?contractId=${cob.contrato}`);
  await leitura('LC-EN-36', 'guaranteed_rent_contracts pela API: matrícula no aluguel garantido', `/billing/guaranteed-rent?contractId=${gar.contrato}`);
  await leitura('LC-EN-37', 'rent_advances pela API: antecipação do mesmo contrato, em tabela separada', `/billing/rent-advances?contractId=${gar.contrato}`);
  await leitura('LC-EN-38', 'utility_obligations e ownership_transfer_tasks pela API: obrigações do contrato com as tarefas de troca de titularidade', `/billing/utility-obligations?contractId=${obr.contrato}`, (b, x, passo) => { if (lista(b).length < 1 || !lista(b).some((o) => (o.transferTasks || []).length > 0)) passo.ok = false; });
  await H({ id: 'LC-EN-39', req: [RQ.tabelas, RQ.testes], titulo: 'Tenant B lista as competências do contrato do tenant A pela API e não recebe nenhuma (RLS)', quem: 'B:gestor', metodo: 'GET', rota: `/billing/schedules?contractId=${cob.contrato}`, esperado: { status: 200 }, guardar: (b, x, passo) => { if (!b || !Array.isArray(b.data) || b.data.length !== 0) passo.ok = false; } });
  await R.sqlTenant({ id: 'LC-EN-22', req: [RQ.testes], quem: 'B:gestor', descricao: 'Pela RLS, o tenant B não enxerga nenhuma linha de cobrança/utilidade do contrato do tenant A', sql: 'SELECT (SELECT count(*)::int FROM finance.billing_schedules WHERE contract_id = :c) AS cobrancas, (SELECT count(*)::int FROM legal.lease_obligations WHERE contract_id = :c) AS obrigacoes, (SELECT count(*)::int FROM finance.guaranteed_rent_contracts WHERE contract_id = :c) AS garantido, (SELECT count(*)::int FROM finance.rent_advances WHERE contract_id = :c) AS antecipacoes', replacements: () => ({ c: ct.id }), avaliar: (rows) => rows[0].cobrancas === 0 && rows[0].obrigacoes === 0 && rows[0].garantido === 0 && rows[0].antecipacoes === 0 });
};
