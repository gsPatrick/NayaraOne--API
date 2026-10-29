'use strict';

// M9-D632 / M9-D633 — os pacotes de KPIs de Comercial e Imóveis que o motor (commercial.entries) calcula, em ordem.
const PACKS = Object.freeze([
  require('./commercial.pack.visitsImoveis'),
]);

module.exports = { PACKS };
