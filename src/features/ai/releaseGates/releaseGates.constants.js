'use strict';

/**
 * Portão de liberação da NAY para produção (M9-D046). Itens do livro, o escopo de cada um e o que o portão exige.
 * GLOBAL = vale para a NAY toda; AGENT = um agente (código); PROVIDER = um provedor (código).
 */
const SCOPE = Object.freeze({ GLOBAL: 'GLOBAL', AGENT: 'AGENT', PROVIDER: 'PROVIDER' });
const STATUS = Object.freeze({ PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' });

const SCOPE_OF_ITEM = Object.freeze({
  RED_TEAM: SCOPE.GLOBAL,
  PENTEST: SCOPE.GLOBAL,
  AGENT_EVALUATION: SCOPE.AGENT,
  PRIVACY_REVIEW: SCOPE.GLOBAL,
  PROVIDER_REVIEW: SCOPE.PROVIDER,
  PRODUCTION_APPROVAL: SCOPE.GLOBAL,
  DEV_DEPLOY: SCOPE.GLOBAL,
  LAB_VALIDATION: SCOPE.GLOBAL,
});
const ITEMS = Object.freeze(Object.keys(SCOPE_OF_ITEM));

/** Itens GLOBAL que toda liberação exige, na ordem em que a mensagem os lista. A aprovação final vem por último e tem regra própria. */
const GLOBAL_REQUIRED = Object.freeze(['DEV_DEPLOY', 'LAB_VALIDATION', 'RED_TEAM', 'PENTEST', 'PRIVACY_REVIEW']);
const FINAL_ITEM = 'PRODUCTION_APPROVAL';
/** Itens cuja aprovação precisa citar a evidência (o estágio LAB da esteira, M9-D044, só abre com `evidence_ref`). */
const EVIDENCE_REQUIRED = Object.freeze(['LAB_VALIDATION']);

const PERMISSION = 'ai:admin';
const ENVIRONMENT = Object.freeze({ LAB: 'LAB', PRODUCAO: 'PRODUCAO' });

module.exports = { SCOPE, STATUS, SCOPE_OF_ITEM, ITEMS, GLOBAL_REQUIRED, FINAL_ITEM, EVIDENCE_REQUIRED, PERMISSION, ENVIRONMENT };
