'use strict';

const { sequelize, Group, Company } = require('../../models');
const { reconcileUnpublishing } = require('../../features/integrations/portal');

/**
 * portalUnpublishReconcileJob (Marco 9, M9-D233): a cada minuto confere as remoções de anúncio que o portal ainda não confirmou. Quem decide se um anúncio está na hora são o prazo
 * de 60 min e a cadência de 30 min (`integration.portal.unpublish_*`), gravados em cada vínculo; o relógio só acorda o job.
 */
const TICK_MS = 60 * 1000;

async function runPortalUnpublishReconcileJob({ now = new Date() } = {}) {
  const groups = await Group.findAll();
  const summary = { companies: 0, checked: 0, confirmed: 0, resent: 0, exhausted: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        const r = await reconcileUnpublishing({ group, company, now });
        summary.companies += 1;
        ['checked', 'confirmed', 'resent', 'exhausted'].forEach((k) => { summary[k] += r[k]; });
      } catch (err) {
        summary.errors += 1;
        console.error(`[PortalUnpublishReconcileJob] Falha na empresa ${company.id}: ${err.message}`);
      }
    }
  }
  return summary;
}

function startPortalUnpublishReconcileJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runPortalUnpublishReconcileJob().finally(() => { running = false; }).catch((err) => {
      console.error('[PortalUnpublishReconcileJob] Falha na execução agendada:', err.message);
    });
  }, tickMs);
}

module.exports = { runPortalUnpublishReconcileJob, startPortalUnpublishReconcileJob };
