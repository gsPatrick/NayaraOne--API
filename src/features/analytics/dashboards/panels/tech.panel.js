'use strict';

/**
 * M9-D682 (3.1 e 3.2) — conteúdo do painel Segurança/Integrações/IA (`tech`): a faixa de qualidade e os 11 indicadores técnicos, na ordem do livro (disponibilidade e freshness; filas e
 * integrações; falhas de autenticação e eventos bloqueados; custo e orçamento da IA; qualidade; chamadas de ferramenta bloqueadas). Dado puro: o mesmo texto alimenta a migration que
 * publica a próxima versão do painel e os testes. `config` só descreve como desenhar (`group` = prefixo das dimensões que formam as linhas, `measures` = colunas, `facts` = fatos do
 * cartão, `alertOn` = chave que acende o alerta); nenhuma fórmula. O quadro de integrações (`idParts`, `partGroups`) mostra, por fornecedor, ambiente e família, os 9 valores de saúde das
 * 8 métricas de integração do livro (sucesso, latência p95 e p99, limite de taxa, falhas de autenticação, tentativas, DLQ, fila e cota), separado nas 14 famílias do catálogo (M9-D201).
 */
const { QUALITY_BANNER, table } = require('./common');
const { INTEGRATION_FAMILIES } = require('./integrationFamilies');

const BOARD_MEASURES = Object.freeze([
  { key: 'sucesso_pct', label: 'Sucesso' }, { key: 'latencia_p95_ms', label: 'Latência p95' }, { key: 'latencia_p99_ms', label: 'Latência p99' }, { key: 'limite_taxa_qtd', label: 'Limite de taxa' },
  { key: 'falhas_auth_qtd', label: 'Falhas de autenticação' }, { key: 'tentativas_qtd', label: 'Tentativas' }, { key: 'dlq_qtd', label: 'DLQ' }, { key: 'fila_qtd', label: 'Fila' }, { key: 'cota_qtd', label: 'Cota restante' },
]);

const TECH_PANEL = Object.freeze({
  code: 'tech',
  widgets: [
    QUALITY_BANNER,
    table('tec.availability', 'Disponibilidade', {
      group: 'sonda', order: 'ID', measures: [{ key: 'disponibilidade_pct', label: 'Disponibilidade' }, { key: 'ausentes_qtd', label: 'Sondas ausentes' }],
      facts: [{ key: 'minutos_fora_do_ar', label: 'Minutos fora do ar', unit: 'MINUTES' }],
    }),
    table('tec.freshness', 'Freshness dos dados do BI', {
      group: 'rm', order: 'VALUE_DESC', measures: [{ key: 'idade_min', label: 'Idade' }],
      facts: [{ key: 'stale_qtd', label: 'Desatualizados' }, { key: 'expirado_qtd', label: 'Expirados' }, { key: 'pior_idade_min', label: 'Pior idade' }],
    }),
    table('tec.queues_dlq', 'Filas e DLQ', {
      group: 'fila', order: 'ID', measures: [{ key: 'profundidade_qtd', label: 'Aguardando' }, { key: 'dlq_qtd', label: 'DLQ' }, { key: 'mais_antigo_s', label: 'Mais antigo' }],
      facts: [{ key: 'dlq_qtd', label: 'Total na DLQ' }, { key: 'mais_antigo_s', label: 'Item mais antigo' }],
    }),
    table('tec.integration_errors', 'Integrações com erro', {
      group: 'quadro', order: 'ID', alertOn: 'acima_do_slo_qtd', idParts: ['Fornecedor', 'Ambiente', 'Família'], partGroupAt: 2, partGroups: INTEGRATION_FAMILIES, measures: BOARD_MEASURES,
      facts: [{ key: 'acima_do_slo_qtd', label: 'Fornecedores acima do limite de erro' }],
    }),
    table('tec.auth_failures', 'Falhas de autenticação', {
      group: 'tipo', order: 'VALUE_DESC', measures: [{ key: 'falhas_qtd', label: 'Falhas' }, { key: 'atores_distintos_qtd', label: 'Pessoas distintas' }], facts: [{ key: 'pico_hora_max', label: 'Maior pico em uma hora' }],
    }),
    table('tec.blocked_events', 'Eventos bloqueados', {
      group: 'motivo', order: 'VALUE_DESC', measures: [{ key: 'bloqueados_qtd', label: 'Bloqueados' }], facts: [{ key: 'outro_qtd', label: 'Outros motivos' }],
    }),
    table('ai.cost_by_agent', 'Custo de IA por agente', {
      group: 'agente', order: 'VALUE_DESC', measures: [{ key: '', label: 'Custo' }, { key: 'execucoes_qtd', label: 'Execuções' }, { key: 'custo_por_execucao_brl', label: 'Custo por execução' }],
    }),
    table('ai.budget', 'Budget de IA', {
      group: 'agente', order: 'VALUE_DESC', alertOn: 'acima_do_alerta_qtd', measures: [{ key: '', label: 'Consumo' }, { key: 'custo_brl', label: 'Custo' }, { key: 'orcamento_brl', label: 'Orçamento' }, { key: 'projecao_brl', label: 'Projeção do mês' }],
      facts: [{ key: 'acima_do_alerta_qtd', label: 'Agentes acima do alerta' }],
    }),
    table('ai.quality_scores', 'Grounding e evaluation score', {
      group: 'agente', order: 'VALUE_DESC', measures: [{ key: '', label: 'Grounding' }, { key: 'avaliacao_nota', label: 'Avaliação' }, { key: 'bloqueadas_grounding_qtd', label: 'Bloqueadas por grounding' }],
      facts: [{ key: 'avaliacao_nota', label: 'Avaliação média' }, { key: 'bloqueadas_grounding_qtd', label: 'Respostas bloqueadas por grounding' }],
    }),
    table('ai.tool_calls_blocked', 'Tool calls bloqueadas', {
      group: 'ferramenta', order: 'VALUE_DESC', measures: [{ key: '', label: 'Bloqueadas' }, { key: 'chamadas_qtd', label: 'Chamadas' }, { key: 'bloqueadas_pct', label: 'Bloqueadas (%)' }],
      facts: [{ key: 'chamadas_qtd', label: 'Chamadas no mês' }, { key: 'bloqueadas_pct', label: 'Bloqueadas (%)' }],
    }),
  ],
});

module.exports = { TECH_PANEL };
