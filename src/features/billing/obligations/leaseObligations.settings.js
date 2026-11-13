'use strict';

/**
 * Parâmetros do ciclo das obrigações da locação (fechamento M5, livro §12 "Pendência gera alerta/cobrança; não some quando
 * contrato encerra" e bloco de cobrança "Encerramento bloqueia com obrigação crítica pendente"). O livro não traz números nem
 * define "obrigação crítica": vira configuração da empresa (aba "Locação e Jurídico"). Padrões:
 *  - billing.utility_proof_grace_days: dias depois do vencimento para o comprovante chegar antes de o ciclo vencer (5, M5-D350);
 *  - billing.reimbursement_overdue_alert_days: dias depois do vencimento do reembolso a receber até o alerta (30, M5-D352);
 *  - locacao.titularidade.prazo_dias (já existente): prazo da troca de titularidade; vale também para a tarefa sem prazo próprio
 *    (antes era um 30 fixo no código);
 *  - locacao.encerramento.bloqueia.<PENDÊNCIA>: o que é "obrigação crítica" que segura o encerramento — troca de titularidade
 *    pendente (ligado, como já era), ciclo vencido sem comprovante (ligado, o mais conservador para uma pendência nova) e
 *    reembolso a receber (desligado, como já era).
 */
const KEYS = Object.freeze({
  PROOF_GRACE_DAYS: 'billing.utility_proof_grace_days',
  REIMBURSEMENT_ALERT_DAYS: 'billing.reimbursement_overdue_alert_days',
  TRANSFER_DAYS: 'locacao.titularidade.prazo_dias',
});
const CLOSURE_KINDS = Object.freeze(['TRANSFER', 'CYCLE_OVERDUE', 'REIMBURSEMENT_PENDING']);
const closureKey = (kind) => `locacao.encerramento.bloqueia.${kind}`;
const DEFAULTS = Object.freeze({
  [KEYS.PROOF_GRACE_DAYS]: 5,
  [KEYS.REIMBURSEMENT_ALERT_DAYS]: 30,
  [KEYS.TRANSFER_DAYS]: 30,
  [closureKey('TRANSFER')]: true,
  [closureKey('CYCLE_OVERDUE')]: true,
  [closureKey('REIMBURSEMENT_PENDING')]: false,
});

const LEASE_OBLIGATION_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.PROOF_GRACE_DAYS]: { type: 'integer', min: 0, max: 60 },
  [KEYS.REIMBURSEMENT_ALERT_DAYS]: { type: 'integer', min: 1, max: 365 },
  ...Object.fromEntries(CLOSURE_KINDS.map((k) => [closureKey(k), { type: 'boolean' }])),
});

module.exports = { KEYS, CLOSURE_KINDS, closureKey, DEFAULTS, LEASE_OBLIGATION_SETTINGS_SCHEMA };
