'use strict';

const { RetrievalService } = require('../../retrieval/RetrievalService');

const service = new RetrievalService();

/** Tipos de fonte do índice que cada área de dados do agente (`data_scopes`, ex. `knowledge.politicas`) libera. Área sem tipo no índice não busca nele. */
const SCOPE_KINDS = Object.freeze({ knowledge: 'KNOWLEDGE_ENTRY', files: 'FILE', documents: 'FILE', urls: 'URL', web: 'URL' });

function sourceTypesOf(dataScopes) {
  return [...new Set((dataScopes || []).map((scope) => SCOPE_KINDS[String(scope).split('.')[0]]).filter(Boolean))];
}

/** Política do provedor escolhido (D011/D027): se ele aceita CONFIDENTIAL e RESTRICTED. Registro sem a lista de entradas (teste) não libera nada. */
async function providerPolicy(registry, ctx, providerCode, transaction) {
  if (!registry || typeof registry.entries !== 'function' || !providerCode) return {};
  const entry = (await registry.entries(ctx, transaction)).find((e) => e.providerCode === providerCode);
  return (entry && entry.policy) || {};
}

/**
 * O teto do AGENTE na busca (D023): classe que o provedor aceita e tipos de fonte que as áreas de dados do agente liberam. A busca soma
 * isto ao teto do ATOR (permissões dele, `ai:restricted` e finalidade) pela interseção: nunca soma permissão.
 */
async function executionCeiling({ registry, ctx, agent, decision, transaction }) {
  const policy = await providerPolicy(registry, ctx, decision && decision.provider, transaction);
  return { allowsConfidential: policy.allowsConfidential === true, allowsRestricted: policy.allowsRestricted === true, sourceTypes: sourceTypesOf(agent && agent.dataScopes) };
}

/**
 * Busca padrão do passo 4: `RetrievalService.search` com o contexto do ator (permissões e usuário), o `runId` (grava `ai.ai_sources`) e o
 * teto do agente em `opts.execution`. Os trechos voltam como blocos `untrusted` (`toUntrusted`) e `insufficient: true` é falta de fonte
 * (nenhuma fonte, e o grounding responde a insuficiência). Sem tipo de fonte liberado ao agente não há o que buscar.
 */
async function retrieveFromIndex({ ctx, execution, input, purpose, runId, transaction }) {
  if (!execution || !execution.sourceTypes.length) return [];
  const actor = { groupId: ctx.groupId, companyId: ctx.companyId, userId: ctx.userId, permissions: ctx.permissions || [] };
  const found = await service.search(actor, input, { runId, purpose, execution }, transaction);
  if (found.insufficient) return [];
  const blocks = new Map(service.toUntrusted(found.items).map((b) => [b.id, b]));
  return found.items.map((i) => {
    const block = blocks.get(i.chunkId);
    return {
      sourceType: i.sourceType === 'KNOWLEDGE_ENTRY' ? 'KNOWLEDGE_ENTRY' : 'DOCUMENT_CHUNK', sourceRef: i.sourceId, sourceVersion: String(i.sourceVersion), title: `${i.sourceType} ${i.sourceId}`,
      text: block.text, classification: block.classification, origin: block.origin, effectiveFrom: i.effectiveFrom, effectiveUntil: i.effectiveUntil,
      relevanceScore: i.relevanceScore, statusAtRetrieval: 'VIGENTE', contentHash: i.contentHash, persisted: true,
    };
  });
}

module.exports = { retrieveFromIndex, executionCeiling, sourceTypesOf };
