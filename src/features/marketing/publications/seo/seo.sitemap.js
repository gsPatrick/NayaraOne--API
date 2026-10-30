'use strict';

const { sequelize } = require('../../../../models');
const repo = require('./seo.repository');
const { readSeoConfig } = require('./seo.settings');
const { canonicalPath } = require('./seo.slug');

/** Limite do protocolo de sitemap (sitemaps.org): 50 mil endereços por arquivo. */
const SITEMAP_MAX_URLS = 50000;

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * Sitemap das páginas ATIVAS (só elas são indexáveis; vendido, alugado e removido saem). A geração toma uma trava por empresa dentro da transação:
 * duas gerações simultâneas esperam uma pela outra e nenhuma enxerga meia lista (M9-D427 seção 6). Sem a URL base configurada
 * (`marketing.seo.url_base`) os endereços saem relativos.
 */
async function generateSitemap(tenant, transaction, now = new Date()) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `mkt-sitemap|${tenant.companyId}` }, transaction });
  const config = await readSeoConfig(tenant, transaction);
  const pages = await repo.listActivePages(tenant, SITEMAP_MAX_URLS, transaction);
  const urls = pages.map((p) => {
    const loc = `${config.baseUrl || ''}${canonicalPath({ publicId: p.public_id, tipo: p.tipo, bairro: p.bairro, quartos: p.quartos, finalidade: p.finalidade })}`;
    return `  <url><loc>${escapeXml(loc)}</loc><lastmod>${new Date(p.updated_at).toISOString()}</lastmod></url>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  return { generatedAt: now.toISOString(), count: pages.length, xml };
}

module.exports = { generateSitemap, SITEMAP_MAX_URLS };
