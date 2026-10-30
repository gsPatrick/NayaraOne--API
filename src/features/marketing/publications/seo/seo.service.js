'use strict';

const { sequelize } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { publicReadModel } = require('../../content');
const { cadence } = require('../../automations');
const repo = require('./seo.repository');
const { readSeoConfig } = require('./seo.settings');
const { lifecycleStateOf, decideLifecycle } = require('./seo.lifecycle');
const { canonicalPath, listingPath, isPublicId, publicIdFromPath } = require('./seo.slug');
const { buildSeoMetadata } = require('./seo.metadata');

const notFound = () => AppError.notFound('Página não encontrada.', 'MKT_PAGE_NOT_FOUND');

const absolute = (config, path) => (config.baseUrl ? `${config.baseUrl}${path}` : path);

/** Abre a sessão do tenant do imóvel (a rota é pública: a empresa vem do imóvel, nunca do chamador). `outer` só nos testes (transação com rollback). */
async function inTenantTransaction(tenant, fn, outer) {
  const body = async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: tenant.groupId, c: tenant.companyId }, transaction });
    return fn(transaction);
  };
  return outer ? body(outer) : sequelize.transaction(body);
}

/** Resolve o identificador de `GET /public/properties/:id`: o uuid direto ou o último segmento de um caminho canônico (`slug-uuid`). */
function normalizeKey(key) {
  const text = String(key || '').trim();
  if (isPublicId(text)) return text.toLowerCase();
  return publicIdFromPath(text);
}

async function describePage(row, tenant, config, now, transaction) {
  const page = { publicId: row.public_id, tipo: row.tipo, bairro: row.bairro, cidade: row.cidade, quartos: row.quartos, finalidade: row.finalidade };
  const state = lifecycleStateOf(row);
  const decision = decideLifecycle({ state, daysSince: Number(row.days_since), config });
  const path = canonicalPath(page);
  const base = { publicId: page.publicId, state, http: decision.http, canonicalPath: path, cacheSeconds: config.cacheSeconds, lastModified: new Date(row.updated_at > row.lifecycle_changed_at ? row.updated_at : row.lifecycle_changed_at).toISOString() };
  if (decision.http === 301) return { ...base, redirectTo: absolute(config, listingPath(page)) };
  if (decision.http === 410) return base;
  const model = await publicReadModel.loadPublicProperty({ publicId: page.publicId }, tenant, transaction);
  const canonicalUrl = absolute(config, path);
  return { ...base, selo: decision.selo, indexable: decision.indexable, seo: buildSeoMetadata(model, { canonicalUrl, indexable: decision.indexable }), property: model.payload };
}

/**
 * GET /public/properties/:publicId (pública, M9-D427). Devolve { http, ... }: 200 com a página (metadata e JSON-LD de campos verdadeiros),
 * 301 com o destino (listagem do bairro/tipo) ou 410. Imóvel que nunca foi publicado, ou publicId inexistente: 404 sem pista do motivo.
 * Caminho com slug desatualizado resolve pelo publicId e a página responde 200 com o canonical correto (o slug nunca quebra o link).
 */
async function getPublicPage({ key, now = new Date(), transaction: outer }) {
  const publicId = normalizeKey(key);
  if (!publicId) throw notFound();
  const tenant = await repo.resolveTenant(publicId, outer);
  if (!tenant) throw notFound();
  return inTenantTransaction(tenant, async (transaction) => {
    const config = await readSeoConfig(tenant, transaction);
    const zone = (await cadence.getMarketingParam(cadence.QUIET_HOURS_KEY, tenant, transaction)).timeZone;
    const row = await repo.loadPageRow(publicId, tenant, zone, now, transaction);
    if (!row) throw notFound();
    return describePage(row, tenant, config, now, transaction);
  }, outer);
}

module.exports = { getPublicPage, inTenantTransaction, normalizeKey };
