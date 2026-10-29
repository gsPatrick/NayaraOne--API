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
const marketing = require('./marketing'); // M9-D670 / M9-D671: KPIs de Marketing
const atendimento = require('./atendimento'); // M9-D672: KPIs de Atendimento (reviews, satisfação, reclamações e SLA)
const locacaoPrazos = require('./locacao-prazos'); // M9-D641: KPIs de prazos da Locação (garantias, obrigações, vistorias e chaves)
const locacaoAtendimento = require('./locacao-atendimento'); // M9-D642: KPIs de chamados, satisfação e repasses da Locação
const decisao = require('./decisao'); // M9-D709: KPIs da fila de decisão do Centro de Comando (aprovações financeiras, ajustes de estoque, regras e propostas da NAY)
const centroComando = require('./centro-comando'); // M9-D710: KPIs de fatos do dia do Centro de Comando (contratos assinados, oportunidades ganhas, pagamentos liquidados)
const tecnologia = require('./tecnologia'); // M9-D680: KPIs de Tecnologia (disponibilidade, filas, integrações, freshness, autenticação e bloqueios)
const obraPerdas = require('./obra-perdas'); // M9-D652: desperdício, custo pós-obra e recorrência
const estoque = require('./estoque'); // M9-D653: KPIs de Estoque e Patrimônio

snapshotProvider.register(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh
obras.snapshotProvider.register();
crm.snapshotProvider.register();
obraPerdas.registerProvider();
estoque.registerProvider();
decisao.registerProvider();

module.exports = { KPI_DEFINITIONS, ensureFinanceKpisPublished, materializeFinanceKpis, financeKpiCorrections, installFinanceKpis: listener.install, ...crm.api, ...obras.api, obraPerdasKpis: obraPerdas, installObraPerdasKpis: obraPerdas.install, estoqueKpis: estoque, installEstoqueKpis: estoque.install };
Object.assign(module.exports, legalCor); // M9-D660 / M9-D661
Object.assign(module.exports, marketing); // M9-D670 / M9-D671
Object.assign(module.exports, atendimento); // M9-D672
Object.assign(module.exports, locacaoPrazos); // M9-D641
Object.assign(module.exports, locacaoAtendimento); // M9-D642
Object.assign(module.exports, tecnologia); // M9-D680
Object.assign(module.exports, { decisionQueueKpis: decisao, installDecisionQueueKpis: decisao.install }); // M9-D709
Object.assign(module.exports, centroComando); // M9-D710
