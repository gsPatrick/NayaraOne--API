'use strict';

// Apoio dos testes da NAY Diretoria (M9-D035): cenário pelo ciclo completo do agente, permissões de quem pergunta e consultas ao run gravado.
const N = require('./iaNayAgentes');
const D = require('../../../src/features/ai/agents/nay_diretoria');

const PERMS = ['ai:use', 'finance:read', 'crm:opportunities:read', 'construction:read', 'legal:read', 'correspondent:read', 'inventory:read'];
const RECUSA = 'Isso foge do que este assistente pode fazer.';

const cenario = (tenant, tx, opts = {}) => N.cenarioNay(tenant, tx, { definition: D.DEFINITION, goldenCases: D.GOLDEN_CASES, register: D.registerNayDiretoria, perms: PERMS, ...opts });
const authSem = (c, ...faltam) => ({ ...c.auth, permissions: c.auth.permissions.filter((p) => !faltam.includes(p)) });
const authCom = (c, ...perms) => ({ ...c.auth, permissions: perms });

const lerRun = async (id, tx) => (await N.q('SELECT * FROM ai.ai_runs WHERE id = :id', { id }, tx))[0];
const chamadas = (runId, tx) => N.q('SELECT tool_name, status, blocked_reason FROM ai.tool_calls WHERE run_id = :runId ORDER BY seq', { runId }, tx);
const recomendacoes = async (tx) => (await N.q('SELECT count(*)::int AS n FROM ai.ai_recommendations', {}, tx))[0].n;
const propostas = async (tx) => (await N.q("SELECT count(*)::int AS n FROM ai.ai_recommendations WHERE status = 'PENDING' AND proposed_action IS NOT NULL", {}, tx).catch(() => [{ n: 0 }]))[0].n;

module.exports = { ...N, D, PERMS, RECUSA, cenario, authSem, authCom, lerRun, chamadas, recomendacoes, propostas };
