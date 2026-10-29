'use strict';

const { getSetting } = require('../../settings/settings.service');
const { PRINT_MAX_KEY, BCP_SETTING_DEFAULTS } = require('./bcp.settings');
const { assertUserSector, listSectors } = require('./bcp.sectors');
const templates = require('./formTemplates.repository');
const { resolveReferences } = require('./formPrint.range');
const { renderSheets } = require('./formPrint.render');
const E = require('./bcp.errors');

/**
 * Versão imprimível do formulário (M9-D834 §3.3): PDF em branco com o cabeçalho e um espaço por campo; com `?from=&to=` (e `?year=`), as folhas já numeradas, cada uma com o
 * número que M9-D831 aceita como `manual_reference`. Formulário inexistente no setor: 404; setor que não é do usuário: 403; faixa inválida: 400. Não carrega dado de cliente.
 */
async function printTemplate({ tenant, actorUserId, sector, formType, query = {}, transaction, now = new Date() }) {
  const template = await templates.findInSector(sector, formType, transaction);
  if (!template) throw E.formNotFound();
  await assertUserSector(actorUserId, tenant, sector, transaction);
  const maxSheets = Number(await getSetting(PRINT_MAX_KEY, tenant, transaction, BCP_SETTING_DEFAULTS[PRINT_MAX_KEY]));
  const references = resolveReferences(sector, query, maxSheets, now);
  const sectorLabel = ((await listSectors(transaction)).find((item) => item.sector === sector) || {}).label || sector;
  const buffer = await renderSheets({ template, sectorLabel, references });
  const numbered = references[0] !== null;
  const fileName = numbered ? `${template.formType}_${references[0]}_a_${references[references.length - 1]}.pdf` : `${template.formType}_em_branco.pdf`;
  return { buffer, fileName, mimeType: 'application/pdf', pages: references.length, firstReference: references[0], lastReference: references[references.length - 1] };
}

module.exports = { printTemplate };
