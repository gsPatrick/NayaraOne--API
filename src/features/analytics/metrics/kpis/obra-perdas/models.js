'use strict';

// M9-D652 — nomes dos read models lidos pelos KPIs de desperdício, custo pós-obra e recorrência. Só nomes: o SQL monta o schema pelo nome (a varredura da M9-D700 só deixa citar `rm_...` com o schema na camada read-models).
const MODELS = Object.freeze({ waste: 'rm_project_waste', postwork: 'rm_postwork_cost', cost: 'rm_project_cost', occurrences: 'rm_project_occurrences' });

module.exports = { MODELS };
