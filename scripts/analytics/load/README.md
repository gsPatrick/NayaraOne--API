# Teste de carga do BI (M9-D699)

Prova que um painel pesado não degrada o fluxo operacional (OLTP) e que o rebuild de um read model conclui sob carga reproduzindo o hash.

- `../seedLoad.js`: massa determinística por semente (várias empresas, 24 meses de histórico, lançamentos, transações bancárias, oportunidades, imóveis e eventos de obra). Mesma semente, âncora e tamanhos dão o mesmo digest. Tamanhos em `seed.sizes.js` (`light` no teste automatizado, `full` no pipeline LAB).
- `../loadTest.js`: orquestra as fases. Linha de base do fluxo operacional (com carga neutra de HTTP, sem consulta ao banco, para a máquina estar igualmente ocupada), o mesmo fluxo com usuários abrindo os 13 painéis, lendo os indicadores e alternando drill-down, e o rebuild de `rm_finance_health` no meio da janela. Rodadas alternadas (base, BI, base, BI).
- `biWorker.js`: processo filho com o router real de `/analytics` e os usuários do BI. `phases.js`: janela de medição. `oltpOps.js`: criar lançamento, liquidar, mover oportunidade e apontar relatório de obra, com o RLS do role de runtime. `verdict.js`: critérios. `report.js`: relatório JSON.
- Critérios: p95 de cada operação com BI <= linha de base x (1 + `analytics.carga.degradacao_max_pct`/100) (padrão 10, aba "BI e Centro de Comando"); ou excesso de no máximo `analytics.carga.tolerancia_absoluta_ms` ms (padrão 2; operação de poucos ms oscila mais que 10% só por ruído); p95 de cada painel <= `dashboard_definitions.p95_target_ms`; rebuild com o mesmo hash; nenhuma falha inesperada. Reprovou: código de saída 1 e o relatório aponta o painel ou a consulta responsável.

```
npm run load-test:analytics -- --scale full --duration-sec 20 --rounds 2 --json carga-bi.json
```

Só roda em banco descartável em 127.0.0.1 (`scripts/withDisposableDb.js`); recusa qualquer outro destino. Sem dado real, sem segredo no relatório.
