'use strict';

// Apoio dos testes da NAY Financeira (M9-D036): cenário pelo ciclo completo do agente (agente CRÍTICO), permissões e leituras do que a NAY nunca pode mexer.
const N = require('./iaNayAgentes');
const F = require('../../../src/features/ai/agents/nay_financeira');

const PERMS = ['ai:use', 'finance:read'];
const PERMS_PROPOSTA = [...PERMS, 'finance:create'];
const CHAVE_PROPOSTA = 'ia.financeira.permitir_proposta_pagamento';

const cenario = (tenant, tx, opts = {}) => N.cenarioNay(tenant, tx, { definition: F.DEFINITION, goldenCases: F.GOLDEN_CASES, register: F.registerNayFinanceira, perms: PERMS, ...opts });
const authCom = (c, ...perms) => ({ ...c.auth, permissions: perms });

const lerRun = async (id, tx) => (await N.q('SELECT * FROM ai.ai_runs WHERE id = :id', { id }, tx))[0];
const chamadas = (runId, tx) => N.q('SELECT tool_name, status, blocked_reason FROM ai.tool_calls WHERE run_id = :runId ORDER BY seq', { runId }, tx);
const contar = async (tabela, tx, where = 'true') => (await N.q(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${where}`, {}, tx))[0].n;
/** Fotografia do que a NAY nunca pode mexer: lançamentos (status e valor), intenções de pagamento e contas bancárias. */
async function fotografia(tx) {
  return {
    lancamentos: await N.q('SELECT id, status, amount::text AS amount FROM finance.financial_entries ORDER BY id', {}, tx),
    intencoes: await contar('finance.payment_intents', tx),
    contas: await N.q('SELECT id, status, updated_at FROM finance.bank_accounts ORDER BY id', {}, tx),
  };
}
const propostas = (tx) => N.q("SELECT id, status, ai_run_id FROM ai.ai_recommendations WHERE status = 'PENDING' AND proposed_action IS NOT NULL", {}, tx).catch(() => []);

module.exports = { ...N, F, PERMS, PERMS_PROPOSTA, CHAVE_PROPOSTA, cenario, authCom, lerRun, chamadas, contar, fotografia, propostas };
