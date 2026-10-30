'use strict';

const { rows, one, blocker } = require('./sql');

/** Impacto de desativar (aposentar) uma versão de agente da NAY (linha 19): execuções dos últimos 30 dias e ferramentas ligadas. */
async function aiAgent({ params, transaction }) {
  const code = String(params.code || '').toLowerCase();
  const version = Number(params.version);
  const a = await one(transaction, 'SELECT id, code, version, status, enabled FROM ai.agents WHERE lower(code) = :code AND version = :version', { code, version: Number.isInteger(version) ? version : -1 }, 'Versão do agente não encontrada.', 'AI_AGENT_VERSION_NOT_FOUND');
  const [runs] = await rows(transaction, `SELECT COUNT(*)::int AS n FROM ai.ai_runs WHERE agent_id = :id AND created_at >= now() - interval '30 days'`, { id: a.id });
  const [tools] = await rows(transaction, 'SELECT COUNT(*)::int AS n FROM ai.agent_tools WHERE agent_id = :id AND enabled = true', { id: a.id });
  return {
    code: a.code,
    label: `${a.code} versão ${a.version}`,
    impact: {
      counts: { versions: 1, runsLast30Days: runs.n, enabledTools: tools.n },
      totalAmountCents: 0,
      blockers: a.status === 'RETIRED' ? [blocker('AGENT_ALREADY_RETIRED', 'a versão já está aposentada')] : [],
      items: [{ type: 'AGENT_VERSION', id: a.id, label: `${a.code} v${a.version}`, status: a.status }],
    },
  };
}

module.exports = { aiAgent };
