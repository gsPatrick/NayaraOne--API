'use strict';

const { providerRegistry } = require('../providers');

/**
 * Vetores do texto (M9-D022 passo 7 e M9-D023): chama `embed()` do adapter do registro de provedores (M9-D010/D011), nunca um fornecedor
 * direto. O escolhido é o candidato de embedding mais barato que a política de classificação do provedor aceita; para o texto que nenhum
 * provedor externo pode receber (CONFIDENTIAL/RESTRICTED sem contrato), só vale um provedor SEM conexão externa (o sandbox determinístico
 * do laboratório), cujo texto não sai do servidor. A busca e a gravação usam o mesmo modelo (`embedding_model`), senão não se comparam.
 */
const fail = (code) => Object.assign(new Error(code), { code });

async function pickLocal(tenant, transaction) {
  for (const entry of providerRegistry.list()) {
    const Class = providerRegistry.classOf(entry.providerCode);
    if (!Class || Class.requiresConnection) continue;
    const adapter = await providerRegistry.instance(entry.providerCode, tenant, transaction).catch(() => null);
    const model = adapter && adapter.models().find((m) => m.embed);
    if (model) return { providerCode: entry.providerCode, model: model.model };
  }
  return null;
}

/** Provedor e modelo de embedding para a classificação; null se nenhum serve. */
async function pickEmbedder(tenant, classification, transaction) {
  const [melhor] = await providerRegistry.candidates({ capability: 'embed', politica: { classification }, requestSize: { tokensIn: 1 } }, tenant, transaction);
  return melhor ? { providerCode: melhor.providerCode, model: melhor.model } : pickLocal(tenant, transaction);
}

const norm = (v) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));

/**
 * embedTexts(tenant, textos, { classification, batch }, transaction) => { vectors: [{ embedding, norm }], model: 'provedor:modelo' }.
 * Lote de `batch` textos por chamada. Falha do provedor ou vetor nulo = Error EMBED_FAILED; nenhum provedor = EMBED_NO_PROVIDER.
 */
async function embedTexts(tenant, textos, { classification, batch }, transaction) {
  const pick = await pickEmbedder(tenant, classification, transaction);
  if (!pick) throw fail('EMBED_NO_PROVIDER');
  const adapter = await providerRegistry.instance(pick.providerCode, tenant, transaction);
  const vectors = [];
  for (let i = 0; i < textos.length; i += batch) {
    let out;
    try {
      out = await adapter.embed({ model: pick.model, inputs: textos.slice(i, i + batch) });
    } catch (err) {
      throw fail('EMBED_FAILED');
    }
    if (!out || !Array.isArray(out.vectors) || out.vectors.length !== Math.min(batch, textos.length - i)) throw fail('EMBED_FAILED');
    for (const v of out.vectors) {
      const n = Array.isArray(v) ? norm(v) : 0;
      if (!(n > 0) || v.some((x) => !Number.isFinite(x))) throw fail('EMBED_FAILED');
      vectors.push({ embedding: v, norm: n });
    }
  }
  return { vectors, model: `${pick.providerCode}:${pick.model}` };
}

/** Vetor da consulta com o MESMO modelo dos chunks: `model` = 'provedor:modelo' já gravado. */
async function embedQuery(tenant, query, classification, transaction) {
  const { vectors, model } = await embedTexts(tenant, [query], { classification, batch: 1 }, transaction);
  return { ...vectors[0], model };
}

module.exports = { embedTexts, embedQuery, pickEmbedder };
