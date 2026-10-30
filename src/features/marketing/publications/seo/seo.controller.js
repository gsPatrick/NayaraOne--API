'use strict';

const { success } = require('../../../../utils/httpResponse');
const { mktError } = require('../../marketing.errors');
const { tenantFromAuth } = require('../../marketing.module');
const service = require('./seo.service');
const { generateSitemap } = require('./seo.sitemap');

/** Cache por URL (DI-D427-9): tempo do parâmetro + Last-Modified da página; o ETag da resposta faz a revalidação condicional (304). */
function setCacheHeaders(res, out) {
  res.set('Cache-Control', out.cacheSeconds > 0 ? `public, max-age=${out.cacheSeconds}, must-revalidate` : 'no-cache');
  res.set('Last-Modified', new Date(out.lastModified).toUTCString());
}

// GET /public/properties/:publicId (pública): 200 com a página, 301 (Location = listagem) ou 410.
async function getPublicProperty(req, res) {
  const out = await service.getPublicPage({ key: req.params.publicId });
  setCacheHeaders(res, out);
  if (out.http === 410) throw mktError(410, 'MKT_PAGE_GONE', 'Esta página não está mais disponível.', { publicId: out.publicId });
  if (out.http === 301) res.set('Location', out.redirectTo);
  if (out.indexable === false) res.set('X-Robots-Tag', 'noindex, nofollow');
  return success(res, { statusCode: out.http, data: out });
}

// GET /marketing/seo/sitemap: sitemap das páginas ativas da empresa, gerado com trava.
async function sitemap(req, res) {
  const data = await req.withTenantTransaction((t) => generateSitemap(tenantFromAuth(req), t));
  return success(res, { data });
}

module.exports = { getPublicProperty, sitemap };
