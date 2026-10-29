# dashboards

Propósito: definições de dashboards e widgets.
Entradas: métricas (`metrics/`) e read models (`read-models/`) pela API pública, nunca tabelas de origem.
Saídas: a composição de cada painel entregue pela API ao Front, que só exibe.

## Painéis com conteúdo (M9-D634 em diante)
`GET /analytics/dashboards/:code?asOf=` devolve numa só resposta a definição publicada e, para cada widget de indicador, o valor pronto (`metric`,
o mesmo objeto de `GET /analytics/metrics/:code`, mais `formatted` em pt-BR e "Dado incompleto" quando o indicador está DEGRADED/INCOMPLETE), o corpo
do desenho (`view`: fatos, séries por natureza, barras, tabela, alerta) e o caminho de detalhe (`drilldown`). A faixa de qualidade é sempre o primeiro widget.
O conteúdo de cada painel mora em `panels/*.panel.js` (dado puro) e é publicado como nova versão da definição global por migration
(`dashboard.seedVersion.js`). Lê só o schema analytics.

## Centro de Comando e Saúde Geral (M9-D685, M9-D686)
- `command_center` (`command/`): seis widgets `COMMAND_BLOCK`, um por pergunta do livro. `command.map.js` é o mapa fechado item -> origem (nenhum item sai fora dele); cada bloco declara
  `config.dependsOn` e, com métrica DEGRADED, INCOMPLETE ou STALE, mostra "Conclusão adiada: dado incompleto" (M9-D697). `commandCenter.service.js` ordena, limita (`analytics.centro.max_itens_por_bloco`),
  conta os itens que o usuário não pode ver e traz o briefing (`getBriefForReader`). `?bloco=CHAVE` mostra um bloco por inteiro ("Ver todos"). Lê só o schema analytics.
- `health` (`health/`): uma linha por área com a cor mais grave entre alertas OPEN, qualidade do dado e `config.trafficLight` de cada KPI; área sem dado é cinza, sem acesso é cinza com "Sem acesso". Os
  limiares vêm dos parâmetros `analytics.semaforo.*` e só valem numa nova versão do painel: `POST /analytics/dashboards/health/thresholds` (analytics:manage) publica a versão da empresa.
