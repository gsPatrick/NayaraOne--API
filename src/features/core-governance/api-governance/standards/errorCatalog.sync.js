'use strict';

const { sequelize } = require('../../../../models');
const { entriesFromData } = require('./errorCatalog.data');

/**
 * Sincroniza governance.error_catalog com errorCatalog.data.json (mesma fonte de docs/ERROR_CODES.md): insere o que falta e atualiza texto, status, módulo e descontinuação.
 * Roda numa transação própria com `app.error_catalog_sync = 'on'` (a única que abre a escrita). Devolve quantas linhas foram gravadas.
 */
async function syncErrorCatalog() {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.error_catalog_sync', 'on', true)", { transaction });
    let written = 0;
    for (const e of entriesFromData()) {
      const [, meta] = await sequelize.query(
        `INSERT INTO governance.error_catalog AS c (code, http_status, message_pt, module, since_version, deprecated) VALUES (:code, :status, :message, :module, :since, :deprecated)
         ON CONFLICT (code) DO UPDATE SET http_status = EXCLUDED.http_status, message_pt = EXCLUDED.message_pt, module = EXCLUDED.module, deprecated = EXCLUDED.deprecated, updated_at = now()
          WHERE (c.http_status, c.message_pt, c.module, c.deprecated) IS DISTINCT FROM (EXCLUDED.http_status, EXCLUDED.message_pt, EXCLUDED.module, EXCLUDED.deprecated)`,
        { transaction, replacements: { code: e.code, status: e.status, message: e.message, module: e.module, since: e.since, deprecated: e.deprecated } }
      );
      written += meta && meta.rowCount ? meta.rowCount : 0;
    }
    return written;
  });
}

module.exports = { syncErrorCatalog };
