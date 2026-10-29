'use strict';

// M9-D653 — nomes dos read models de Estoque e Patrimônio lidos pelos KPIs. Só nomes: o SQL monta o schema pelo nome (a varredura da M9-D700 só deixa citar `rm_...` com o schema na camada read-models).
const MODELS = Object.freeze({ health: 'rm_inventory_health', tools: 'rm_tool_assets' });

module.exports = { MODELS };
