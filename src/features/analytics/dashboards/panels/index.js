'use strict';

// M9-D634 / M9-D662 — conteúdo dos painéis publicados pelas demandas do bloco BI (cada demanda acrescenta o seu).
const { CRM_PANEL } = require('./crm.panel');
const { LEGAL_PANEL } = require('./legal.panel');
const { CORRESPONDENT_PANEL } = require('./correspondent.panel');
const { CONSTRUCTION_PANEL } = require('./construction.panel'); // M9-D654
const { INVENTORY_PANEL } = require('./inventory.panel');
const { POSTWORK_PANEL } = require('./postwork.panel');
const { MARKETING_PANEL } = require('./marketing.panel'); // M9-D673
const { SUPPORT_PANEL } = require('./support.panel'); // M9-D673
const { TECH_PANEL } = require('./tech.panel'); // M9-D682

const PANELS = Object.freeze({ crm: CRM_PANEL, legal: LEGAL_PANEL, correspondent: CORRESPONDENT_PANEL, construction: CONSTRUCTION_PANEL, inventory: INVENTORY_PANEL, postwork: POSTWORK_PANEL, marketing: MARKETING_PANEL, support: SUPPORT_PANEL, tech: TECH_PANEL });

module.exports = { PANELS, CRM_PANEL, LEGAL_PANEL, CORRESPONDENT_PANEL, CONSTRUCTION_PANEL, INVENTORY_PANEL, POSTWORK_PANEL, MARKETING_PANEL, SUPPORT_PANEL, TECH_PANEL };
