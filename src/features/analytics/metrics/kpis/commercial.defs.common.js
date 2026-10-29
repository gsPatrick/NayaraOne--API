'use strict';

/**
 * M9-D632 / M9-D633 — peças comuns das definições dos KPIs de Comercial e Imóveis no Metric Registry: relatório de referência da conciliação (M9-D708),
 * políticas de atualização do livro (evento a cada 15 min, ou job às 00:05) e o formato da regra de qualidade.
 */
const REFERENCE_REPORT = 'Relatório de conciliação de KPIs do Comercial (M9-D708): visitas, propostas, imóveis, preços, Radar e corretores conforme o CRM e o cadastro de imóveis';
const EVENT = Object.freeze({ mode: 'EVENT', maxStalenessMinutes: 15 });
const DAILY = Object.freeze({ mode: 'SCHEDULE', cron: '5 0 * * *', maxStalenessMinutes: 1440 }); // job às 00:05 (e o evento, que também recalcula)
const quality = (requiredFields, maxStalenessMinutes = 15) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes, requiredFields, allowNull: true });

module.exports = { EVENT, DAILY, quality };
