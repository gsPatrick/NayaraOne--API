'use strict';

const { evaluateAutopublish } = require('./autopublish.policy');

/**
 * M9-D406 — Porta da regra de aprovação. COMPLIANCE_CHECKED vai a PENDING_APPROVAL, e só vai direto a APPROVED quando a classe do conteúdo é autopublicável.
 * A regra padrão é a da M9-D408 (autopublish.policy: classes do parâmetro marketing.autopublish.classes, vazio por padrão = TODO conteúdo exige aprovação humana);
 * `registerApprovalPolicy` troca a regra (testes) e `resetApprovalPolicy` volta à padrão.
 * Contrato: ({item, version, tenant, transaction}) -> { autopublish: boolean, classId?: string, channels?: string[], quando?: number, reasons?: string[] }.
 */
let policy = evaluateAutopublish;

function registerApprovalPolicy(fn) {
  if (typeof fn !== 'function') throw new TypeError('A regra de aprovação deve ser uma função.');
  policy = fn;
}

function resetApprovalPolicy() {
  policy = evaluateAutopublish;
}

async function evaluateApprovalPolicy(ctx) {
  return policy(ctx);
}

module.exports = { registerApprovalPolicy, resetApprovalPolicy, evaluateApprovalPolicy };
