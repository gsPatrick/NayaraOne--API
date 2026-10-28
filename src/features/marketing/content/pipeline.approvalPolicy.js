'use strict';

/**
 * M9-D406 — Porta da regra de aprovação. COMPLIANCE_CHECKED vai a PENDING_APPROVAL, e só vai direto a APPROVED quando a classe
 * do conteúdo é autopublicável (M9-D408 registra aqui a regra de classes; sem registro, TODO conteúdo exige aprovação humana).
 * Contrato: ({item, version, tenant, transaction}) -> { autopublish: boolean, classId?: string, channels?: string[] }.
 */
let policy = async () => ({ autopublish: false });

function registerApprovalPolicy(fn) {
  if (typeof fn !== 'function') throw new TypeError('A regra de aprovação deve ser uma função.');
  policy = fn;
}

function resetApprovalPolicy() {
  policy = async () => ({ autopublish: false });
}

async function evaluateApprovalPolicy(ctx) {
  return policy(ctx);
}

module.exports = { registerApprovalPolicy, resetApprovalPolicy, evaluateApprovalPolicy };
