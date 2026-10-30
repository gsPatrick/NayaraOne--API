'use strict';

const { hashPayload } = require('../dispatch/canonicalJson');

/** Chave da página no site: `property:<slug>:<idioma>`. É a mesma para o mesmo imóvel e idioma, em qualquer publicação (o site identifica a página por ela). */
const pageKeyOf = (slug, locale) => `property:${String(slug).toLowerCase()}:${locale}`;

/** Campos da página que o adapter recebe além do read model: chave, idioma, referência do conteúdo e o hash dele (só do read model público, M9-D231). */
function pageFieldsOf(readModel, locale) {
  const slug = String(readModel.public_code).toLowerCase();
  const contentHash = hashPayload(readModel);
  return { slug, pageKey: pageKeyOf(slug, locale), locale, contentHash, contentRef: `property:${slug}@${contentHash.slice(0, 12)}` };
}

module.exports = { pageKeyOf, pageFieldsOf };
