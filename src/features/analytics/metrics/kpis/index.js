'use strict';

// M9-D624 — KPIs do Financeiro no BI: definição no registry, cálculo a partir do read model e gravação do snapshot a cada refresh.
const { KPI_DEFINITIONS } = require('./finance.definitions');
const { ensureFinanceKpisPublished } = require('./finance.register');
const { materializeFinanceKpis, financeKpiCorrections } = require('./finance.materialize');
const listener = require('./finance.listener');
const snapshotProvider = require('./finance.snapshotProvider');
const obras = require('./obras'); // M9-D650 / M9-D651: KPIs de Obras
const crm = require('./crm'); // M9-D630 / M9-D631: KPIs do funil comercial
const legalCor = require('./legalCor'); // M9-D660 / M9-D661: KPIs do Jurídico e do Correspondente Bancário
const atendimento = require('./atendimento'); // M9-D672: KPIs de Atendimento (reviews, satisfação, reclamações e SLA)
const locacaoPrazos = require('./locacao-prazos'); // M9-D641: KPIs de prazos da Locação (garantias, obrigações, vistorias e chaves)
const tecnologia = require('./tecnologia'); // M9-D680: KPIs de Tecnologia (disponibilidade, filas, integrações, freshness, autenticação e bloqueios)
const obraPerdas = require('./obra-perdas'); // M9-D652: desperdício, custo pós-obra e recorrência
const estoque = require('./estoque'); // M9-D653: KPIs de Estoque e Patrimônio

snapshotProvider.register(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh
obras.snapshotProvider.register();
crm.snapshotProvider.register();
obraPerdas.registerProvider();
estoque.registerProvider();

module.exports = { KPI_DEFINITIONS, ensureFinanceKpisPublished, materializeFinanceKpis, financeKpiCorrections, installFinanceKpis: listener.install, ...crm.api, ...obras.api, obraPerdasKpis: obraPerdas, installObraPerdasKpis: obraPerdas.install, estoqueKpis: estoque, installEstoqueKpis: estoque.install };
Object.assign(module.exports, legalCor); // M9-D660 / M9-D661
Object.assign(module.exports, atendimento); // M9-D672
Object.assign(module.exports, locacaoPrazos); // M9-D641
Object.assign(module.exports, tecnologia); // M9-D680
