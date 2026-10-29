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
