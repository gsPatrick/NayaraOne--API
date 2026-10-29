'use strict';

// M9-D651 — textos dos KPIs de atrasos, medições e não conformidades das obras (os 15 campos do livro, M9-D603): descrição, fórmula em palavras e regra de qualidade.
const { buildDefinitions } = require('./definitions.build');

const TEXT = {
  'obra.delays': {
    description: 'Onde as obras estão atrasadas: etapas atrasadas, dias máximo e médio de atraso e obras com pelo menos uma etapa atrasada.',
    formulaSemantic: 'Etapa atrasada = fim previsto (baseline vigente) < hoje e progresso < 100% e etapa não concluída; dias de atraso = diferença em dias de calendário de São Paulo entre hoje e o fim previsto; KPI = número de etapas atrasadas, dias máximo e médio (1 casa) e obras com pelo menos uma etapa atrasada.',
    qualityRule: { requiredFields: ['stages_without_date'], allowNull: false, incompleteWhen: 'etapa sem data prevista' },
  },
  'obra.measurements': {
    description: 'Quanto já foi medido nas obras, quanto foi aprovado para pagamento e quanto aguarda aprovação, com a idade da medição pendente mais antiga.',
    formulaSemantic: 'Σ valor medido (medições enviadas em diante), Σ valor aprovado, Σ valor pendente de aprovação = medido − aprovado; idade, em dias, da medição pendente mais antiga. Posição no fim do dia-base.',
    qualityRule: { requiredFields: ['approved_without_payment'], allowNull: false, degradedWhen: 'medição aprovada sem lançamento de pagamento previsto' },
  },
  'obra.nonconformities': {
    description: 'Desvios de qualidade das obras: abertas na data-base, abertas e fechadas no período de 30 dias e tempo médio para fechar.',
    formulaSemantic: 'Abertas na data-base, abertas (criadas) no período, fechadas no período e tempo médio para fechar em dias (1 casa); causa e equipe sem informação entram como NAO_INFORMADA; acima de analytics.qualidade.max_sem_causa_pct sem causa o indicador fica DEGRADED.',
    qualityRule: { requiredFields: ['cause_code'], allowNull: false, degradedWhen: 'causa não informada acima do limite' },
  },
};

module.exports = { DEFINITIONS: buildDefinitions(TEXT) };
