'use strict';

// M9-D004 — duas ativações simultâneas do mesmo agente são serializadas (advisory lock + FOR UPDATE): sobra UMA versão ACTIVE e
// nenhuma das duas falha por violação de unicidade. Commita dados: só roda no cluster descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTenantTransaction } = require('../testHelpers');
const { upsertSetting } = require('../../src/features/settings/settings.service');
const agents = require('../../src/features/ai/agents');
const {
  carregarPessoas, sequelize, q, ctxDe, BASE_AGENT, FERRAMENTA, prepararTenants, uid,
} = require('../helpers/aiAgents');

const SKIP = process.env.DISPOSABLE_DB === '1' ? false : 'precisa do cluster descartável (nunca commitar no banco do .env)';
let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => {
  // Esta suíte commitou a dispensa da avaliação verde: devolve o padrão para os outros arquivos.
  if (!SKIP) await withTenantTransaction(tenantA, (tx) => upsertSetting('ia.agente.avaliacao_verde_obrigatoria', true, ctxDe(tenantA), ctxDe(tenantA).userId, tx));
  await sequelize.close();
});

test('m9d004_ativacoes_simultaneas_deixam_uma_so_versao_ativa', { skip: SKIP }, async () => {
  const code = `T_${uid().slice(0, 8).toUpperCase()}`;
  const criador = ctxDe(tenantA);
  const avaliador = ctxDe(tenantA);
  await withTenantTransaction(tenantA, async (tx) => {
    await upsertSetting('ia.agente.avaliacao_verde_obrigatoria', false, criador, criador.userId, tx);
    await agents.createVersion(criador, code, { ...BASE_AGENT, tools: [FERRAMENTA] }, tx);
    await agents.createVersion(criador, code, { purpose: 'Versão 2 para a corrida.' }, tx);
    await agents.homologate(avaliador, code, 1, {}, tx);
    await agents.homologate(avaliador, code, 2, {}, tx);
  });
  const resultados = await Promise.allSettled([1, 2].map((v) => withTenantTransaction(tenantA, (tx) => agents.activate(criador, code, v, tx))));
  assert.deepEqual(resultados.map((r) => r.status), ['fulfilled', 'fulfilled'], JSON.stringify(resultados.map((r) => r.reason && r.reason.message)));
  const linhas = await withTenantTransaction(tenantA, (tx) => q('SELECT version, status FROM ai.agents WHERE code = :code ORDER BY version', { code }, tx));
  assert.equal(linhas.filter((l) => l.status === 'ACTIVE').length, 1, JSON.stringify(linhas));
  assert.equal(linhas.filter((l) => l.status === 'RETIRED').length, 1);
});
