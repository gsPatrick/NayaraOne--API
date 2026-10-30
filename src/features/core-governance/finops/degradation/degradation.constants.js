'use strict';

/**
 * Constantes da degradação por custo (M9-D863). A lista de passos é FECHADA e do livro/da demanda: cinco interruptores de FUNÇÃO da aplicação,
 * reversíveis e não críticos. Nenhum deles é recurso de infraestrutura (computação, banco, fila, storage, rede) e nenhum atinge função crítica.
 */
const STEPS = Object.freeze(['SWITCH_AI_MODEL_CHEAPER', 'PAUSE_MARKETING_CAMPAIGNS', 'REDUCE_LOG_LEVEL', 'LIMIT_EXPORT_SIZE', 'DEFER_NON_CRITICAL_JOBS']);

/** Funções críticas (login, financeiro, jurídico, pagamentos, kill switches de segurança e restore): nunca entram numa política. */
const CRITICAL_HINTS = Object.freeze(['LOGIN', 'AUTH', 'MFA', 'FINANC', 'PAYMENT', 'PAGAMENTO', 'LEGAL', 'JURID', 'KILL', 'SWITCH_OFF', 'RESTORE', 'BACKUP', 'SECURITY', 'SEGURANCA']);
/** Palavras de quem desligaria infraestrutura: recusadas como tentativa de desligar PROD por custo. */
const INFRA_SHUTDOWN_HINTS = Object.freeze(['SHUTDOWN', 'SHUT_DOWN', 'TERMINATE', 'STOP_', 'POWER_OFF', 'SCALE_TO_ZERO', 'SCALE_DOWN', 'DESLIGAR', 'DESTROY', 'DELETE_', 'PROD_']);

const STATUS = Object.freeze({ APPLIED: 'APPLIED', REVERTED: 'REVERTED' });
const REVERT_REASONS = Object.freeze({ PERIOD_ENDED: 'PERIOD_ENDED', BELOW_THRESHOLD: 'BELOW_THRESHOLD', POLICY_CHANGED: 'POLICY_CHANGED', DISABLED: 'DISABLED' });

const EVENT_THRESHOLD = 'finops.budget.threshold';
const AUDIT_ENTITY = 'governance.degradation';
const AUDIT_POLICY_ENTITY = 'governance.degradation_policy';
const AUDIT_APPLIED = 'finops.degradation.applied';
const AUDIT_REVERTED = 'finops.degradation.reverted';
const AUDIT_POLICY = 'finops.degradation.policy_saved';
const JOB_NAME = 'finopsDegradationJob';

module.exports = {
  STEPS, CRITICAL_HINTS, INFRA_SHUTDOWN_HINTS, STATUS, REVERT_REASONS, EVENT_THRESHOLD, AUDIT_ENTITY, AUDIT_POLICY_ENTITY, AUDIT_APPLIED, AUDIT_REVERTED, AUDIT_POLICY, JOB_NAME,
};
