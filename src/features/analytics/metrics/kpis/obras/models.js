'use strict';

// M9-D650 / M9-D651 — nomes dos read models de Obras (M9-D618) lidos pelos KPIs. Só nomes: o SQL monta o schema pelo nome (a varredura da M9-D700 só deixa citar `rm_...` com o schema na camada read-models).
const MODELS = Object.freeze({
  progress: 'rm_project_progress', cost: 'rm_project_cost', delays: 'rm_project_delays', measurements: 'rm_project_measurements', nonconformities: 'rm_project_nonconformities',
});

module.exports = { MODELS };
