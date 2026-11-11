'use strict';

const { rows, one, centsSql, blocker } = require('./sql');

const CLOSED = ['TERMINATED', 'CLOSED', 'CANCELLED'];
const GATE_TARGETS = ['TERMINATED', 'CLOSED'];

/** Alvo da chamada: a rota /terminate leva a TERMINATED; a transição genérica traz `targetStatus` no corpo. */
function targetOf(req) {
  if (req && req.path && /\/terminate$/.test(req.path)) return 'TERMINATED';
  return String((req && req.body && req.body.targetStatus) || '').toUpperCase();
}

/**
 * Impacto de encerrar/rescindir contrato (linha 1): cobranças em aberto (parcelas e saldo), garantias, processos, prazos e notificações.
 * Os impedimentos são os do gate único de encerramento (contractClosureGate), a mesma lista que o serviço aplica.
 */
async function legalContract({ id, transaction, preview, req, query, itemsMax }) {
  // Simulação: `?targetStatus=CANCELLED` simula o cancelamento (sem o gate de encerramento); sem o parâmetro é a rescisão.
  const target = preview ? String(query.targetStatus || 'TERMINATED').toUpperCase() : targetOf(req);
  // Matriz M5 (Guia §3): CANCELLED deixou de ser alvo de transição do contrato — a chamada segue direto para a
  // máquina de estados, que recusa (409); só a rescisão pede confirmação.
  if (!preview && target !== 'TERMINATED') return { skip: true };
  const contract = await one(transaction, 'SELECT id, contract_number, status FROM legal.contracts WHERE id = :id AND deleted_at IS NULL', { id }, 'Contrato não encontrado.', 'LEGAL_CONTRACT_NOT_FOUND');
  const [billing] = await rows(transaction, `SELECT COUNT(*)::int AS n, ${centsSql('balance')} AS cents FROM finance.billing_schedules WHERE contract_id = :id AND deleted_at IS NULL AND status IN ('OPEN','PARTIALLY_PAID')`, { id });
  const items = await rows(transaction, `SELECT id, period, balance FROM finance.billing_schedules WHERE contract_id = :id AND deleted_at IS NULL AND status IN ('OPEN','PARTIALLY_PAID') ORDER BY due_date LIMIT :limit`, { id, limit: itemsMax });
  const [parties] = await rows(transaction, 'SELECT COUNT(*)::int AS n FROM legal.contract_parties WHERE contract_id = :id AND deleted_at IS NULL', { id });
  const blockers = [];
  if (CLOSED.includes(contract.status)) blockers.push(blocker('CONTRACT_ALREADY_CLOSED', `o contrato já está ${contract.status === 'TERMINATED' ? 'rescindido' : 'encerrado ou cancelado'}`));
  const counts = { openInstallments: billing.n, parties: parties.n };
  if (GATE_TARGETS.includes(target)) {
    const { collectContractClosurePendencies, PENDENCY_LABELS } = require('../../../features/legal/contractClosureGate');
    for (const p of await collectContractClosurePendencies(id, transaction)) {
      counts[p.type] = (counts[p.type] || 0) + 1;
      blockers.push(blocker(p.type, `${PENDENCY_LABELS[p.type] || p.type} (${p.detail})`));
    }
  }
  return {
    code: contract.contract_number,
    label: `Contrato ${contract.contract_number}`,
    impact: { counts, totalAmountCents: Number(billing.cents), blockers, items: items.map((i) => ({ type: 'BILLING_SCHEDULE', id: i.id, label: `Competência ${i.period}`, amount: i.balance })) },
  };
}

module.exports = { legalContract, targetOf };
