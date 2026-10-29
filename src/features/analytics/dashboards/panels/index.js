'use strict';

// M9-D634 / M9-D662 — conteúdo dos painéis publicados pelas demandas do bloco BI (cada demanda acrescenta o seu).
const { CRM_PANEL } = require('./crm.panel');
const { LEGAL_PANEL } = require('./legal.panel');
const { CORRESPONDENT_PANEL } = require('./correspondent.panel');
const { CONSTRUCTION_PANEL } = require('./construction.panel'); // M9-D654
const { INVENTORY_PANEL } = require('./inventory.panel');
const { POSTWORK_PANEL } = require('./postwork.panel');

const PANELS = Object.freeze({ crm: CRM_PANEL, legal: LEGAL_PANEL, correspondent: CORRESPONDENT_PANEL, construction: CONSTRUCTION_PANEL, inventory: INVENTORY_PANEL, postwork: POSTWORK_PANEL });

module.exports = { PANELS, CRM_PANEL, LEGAL_PANEL, CORRESPONDENT_PANEL, CONSTRUCTION_PANEL, INVENTORY_PANEL, POSTWORK_PANEL };
