'use strict';

const { sequelize } = require('../../../config/database');
const { getSetting } = require('../../../features/settings/settings.service');
const { READER_ROLE_NAME, READER_ROLE_SETTING_KEY, READ_ONLY_SETTING_DEFAULTS } = require('./readOnly.settings');

// A existência do role é fato do ambiente (muda só com migration): guardar o resultado evita uma consulta por requisição.
const PROBE_TTL_MS = 60 * 1000;
let probe = null;

function resetReaderRoleProbe() {
  probe = null;
}

/** O role existe neste banco e a conexão da API pode assumi-lo (SET ROLE)? */
async function readerRoleAvailable(transaction) {
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.value;
  const [[row]] = await sequelize.query(
    'SELECT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = :role AND pg_has_role(current_user, r.oid, \'USAGE\')) AS ok',
    { replacements: { role: READER_ROLE_NAME }, transaction }
  );
  probe = { value: row.ok === true, at: Date.now() };
  return probe.value;
}

/** Parâmetro do administrador (padrão Ligado) E role disponível: só então a transação do GET assume o role sem escrita. */
async function shouldUseReaderRole(tenant, transaction) {
  const wanted = await getSetting(READER_ROLE_SETTING_KEY, tenant, transaction, READ_ONLY_SETTING_DEFAULTS[READER_ROLE_SETTING_KEY]);
  if (wanted !== true) return false;
  return readerRoleAvailable(transaction);
}

async function assumeReaderRole(transaction) {
  await sequelize.query(`SET LOCAL ROLE ${READER_ROLE_NAME}`, { transaction });
}

module.exports = { shouldUseReaderRole, assumeReaderRole, resetReaderRoleProbe };
