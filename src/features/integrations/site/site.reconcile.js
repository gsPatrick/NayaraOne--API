'use strict';

const { SitePage } = require('../../../models');

/** Dados que a reconciliação (M9-D215) entrega ao adapter do site: o `pageKey` e o hash do conteúdo da página do envio, para consultar o estado dela no site antes de repetir uma publicação de resultado incerto (a versão antiga no ar não prova que a nova chegou). */
async function siteReconcileEnricher({ ctx, dispatch, transaction }) {
  if (dispatch.aggregateType !== 'SitePage' || !dispatch.aggregateId) return {};
  const page = await SitePage.findOne({ where: { id: dispatch.aggregateId, companyId: ctx.companyId }, attributes: ['pageKey', 'contentHash'], transaction });
  return page ? { pageKey: page.pageKey, contentHash: page.contentHash } : {};
}

module.exports = { siteReconcileEnricher };
