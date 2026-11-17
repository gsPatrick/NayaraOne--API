'use strict';

/**
 * Origem do lead padrão dos testes (DI-BI2-4): desde a segunda leva de 16/11/2026, `createOpportunity` e `POST /opportunities` recusam a oportunidade sem
 * `leadSource` (422 OPPORTUNITY_LEAD_SOURCE_REQUIRED). Os testes que não tratam da origem criam a oportunidade como lead de formulário, espalhando
 * `...ORIGEM_LEAD_PADRAO` no corpo. Quem testa a origem (a recusa, o canal, a automação do lead novo) escreve a origem explicitamente.
 */
const ORIGEM_LEAD_PADRAO = Object.freeze({ leadSource: 'FORM' });

module.exports = { ORIGEM_LEAD_PADRAO };
