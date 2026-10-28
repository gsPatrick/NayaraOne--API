# read-models

Propósito: worker, rebuild e um arquivo `*.readmodel.js` por read model. É a ÚNICA camada que lê os schemas de origem (somente leitura, M9-D612).
Entradas: eventos e tabelas de origem das áreas (Financeiro, CRM, Obras e demais).
Saídas: linhas dos read models do schema `analytics` e registros de refresh, consumidos por `metrics/`, `dashboards/` e `briefs/`.
