'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { canSend } = require('./canSend');

/** Finalidades dos públicos da campanha em que a pessoa está (a finalidade é do público, M9-D412). */
async function audiencePurposes(ctx) {
  const rows = await sequelize.query(
    `SELECT DISTINCT a.purpose FROM marketing.campaign_audience_members m
       JOIN marketing.campaign_audiences a ON a.id = m.audience_id AND a.company_id = m.company_id
      WHERE m.company_id = :companyId AND m.campaign_id = :campaignId AND m.person_id = :personId ORDER BY a.purpose`,
    { replacements: { companyId: ctx.tenant.companyId, campaignId: ctx.campaign.id, personId: ctx.personId }, type: QueryTypes.SELECT, transaction: ctx.transaction }
  );
  return rows.map((r) => r.purpose);
}

/** O step usa template com referência oficial aprovada no provedor? */
async function templateIsOfficial(ctx) {
  const [row] = await sequelize.query(
    'SELECT official_template_ref FROM marketing.templates WHERE id = :id AND company_id = :companyId',
    { replacements: { id: ctx.step.templateId, companyId: ctx.tenant.companyId }, type: QueryTypes.SELECT, transaction: ctx.transaction }
  );
  return Boolean(row && row.official_template_ref);
}

/**
 * Porta de envio dos steps de campanha (M9-D412): o disparo chama `canSend` na hora do envio, uma vez por finalidade do público
 * da pessoa (basta uma recusa para bloquear), e o adapter real do canal entrega (`send`, M9-D429). O disparo nunca reimplementa
 * a precedência. `purposeOf` e `isOfficial` podem ser trocados (testes); o padrão lê o público e o template do banco.
 */
function buildCampaignSendPort({ send, purposeOf = audiencePurposes, isOfficial = templateIsOfficial }) {
  if (typeof send !== 'function') throw new TypeError('A porta de campanha precisa do send do adapter do canal.');
  return {
    async canSend(ctx) {
      const purposes = [].concat(await purposeOf(ctx));
      if (purposes.length === 0) return { allowed: false, reason: 'PURPOSE_UNKNOWN' };
      const officialTemplate = await isOfficial(ctx);
      for (const purpose of purposes) {
        let decision;
        try {
          decision = await canSend(ctx.personId, ctx.step.channel, purpose, ctx.now, { tenant: ctx.tenant, transaction: ctx.transaction, officialTemplate });
        } catch (err) {
          if (err && err.code === 'MKT_PURPOSE_UNKNOWN') return { allowed: false, reason: 'PURPOSE_UNKNOWN' }; // erro de configuração: nunca envia
          throw err;
        }
        if (!decision.allowed) return { allowed: false, reason: decision.reason, nextEligibleAt: decision.nextEligibleAt };
      }
      return { allowed: true };
    },
    send,
  };
}

module.exports = { buildCampaignSendPort };
