'use strict';

const viewFields = require('../dlp/view.fields');
const scale = require('../../../shared/data-classification/scale');
const view = require('./fieldAccess.view');

/**
 * Liga o registro de classificação (M9-D910) à política de VIEW da tela e da API (M9-D825, `view.fields.js#setFieldSource` e `#setMaskSource`): os campos HIGH e RESTRICTED
 * de cada tipo de recurso passam a vir do registro (somados aos de `governanca.dlp.view.campos`; a classe mais alta vale) e cada um sai com a máscara do registro. Chamado uma
 * vez ao carregar o módulo.
 */
function install() {
  viewFields.setFieldSource(async (tenant, resourceType, transaction) => {
    const fromSetting = await viewFields.settingSource(tenant, resourceType, transaction);
    const merged = { ...(await view.registryFields(tenant, resourceType, transaction)) };
    for (const [field, classification] of Object.entries(fromSetting || {})) {
      const existing = Object.keys(merged).find((key) => viewFields.normalizeKey(key) === viewFields.normalizeKey(field));
      if (existing) merged[existing] = scale.highest([merged[existing], classification]); else merged[field] = classification;
    }
    return merged;
  });
  viewFields.setMaskSource(view.maskSpecs, view.maskByRegistry);
}

module.exports = { install };
