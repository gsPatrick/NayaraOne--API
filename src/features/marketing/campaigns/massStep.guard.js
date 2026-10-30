'use strict';

const { run } = require('./campaigns.repository');
const { assertMassSendAllowed, MASS_PERMISSION } = require('../marketing.guards');

/**
 * M9-D433 — o disparo em massa é conferido a CADA step, não só ao agendar: o teto pode ter baixado e a confirmação precisa estar gravada. O tamanho é o do público congelado
 * (pessoas distintas materializadas no agendamento). Acima do teto absoluto: MKT_MASS_LIMIT_EXCEEDED. Acima do limite sem aprovação e sem a confirmação de quem agendou
 * (`mass_confirmed_by`, gravada com a permissão `marketing:send:mass`): MKT_MASS_PERMISSION_REQUIRED. Devolve o motivo (o step é pulado) ou null.
 */
async function massStepReason(campaign, tenant, transaction) {
  const [{ n }] = await run(
    'SELECT count(DISTINCT person_id)::int AS n FROM marketing.campaign_audience_members WHERE campaign_id = :id AND company_id = :companyId',
    { id: campaign.id, companyId: tenant.companyId }, transaction
  );
  try {
    await assertMassSendAllowed({ recipients: n, permissions: campaign.mass_confirmed_by ? [MASS_PERMISSION] : [], tenant, transaction });
    return null;
  } catch (err) {
    if (err && ['MKT_MASS_LIMIT_EXCEEDED', 'MKT_MASS_PERMISSION_REQUIRED'].includes(err.code)) return err.code;
    throw err;
  }
}

module.exports = { massStepReason };
