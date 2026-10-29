'use strict';

// Fábricas da memória da NAY (M9-D009). Tudo roda com nayara_runtime (RLS real) em transação com rollback.

const knowledge = require('../../../src/features/ai/knowledge');
const rec = require('../../../src/features/ai/recommendations');
const { MemoryService } = require('../../../src/features/ai/memory');
const { uid, inserirRun } = require('../../helpers/aiRuns');
const { dadosRec } = require('./iaRecomendacao');

const memoria = new MemoryService();
const comPerm = (ctx, ...permissions) => ({ ...ctx, permissions });
const NAY = (ctx, ...permissions) => ({ ...ctx, userId: undefined, serviceIdentity: true, permissions });

/** Entrada de save com valores válidos (DECISION de escopo COMPANY); `extra` sobrescreve. */
const dados = (sourceId, extra = {}) => ({
  type: 'DECISION', scope: 'COMPANY', sourceType: 'RUN', sourceId, subjectType: 'Property', subjectId: `aurora-${uid().slice(0, 8)}`,
  value: { decision: 'Priorizar o Edifício Aurora', rationale: 'Decisão da diretoria' }, ...extra,
});

const origemRun = (tenant, tx) => inserirRun(tenant, tx);

/** Recomendação informativa já decidida por uma pessoa (origem aceita da NAY para DECISION e RECOMMENDATION_OUTCOME). */
async function origemRecomendacao(tenant, tx, ctxDecisor) {
  const nay = comPerm(ctxDecisor, 'ai:use');
  const { recommendation } = await rec.createRecommendation(nay, dadosRec(), tx);
  await rec.acceptRecommendation(comPerm(ctxDecisor, 'ai:read', 'ai:approve'), recommendation.id, {}, tx);
  return recommendation.id;
}

/** Conhecimento HOMOLOGADO escrito por `autor` e homologado por `homologador` (origem do procedimento aprovado). */
async function origemConhecimento(autor, homologador, tx) {
  const e = await knowledge.createEntry(autor, {
    factKey: `procedimento.${uid().slice(0, 8)}`, subjectType: 'procedimento', title: 'Fechar o mês', value: { passos: 3 }, classification: 'INTERNAL',
  }, tx);
  await knowledge.homologate(homologador, e.id, tx);
  return e.id;
}

const valorProcedimento = { title: 'Fechar o mês', steps: ['Conciliar o banco', 'Conferir as baixas'] };

async function rejeita(promessa, status, code) {
  const assert = require('node:assert/strict');
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.code, code, err.message);
  assert.equal(err.statusCode, status);
  return err;
}

module.exports = { memoria, comPerm, NAY, dados, origemRun, origemRecomendacao, origemConhecimento, valorProcedimento, rejeita };
