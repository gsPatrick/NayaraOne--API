'use strict';

// Ambiente HTTP do canal da NAY Atendimento (M9-D030/D041): o ambiente das rotas de execução com o agente ATIVO da definição de código, a
// identidade de serviço do canal criada pela rota (ai:admin) e um contato do CRM com endereço de canal, commitado. Nunca chama MFA nem forja token.
const assert = require('node:assert/strict');
const { withTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const { DEFINITION } = require('../../../src/features/ai/agents/nay_atendimento');
const personContacts = require('../../../src/features/people/personContacts.service');
const Http = require('./iaCorrespondenteHttp');
const R = require('./iaRunApiEnv');

const PERMISSOES_CANAL = ['ai:read', 'crm:opportunities:read', 'properties:read'];
const CODIGO = DEFINITION.code;

/** Agente ativo da definição de código + identidade de serviço do canal (permissões de leitura). */
async function canalAtivo(env, tenant, permissoes = PERMISSOES_CANAL) {
  await Http.agenteAtivo(env, tenant, DEFINITION);
  const r = await env.call('POST', '/ai/service-identities', env.tokens['A:gestor'], { agentCode: CODIGO, permissions: permissoes });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

/** Telefone de WhatsApp único por chamada (só dígitos) para não colidir com outros arquivos do mesmo cluster. */
const telefoneNovo = () => `5511${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;

/** Contato com oportunidade e WhatsApp, commitados na empresa; devolve { pessoa, telefone }. */
async function contatoDoCanal(tenant, telefone = telefoneNovo(), tipo = 'WHATSAPP') {
  const { pessoa } = await R.criarOportunidadeCommitada(tenant);
  await withTenantTransaction(tenant, (tx) => personContacts.createContact(pessoa.id, { contactType: tipo, valueNormalized: telefone }, tenant.userId, tx));
  return { pessoa, telefone };
}

const ultimaChamada = async (runId) => (await Http.admin('SELECT * FROM ai.tool_calls WHERE run_id = $1 ORDER BY seq', [runId])).rows;
const lerRun = async (runId) => (await Http.admin('SELECT * FROM ai.ai_runs WHERE id = $1', [runId])).rows[0];

module.exports = { ...Http, canalAtivo, contatoDoCanal, telefoneNovo, ultimaChamada, lerRun, uniqueSuffix, CODIGO, PERMISSOES_CANAL };
