'use strict';

const { sequelize } = require('../../../models');
const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { KEYS, INGEST_SETTING_DEFAULTS } = require('./ingest.settings');

/**
 * Descarte do conteúdo de origem depois da reconciliação (M9-D900, auditoria L4). `mig_records.source_payload` guarda a linha inteira do sistema antigo (CPF, nascimento). Passados
 * `migracao.payload.retencao_dias` dias do registro RECONCILED o conteúdo é apagado; o hash da linha, o estado e a referência ao destino ficam. Um replay relê a origem e devolve o
 * conteúdo (o hash igual prova que é o mesmo), e a próxima passagem o descarta de novo. Roda empresa a empresa pelo migrationRunJob. Devolve quantos registros foram limpos.
 */
async function purgePayloads(tenant, transaction) {
  const days = Number(await getSetting(KEYS.PAYLOAD_DAYS, tenant, transaction, INGEST_SETTING_DEFAULTS[KEYS.PAYLOAD_DAYS]));
  const [, meta] = await sequelize.query(
    "UPDATE governance.mig_records SET source_payload = NULL WHERE company_id = :companyId AND state = 'RECONCILED' AND source_payload IS NOT NULL AND updated_at <= now() - make_interval(days => :days::int)",
    { transaction, replacements: { companyId: tenant.companyId, days } }
  );
  const purged = (meta && meta.rowCount) || 0;
  if (purged) {
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'migration.payload.purged', entityType: 'MigRecord', entityId: tenant.companyId,
      afterJson: { purged, retentionDays: days }, reason: 'Conteúdo de origem descartado após o prazo da reconciliação.',
    }, transaction);
  }
  return purged;
}

module.exports = { purgePayloads };
