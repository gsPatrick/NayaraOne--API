'use strict';

// M9-D406 — apoio dos testes do pipeline de conteúdo: imóvel publicado com oferta, template publicado e a NAY sandbox.

const crypto = require('node:crypto');
const fx = require('./m9d405Fixtures');
const { templateInput } = require('./m9d404Fixtures');
const templates = require('../../src/features/marketing/content/template.service');
const nay = require('../../src/features/marketing/content/pipeline.nayPort');
require('../../src/features/marketing/publications'); // M9-D410: registra a porta de agendamento dos jobs

const uid = () => crypto.randomUUID();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** withTx para teste: tudo na MESMA transação de rollback (cada passo roda "em transação própria" só em produção). */
const sameTx = (t) => (fn) => fn(t);

/** Imóvel publicado de 3 quartos e R$ 780.000, com oferta de venda (fatos do read model público). */
async function seedProperty(t, tenant, price = 780000) {
  const prop = await fx.makeProperty(t, tenant);
  await fx.makeSaleOffer(t, tenant, prop.id, price);
  // M9-D409: NEW_PROPERTY exige ao menos uma foto autorizada.
  await fx.q(t, `INSERT INTO real_estate.property_media (id, group_id, company_id, property_id, media_type, storage_key, position, quality_status)
    VALUES (gen_random_uuid(), :g, :c, :p, 'PHOTO', :k, 1, 'APPROVED')`, { g: tenant.groupId, c: tenant.companyId, p: prop.id, k: `qa-m9/${uid()}` });
  return prop;
}

async function publishedTemplate(t, tenant, overrides) {
  const created = await templates.createTemplate(tenant, tenant.userId, templateInput(overrides), t);
  return (await templates.publishTemplate(tenant, tenant.userId, created.id, t)).template;
}

/** NAY sandbox determinística: texto só com fatos corretos. */
function registerSandboxNay(textFor) {
  const calls = [];
  nay.registerNayDraftProvider(async (request) => {
    calls.push(request);
    const f = request.facts;
    return {
      text: textFor ? textFor(f) : `Imóvel de ${f.quartos} quartos por R$ ${Number(f.precoVenda).toLocaleString('pt-BR')}.`,
      nayRunId: uid(),
      modelName: 'sandbox-m9d406',
    };
  });
  return calls;
}

const inHours = (h, from = new Date()) => new Date(from.getTime() + h * 3600000);

module.exports = { ...fx, uid, sha, sameTx, seedProperty, publishedTemplate, registerSandboxNay, inHours };
