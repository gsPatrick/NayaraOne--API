'use strict';

// Cenário completo da M9-D619: grava as fontes de uma empresa e devolve os eventos reais que atualizam cada um dos sete read models.
const bi = require('./biObrasJuridicoEnv');
const juridico = require('./m9d619Juridico');
const correspondente = require('./m9d619Correspondente');

const MODELS = ['rm_legal_deadlines', 'rm_legal_cases_risk', 'rm_legal_values', 'rm_legal_missing_docs', 'rm_fin_cases_stage', 'rm_fin_provider_outcome', 'rm_fin_commission'];

async function seedAll(env, t) {
  const cases = await juridico.processos(env, t);
  const deadlines = await juridico.prazos(env, t, cases.k1);
  const reqs = await juridico.exigencias(env, t);
  const fin = await correspondente.casos(env, t);
  const commissions = await correspondente.comissoes(env, t, fin.f3);
  return { cases, deadlines, reqs, fin, commissions };
}

function eventsOf(ids) {
  return [
    ['legal.deadline.created', { id: ids.deadlines.d1, legalCaseId: ids.cases.k1 }], ['legal.case.updated', { id: ids.cases.k1 }], ['legal.case.created', { id: ids.cases.k3 }],
    ['legal.contract_requirement.updated', { id: ids.reqs.r1, contractId: ids.reqs.c1 }], ['financing.case.created', { id: ids.fin.f1 }],
    ['financing.status.changed', { id: ids.fin.f1, status: 'UNDER_ANALYSIS' }], ['financing.approved', { id: ids.fin.f3 }], ['financing.rejected', { id: ids.fin.f4 }],
    ['financing.approved', { id: ids.fin.f5 }], ['commission.confirmed', { id: ids.commissions.confirmed, financingCaseId: ids.fin.f3 }],
  ];
}

async function applyAll(t, ids) {
  for (const [type, payload] of eventsOf(ids)) await bi.apply(t, bi.makeEvent(t, type, payload));
}

module.exports = { MODELS, seedAll, eventsOf, applyAll };
