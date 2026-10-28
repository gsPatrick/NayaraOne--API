# metrics

Propósito: registry de métricas, fórmulas puras, período, freshness e sourceRefs. Nenhum cálculo de KPI mora no Front.
Entradas: definições e versões de métrica (M9-D600/D603), valores lidos dos read models pela API pública.
Saídas: valor, status e fonte de cada métrica. `metrics/formulas/*` é puro: não importa nada fora de `metrics/`.
