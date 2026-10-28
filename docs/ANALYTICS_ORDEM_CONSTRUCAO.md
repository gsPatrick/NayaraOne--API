# Ordem exata de construção do BI (Guia §1, M9-D613)

Código em `src/modules/analytics/{metrics,read-models,dashboards,alerts,quality,exports,briefs}`; rotas em `/v1/analytics`.
Cada passo só vale com o teste da demanda verde e verificada; a demanda de um passo não pode estar `verificada` antes das dos passos anteriores
(teste `m9d613 ordem exata dos 11 passos respeitada pelas demandas`; lista em `scripts/lib/analyticsBuildOrder.js`).

- [ ] 1. metric registry: M9-D603
- [ ] 2. read models por domínio: M9-D607
- [ ] 3. snapshots e freshness: M9-D609
- [ ] 4. dashboard Financeiro: M9-D626
- [ ] 5. dashboards CRM e Obras: M9-D634, M9-D653
- [ ] 6. alert engine: M9-D691
- [ ] 7. drill-down: M9-D690
- [ ] 8. data quality: M9-D696
- [ ] 9. NAY briefs: M9-D693
- [ ] 10. exports: M9-D701
- [ ] 11. carga, rebuild e segurança: M9-D699, M9-D608, M9-D700

## Regras de dependência (lint `nayara/analytics-camadas`)
- `metrics/formulas/*` não importa nada fora de `metrics/` (nem models, nem sequelize, nem pg).
- `dashboards/` e `briefs/` não importam models, sequelize nem serviços de outros módulos; consomem `metrics/` e `read-models/` só pelo `index.js`.
- `read-models/` é a única camada que lê os schemas de origem, somente leitura (M9-D612).
