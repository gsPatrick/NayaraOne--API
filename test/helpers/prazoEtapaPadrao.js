'use strict';

/**
 * Prazo padrão de etapa de obra para os testes (segunda leva de 16/11/2026, DI-BI2-3: M6:16 "Etapas
 * possuem ... prazo", e a API recusa a criação sem `endsAt` com 422 PROJECT_STAGE_END_DATE_REQUIRED).
 *
 * Hoje + 365 dias, ao meio-dia de São Paulo (UTC-03:00, sem horário de verão desde 2019): longe o
 * bastante para não criar atraso nos indicadores e não ficar antes do `startsAt` dos testes.
 * Uso: `{ ..., endsAt: prazoEtapaPadrao() }`. Não é teste.
 */
const DIA_MS = 24 * 60 * 60 * 1000;

function hojeEmSaoPaulo(agora = new Date()) {
  // en-CA formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

function prazoEtapaPadrao(agora = new Date()) {
  const base = new Date(`${hojeEmSaoPaulo(agora)}T12:00:00-03:00`);
  return new Date(base.getTime() + 365 * DIA_MS).toISOString();
}

module.exports = { prazoEtapaPadrao, hojeEmSaoPaulo };
