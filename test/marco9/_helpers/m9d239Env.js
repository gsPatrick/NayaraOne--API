'use strict';

// Apoio dos testes das redes sociais (M9-D239): redes programáveis com conexão ativa, conteúdo de Marketing aprovado (ou não) e leitura
// das linhas. Roda em banco descartável (os testes COMMITAM).
const crypto = require('crypto');
const base = require('./m9d215Env');
const { redeProgramavel, semearRedes, REDES } = require('./m9d239Social');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { createContentWithProvenance } = require('../../../src/features/marketing/content/contentProvenance');
const guard = require('../../../src/features/marketing/content/approval.guard');
const mktRepo = require('../../../src/features/marketing/content/pipeline.repository');
const social = require('../../../src/features/integrations/social');

const { sequelize, comTenant, ctxDe, uniqueSuffix } = base;

/** Instala as três redes (adapter programável + conexão ATIVA, desativando a que sobrou de outro teste). Devolve [{ code, Classe, connection }]. */
async function instalarRedes(tenant) {
  await semearRedes();
  const redes = [];
  for (const code of REDES) {
    const Classe = redeProgramavel(code);
    adapterRegistry.unregister(code);
    adapterRegistry.register(Classe);
    const connection = await comTenant(tenant, async (t) => {
      await sequelize.query(`UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = :p AND status = 'ACTIVE'`, { replacements: { c: tenant.companyId, p: code }, transaction: t });
      const c = await registry.createConnection({ providerCode: code, environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}` }, ctxDe(tenant), t);
      return transitionConnection(c.id, 'ACTIVE', ctxDe(tenant), t);
    });
    redes.push({ code, Classe, S: Classe.S, connection });
  }
  return redes;
}
const removerRedes = () => REDES.forEach((c) => adapterRegistry.unregister(c));

/**
 * Cria um conteúdo de Marketing. `estado`: 'DRAFT' (rascunho), 'PENDING_APPROVAL' ou 'APPROVED' (aprovado por `aprovador`, padrão a pessoa do
 * teste; 'SYSTEM_AUTOPUBLISH:classe' simula a regra pré-aprovada). `nay`: conteúdo gerado pela NAY (run e modelo gravados).
 */
async function criarConteudo(tenant, { estado = 'APPROVED', texto = `Casa nova no bairro ${uniqueSuffix()}`, nay = false, aprovador, autopublishClass, campaignId, imovelInexistente = false } = {}) {
  return comTenant(tenant, async (t) => {
    const generation = nay ? { modelName: 'qa-model', nayRunId: crypto.randomUUID() } : undefined;
    const { item, version } = await createContentWithProvenance({ type: 'INSTITUTIONAL', title: 'QA-M9 post', source: imovelInexistente ? { entityType: 'property', entityId: crypto.randomUUID(), version: 1, facts: {} } : null, bodyJson: { texto }, generation, extra: { campaignId } }, tenant, tenant.userId, t);
    if (autopublishClass) await sequelize.query('UPDATE marketing.content_items SET autopublish_class = :c WHERE id = :id', { replacements: { c: autopublishClass, id: item.id }, transaction: t });
    if (estado === 'APPROVED') {
      await guard.recordApprovedHash(tenant, tenant.userId, version.id, t);
      await mktRepo.setApprover(version.id, aprovador || String(tenant.userId), tenant.userId, t);
    }
    await mktRepo.setStatus(item.id, estado, tenant.userId, t);
    return { itemId: item.id, versionId: version.id, texto };
  });
}

const sql = (tenant, query, replacements) => comTenant(tenant, async (t) => (await sequelize.query(query, { replacements, transaction: t }))[0]);
const dispatchesDe = (tenant, itemId) => sql(tenant, 'SELECT * FROM integration.dispatches WHERE aggregate_id = :id ORDER BY created_at, provider_code', { id: itemId });
const conexao = async (tenant, id) => (await sql(tenant, 'SELECT * FROM integration.connections WHERE id = :id', { id }))[0];
const publicar = (tenant, args) => comTenant(tenant, (t) => social.publishToSocial(ctxDe(tenant), { ...args, transaction: t }));

module.exports = { ...base, instalarRedes, removerRedes, criarConteudo, dispatchesDe, conexao, publicar, sql, social, REDES };
