'use strict';
/**
 * Locação — Obrigações da locação e utilidades (Caderno M5 §12, §18 lease.obligation.overdue, Guia §15/§20,
 * bloco "Correções pós-auditoria — Utilidades"): IPTU/condomínio/água/luz/gás/SPU vinculados ao contrato,
 * TROCA DE TITULARIDADE de água e luz como tarefa com evidência, reembolso que vira lançamento
 * financeiro, pendência que gera alerta e bloqueia o encerramento sem sumir.
 */
const { preparo, contratoLocacao, arquivo, noTenant } = require('../apoio-locacao/preparo');

const RQ = {
  vinculo: 'M5-A0093-f1f8ea', campos: 'M5-A0094-c81c5a', titularidade: 'M5-A0095-1df93e', pendencia: 'M5-A0096-30165c',
  reembolso: 'M5-A0097-9ce515', overdueP1: 'M5-A0137-ec7d5c', overdueP2: 'M5-A0228-150929', dod1: 'M5-A0171-80da7b',
  dod2: 'M5-A0270-5f73bd', tiposUtil: 'M5-A0338-d0b0bc', reembolsoRec: 'M5-A0339-b9d073', encerra: 'M5-A0340-79a98a',
  eventos: 'M5-A0342-a3762d', apis: 'M5-A0343-c56197', testes: 'M5-A0345-019723',
};

module.exports = async function locacaoObrigacoes(R) {
  const lc = await preparo(R);
  const H = (o) => R.http(o);
  const ct = await contratoLocacao(R, 'LC-OB-P1', { propertyId: lc.imovel, locadorId: lc.locador, locatarioId: lc.locatario, valor: 2900 });
  const o = {};
  const comprovante = await arquivo(R, 'LC-OB-P2', 'Preparação: comprovante da conta de consumo (arquivo fictício)', 'conta-agua.pdf', `Conta de água fictícia ${lc.sfx}`, 'application/pdf', [RQ.campos]);

  const tipos = [
    ['WATER', 'TENANT', 'Companhia de Água Fictícia', 'AG-001', true],
    ['ELECTRICITY', 'TENANT', 'Distribuidora de Energia Fictícia', 'EL-002', true],
    ['GAS', 'TENANT', 'Gás Fictício', 'GS-003', false],
    ['CONDO', 'TENANT', 'Condomínio Edifício Fictício', 'CD-004', false],
    ['IPTU', 'LANDLORD', 'Prefeitura Fictícia', 'IP-005', false],
    ['SPU', 'LANDLORD', 'SPU Fictícia', 'SP-006', false],
    ['OTHER', 'LANDLORD', 'Taxa de lixo fictícia', 'OT-007', false],
  ];
  let n = 0;
  for (const [tipo, resp, provider, conta, troca] of tipos) {
    n += 1;
    await H({
      id: `LC-OB-0${n}`, req: [RQ.vinculo, RQ.campos, RQ.tiposUtil, RQ.apis, RQ.dod1, RQ.dod2, ...(troca ? [RQ.titularidade] : [])],
      titulo: `Obrigação ${tipo} vinculada ao contrato (responsável ${resp}${troca ? ', troca de titularidade exigida' : ''})`, quem: 'A:gestor', metodo: 'POST', rota: '/billing/utility-obligations',
      corpo: { contractId: ct.id, utilityType: tipo, responsibleParty: resp, provider, accountNumber: conta, transferRequired: troca, evidenceFileId: tipo === 'WATER' ? comprovante : undefined, periodicity: 'MONTHLY', dueDay: 10 },
      esperado: { status: 201 }, guardar: (b) => { o[tipo] = b.data.obligation.id; if (b.data.transferTask) o[`task_${tipo}`] = b.data.transferTask.id; },
    });
  }
  await H({ id: 'LC-OB-08', req: [RQ.tiposUtil], titulo: 'Tipo de obrigação fora da lista é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/billing/utility-obligations', corpo: { contractId: ct.id, utilityType: 'INTERNET', responsibleParty: 'TENANT' }, esperado: { status: 400, codigo: 'UTILITY_OBLIGATION_VALIDATION' } });
  await H({ id: 'LC-OB-09', req: [RQ.campos], titulo: 'Responsável fora da lista é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/billing/utility-obligations', corpo: { contractId: ct.id, utilityType: 'WATER', responsibleParty: 'VIZINHO' }, esperado: { status: 400, codigo: 'UTILITY_OBLIGATION_VALIDATION' } });
  await H({ id: 'LC-OB-40', req: [RQ.campos], titulo: 'Periodicidade fora da lista é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/billing/utility-obligations', corpo: { contractId: ct.id, utilityType: 'WATER', responsibleParty: 'TENANT', periodicity: 'DIARIA' }, esperado: { status: 400, codigo: 'UTILITY_OBLIGATION_VALIDATION' } });
  await H({ id: 'LC-OB-41', req: [RQ.campos], titulo: 'Sem periodicidade informada vale o padrão configurado do tipo (IPTU: anual)', quem: 'A:gestor', metodo: 'POST', rota: '/billing/utility-obligations', corpo: { contractId: ct.id, utilityType: 'IPTU', responsibleParty: 'LANDLORD', provider: 'Prefeitura Fictícia', accountNumber: 'IP-PADRAO' }, esperado: { status: 201 }, guardar: (b, x, passo) => { o.iptuPadrao = b.data.obligation.id; if (b.data.obligation.periodicity !== 'ANNUAL') passo.ok = false; } });
  await H({ id: 'LC-OB-10', req: [RQ.vinculo], titulo: 'Obrigação sem contrato existente é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/billing/utility-obligations', corpo: { contractId: '00000000-0000-4000-8000-000000000004', utilityType: 'WATER', responsibleParty: 'TENANT' }, esperado: { status: 404, codigo: 'UTILITY_OBLIGATION_CONTRACT_NOT_FOUND' } });
  await H({ id: 'LC-OB-11', req: [RQ.apis], titulo: 'Leitura (sem billing:create) não cria obrigação', quem: 'A:leitura', metodo: 'POST', rota: '/billing/utility-obligations', corpo: { contractId: ct.id, utilityType: 'WATER', responsibleParty: 'TENANT' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-OB-12', req: [RQ.vinculo, RQ.campos, RQ.dod1], titulo: 'Obrigações do contrato com responsável, provedor, conta, troca exigida, evidência, status e tarefas', quem: 'A:gestor', metodo: 'GET', rota: `/billing/utility-obligations?contractId=${ct.id}`, esperado: { status: 200 } });
  await R.sqlTenant({ id: 'LC-OB-13', req: [RQ.campos, RQ.tiposUtil], quem: 'A:gestor', descricao: 'Obrigações na tabela do livro legal.lease_obligations: responsável, periodicidade e dia do vencimento, provedor, conta, troca exigida, comprovante e status', sql: 'SELECT utility_type, responsible_party, periodicity, due_day, provider, account_number, transfer_required, evidence_file_id, status FROM legal.lease_obligations WHERE contract_id = :c ORDER BY utility_type', replacements: () => ({ c: ct.id }), avaliar: (rows) => rows.length === 8 && rows.filter((r) => r.account_number !== 'IP-PADRAO').every((r) => r.periodicity === 'MONTHLY' && r.due_day === 10) && rows.some((r) => r.account_number === 'IP-PADRAO' && r.periodicity === 'ANNUAL') });
  await H({ id: 'LC-OB-14', req: ['M5-A0270-5f73bd', RQ.apis, RQ.tiposUtil], titulo: 'Conta de consumo da obrigação de água', quem: 'A:gestor', metodo: 'POST', rota: '/billing/utility-accounts', corpo: { utilityObligationId: o.WATER, provider: 'Companhia de Água Fictícia', accountNumber: 'AG-001', holderPersonId: lc.locador }, esperado: { status: 201 } });

  // ---------- TITULARIDADE de água e luz ----------
  const conclui = (id) => `/billing/ownership-transfer-tasks/${id}/complete`;
  await H({ id: 'LC-OB-15', req: [RQ.titularidade, RQ.apis], titulo: 'Água: concluir a troca de titularidade sem comprovante é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => conclui(o.task_WATER), corpo: { toPersonId: lc.locatario }, esperado: { status: 400, codigo: 'OWNERSHIP_TRANSFER_EVIDENCE_REQUIRED' } });
  await H({ id: 'LC-OB-16', req: [RQ.titularidade], titulo: 'Água: concluir sem informar o novo titular é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => conclui(o.task_WATER), corpo: { evidenceFileId: comprovante }, esperado: { status: 400, codigo: 'OWNERSHIP_TRANSFER_RECIPIENT_REQUIRED' } });
  await H({ id: 'LC-OB-17', req: [RQ.titularidade], titulo: 'Água: comprovante inexistente é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => conclui(o.task_WATER), corpo: { evidenceFileId: '00000000-0000-4000-8000-000000000005', toPersonId: lc.locatario }, esperado: { status: 400, codigo: 'OWNERSHIP_TRANSFER_EVIDENCE_NOT_FOUND' } });
  await H({ id: 'LC-OB-18', req: [RQ.titularidade], titulo: 'Leitura (sem billing:update) não conclui a troca de titularidade', quem: 'A:leitura', metodo: 'POST', rota: () => conclui(o.task_WATER), corpo: { toPersonId: lc.locatario }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-OB-19', req: [RQ.titularidade], titulo: 'Tenant B não conclui a troca de titularidade do tenant A', quem: 'B:gestor', metodo: 'POST', rota: () => conclui(o.task_WATER), corpo: { evidenceFileId: comprovante, toPersonId: lc.locatario }, esperado: { status: 404 } });
  const novaConta = await arquivo(R, 'LC-OB-20', 'Comprovante da troca: conta de água já no nome do locatário (arquivo fictício)', 'conta-agua-novo-titular.pdf', `Conta de água no nome do locatário ${lc.sfx}`, 'application/pdf', [RQ.titularidade]);
  await H({ id: 'LC-OB-21', req: ['M5-A0270-5f73bd', RQ.titularidade, RQ.apis, RQ.eventos], titulo: 'Água: troca de titularidade concluída com comprovante e novo titular', quem: 'A:gestor', metodo: 'POST', rota: () => conclui(o.task_WATER), corpo: { evidenceFileId: novaConta, toPersonId: lc.locatario }, esperado: { status: 200 } });
  await H({ id: 'LC-OB-22', req: [RQ.titularidade], titulo: 'Água: concluir de novo é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => conclui(o.task_WATER), corpo: { evidenceFileId: novaConta, toPersonId: lc.locatario }, esperado: { status: 409, codigo: 'OWNERSHIP_TRANSFER_TASK_ALREADY_COMPLETED' } });
  await H({ id: 'LC-OB-23', req: [RQ.titularidade], titulo: 'Luz: pedir outra troca com uma já pendente é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/utility-obligations/${o.ELECTRICITY}/ownership-transfer`, corpo: { toPersonId: lc.locatario }, esperado: { status: 409, codigo: 'OWNERSHIP_TRANSFER_ALREADY_PENDING' } });
  await H({ id: 'LC-OB-24', req: [RQ.titularidade, RQ.apis, RQ.eventos], titulo: 'Gás: troca de titularidade pedida depois (vira tarefa pendente)', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/utility-obligations/${o.GAS}/ownership-transfer`, corpo: { fromPersonId: lc.locador, toPersonId: lc.locatario }, esperado: { status: 201 }, guardar: (b) => { o.task_GAS = b.data.transferTask.id; } });
  await R.sqlTenant({
    id: 'LC-OB-25', req: ['M5-A0171-80da7b', RQ.titularidade], quem: 'A:gestor', descricao: 'Água TRANSFERRED com o comprovante; luz e gás TRANSFER_PENDING; tarefas com evidência, novo titular e data',
    sql: 'SELECT o.utility_type, o.status AS obrigacao, o.evidence_file_id, t.status AS tarefa, t.evidence_file_id AS evidencia_tarefa, t.to_person_id, t.completed_at FROM legal.lease_obligations o JOIN finance.ownership_transfer_tasks t ON t.utility_obligation_id = o.id WHERE o.contract_id = :c ORDER BY o.utility_type',
    replacements: () => ({ c: ct.id }),
    avaliar: (rows) => rows.some((r) => r.utility_type === 'WATER' && r.obrigacao === 'TRANSFERRED' && r.tarefa === 'COMPLETED' && r.evidencia_tarefa === novaConta) && rows.some((r) => r.utility_type === 'ELECTRICITY' && r.tarefa === 'PENDING'),
  });
  await R.sqlTenant({ id: 'LC-OB-26', req: [RQ.eventos, RQ.titularidade], quem: 'A:gestor', descricao: 'Outbox: utility.transfer.required (água, luz, gás) e utility.transfer.completed (água)', sql: "SELECT event_type, aggregate_id FROM integration.outbox_events WHERE event_type IN ('utility.transfer.required','utility.transfer.completed') AND aggregate_id IN (:ids) ORDER BY event_type", replacements: () => ({ ids: [o.task_WATER, o.task_ELECTRICITY, o.task_GAS] }), avaliar: (rows) => rows.filter((r) => r.event_type === 'utility.transfer.required').length === 3 && rows.filter((r) => r.event_type === 'utility.transfer.completed').length === 1 });

  // ---------- pendência vencida gera alerta (lease.obligation.overdue) ----------
  const util = require('../../../src/features/billing/utilities.service');
  const daqui31 = new Date(Date.now() + 31 * 86400000);
  await R.servico({ id: 'LC-OB-27', req: [RQ.pendencia, RQ.overdueP1, RQ.overdueP2], titulo: 'Job de cobrança, 31 dias depois: troca de titularidade da luz e do gás pendentes viram obrigação vencida', chamada: 'utilities.service.flagOverdueLeaseObligations(tx, { now: hoje+31d })', fn: noTenant(R, (tx) => util.flagOverdueLeaseObligations(tx, { now: daqui31 })), esperado: {} });
  await R.servico({ id: 'LC-OB-28', req: ['M5-A0346-86010e', 'M5-A0096-30165c', RQ.overdueP1, RQ.overdueP2], titulo: 'Rodar o job de novo não repete o alerta (idempotente)', chamada: 'utilities.service.flagOverdueLeaseObligations(tx, { now: hoje+31d }) — 2ª vez', fn: noTenant(R, (tx) => util.flagOverdueLeaseObligations(tx, { now: daqui31 })), esperado: {} });
  await R.sqlTenant({ id: 'LC-OB-29', req: ['M5-A0171-80da7b', RQ.pendencia, RQ.overdueP1, RQ.overdueP2], quem: 'A:gestor', descricao: 'Outbox: um lease.obligation.overdue por tarefa pendente (luz e gás), e as tarefas continuam PENDING', sql: "SELECT e.aggregate_id, count(*)::int AS eventos, max(t.status) AS tarefa FROM integration.outbox_events e JOIN finance.ownership_transfer_tasks t ON t.id = e.aggregate_id WHERE e.event_type = 'lease.obligation.overdue' AND e.aggregate_id IN (:ids) GROUP BY e.aggregate_id", replacements: () => ({ ids: [o.task_ELECTRICITY, o.task_GAS] }), avaliar: (rows) => rows.length === 2 && rows.every((r) => r.eventos === 1 && r.tarefa === 'PENDING') });

  // ---------- reembolso: pago pela imobiliária vira lançamento vinculado ----------
  const pag = (id, tipo, corpo, esperado, titulo, req, guardar) => H({ id, req, titulo, quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/utility-obligations/${o[tipo]}/payments`, corpo, esperado, guardar });
  await pag('LC-OB-30', 'CONDO', { amount: 640.5, paidByParty: 'TENANT' }, { status: 201 }, 'Condomínio pago pelo próprio responsável (locatário): sem reembolso', ['M5-A0339-b9d073', RQ.reembolso, RQ.testes]);
  await pag('LC-OB-31', 'IPTU', { amount: 1234.56, paidByParty: 'COMPANY' }, { status: 201 }, 'IPTU do locador pago pela imobiliária: reembolso a receber + lançamento financeiro', ['M5-A0325-ad4afe', 'M5-A0270-5f73bd', RQ.reembolso, RQ.reembolsoRec, RQ.apis, RQ.eventos, RQ.testes], (b) => { o.reemb = b.data.reimbursement.id; o.lanc = b.data.financialEntry.id; });
  await pag('LC-OB-32', 'IPTU', { amount: 0, paidByParty: 'COMPANY' }, { status: 400, codigo: 'UTILITY_PAYMENT_VALIDATION' }, 'Pagamento com valor zero é recusado', [RQ.reembolso]);
  await R.sqlTenant({
    id: 'LC-OB-33', req: [RQ.reembolso, RQ.reembolsoRec], quem: 'A:gestor', descricao: 'Reembolso PENDING ligado a um lançamento RECEIVABLE do mesmo contrato e valor',
    sql: 'SELECT r.status, r.paid_by_party, r.owed_by_party, r.amount, f.nature, f.entry_type, f.amount AS valor_lancamento, f.contract_id FROM finance.utility_reimbursements r JOIN finance.financial_entries f ON f.id = r.financial_entry_id WHERE r.id = :id',
    replacements: () => ({ id: o.reemb }), avaliar: (rows) => rows.length === 1 && rows[0].nature === 'RECEIVABLE' && rows[0].contract_id === ct.id && Number(rows[0].valor_lancamento) === 1234.56 && rows[0].owed_by_party === 'LANDLORD',
  });
  await R.sqlTenant({ id: 'LC-OB-34', req: [RQ.eventos, RQ.reembolsoRec], quem: 'A:gestor', descricao: 'Outbox: reimbursement.created do reembolso', sql: "SELECT event_type, aggregate_id FROM integration.outbox_events WHERE event_type = 'reimbursement.created' AND aggregate_id = :id", replacements: () => ({ id: o.reemb }), avaliar: (rows) => rows.length === 1 });

  // ---------- idempotência do pagamento (Idempotency-Key) ----------
  await R.servico({
    id: 'LC-OB-38', req: [RQ.reembolso, RQ.reembolsoRec, 'M5-A0346-86010e'], titulo: 'SPU paga pela imobiliária enviada 2 vezes com a mesma Idempotency-Key (HTTP real, perfil A:gestor): a 2ª devolve a resposta original sem novo reembolso',
    chamada: 'POST /billing/utility-obligations/:id/payments x2 com o cabeçalho Idempotency-Key',
    fn: async () => {
      const chamar = async () => {
        const res = await fetch(`${R.baseUrl}/billing/utility-obligations/${o.SPU}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${R.tokens['A:gestor']}`, 'Idempotency-Key': `spu-${lc.sfx}-pagamento-1` }, body: JSON.stringify({ amount: 77.7, paidByParty: 'COMPANY' }) });
        const body = await res.json();
        return { status: res.status, replay: res.headers.get('Idempotent-Replay'), reembolso: body.data && body.data.reimbursement ? body.data.reimbursement.id : null };
      };
      return { primeira: await chamar(), segunda: await chamar() };
    },
    esperado: {}, guardar: (r, x, passo) => { if (r.primeira.status !== 201 || r.segunda.status !== 201 || r.segunda.replay !== 'true' || r.primeira.reembolso !== r.segunda.reembolso) passo.ok = false; },
  });
  await R.sqlTenant({ id: 'LC-OB-39', req: [RQ.reembolso, 'M5-A0346-86010e'], quem: 'A:gestor', descricao: 'Um único reembolso e um único recebível para o pagamento repetido com a mesma chave', sql: 'SELECT count(*)::int AS reembolsos, count(DISTINCT financial_entry_id)::int AS recebiveis FROM finance.utility_reimbursements WHERE utility_obligation_id = :o', replacements: () => ({ o: o.SPU }), avaliar: (rows) => rows[0].reembolsos === 1 && rows[0].recebiveis === 1 });

  await H({ id: 'LC-OB-42', req: [RQ.campos, RQ.vinculo, RQ.tiposUtil], titulo: 'Pentest: comprovante que não é arquivo desta empresa é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/billing/utility-obligations', corpo: { contractId: ct.id, utilityType: 'GAS', responsibleParty: 'TENANT', evidenceFileId: '00000000-0000-4000-8000-000000000007' }, esperado: { status: 400, codigo: 'UTILITY_OBLIGATION_EVIDENCE_NOT_FOUND' } });
  await H({ id: 'LC-OB-43', req: [RQ.reembolso, RQ.reembolsoRec, RQ.apis], titulo: 'Pentest: "quem pagou" com mais de 16 caracteres é 400, não 500', quem: 'A:gestor', metodo: 'POST', rota: () => `/billing/utility-obligations/${o.IPTU}/payments`, corpo: { amount: 10, paidByParty: 'IMOBILIARIA_DO_JO' }, esperado: { status: 400, codigo: 'UTILITY_PAYMENT_VALIDATION' } });

  // ---------- pendência bloqueia o encerramento e não some ----------
  await H({ id: 'LC-OB-35', req: [RQ.encerra, RQ.pendencia], titulo: 'Elegibilidade de encerramento lista as trocas de titularidade pendentes (luz e gás)', quem: 'A:gestor', metodo: 'GET', rota: `/billing/contracts/${ct.id}/closeout-eligibility`, esperado: { status: 200 }, guardar: (b, x, passo) => { const tipos2 = ((b && b.data && b.data.reasons) || []).map((r) => r.type); if (!tipos2.includes('PENDING_UTILITY_TRANSFER')) passo.ok = false; } });
  await H({ id: 'LC-OB-36', req: ['M5-A0270-5f73bd', RQ.encerra, RQ.pendencia, RQ.testes], titulo: 'Encerrar com troca de titularidade pendente é bloqueado', quem: 'A:gestor', metodo: 'POST', rota: `/billing/contracts/${ct.id}/closeout`, corpo: {}, esperado: { status: 409, codigo: 'CLOSEOUT_BLOCKED' } });
  await R.sqlTenant({ id: 'LC-OB-37', req: [RQ.pendencia, RQ.dod1], quem: 'A:gestor', descricao: 'Depois da tentativa de encerramento: obrigações, tarefas pendentes e reembolso continuam no banco', sql: "SELECT (SELECT count(*)::int FROM legal.lease_obligations WHERE contract_id = :c AND deleted_at IS NULL) AS obrigacoes, (SELECT count(*)::int FROM finance.ownership_transfer_tasks t JOIN legal.lease_obligations u ON u.id = t.utility_obligation_id WHERE u.contract_id = :c AND t.status = 'PENDING') AS pendentes, (SELECT count(*)::int FROM finance.utility_reimbursements WHERE id = :r AND status = 'PENDING') AS reembolsos", replacements: () => ({ c: ct.id, r: o.reemb }), avaliar: (rows) => rows[0].obrigacoes === 8 && rows[0].pendentes === 2 && rows[0].reembolsos === 1 });

  R.ctx.lcObrigacoes = { contrato: ct.id, ...o };
};
