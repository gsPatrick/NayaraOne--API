'use strict';

// M9-D634 / M9-D662 — conteúdo dos painéis publicados pelas demandas do bloco BI (cada demanda acrescenta o seu).
const { CRM_PANEL } = require('./crm.panel');

const PANELS = Object.freeze({ crm: CRM_PANEL });

module.exports = { PANELS, CRM_PANEL };
