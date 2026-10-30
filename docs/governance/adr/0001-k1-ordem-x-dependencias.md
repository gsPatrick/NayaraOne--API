# ADR 0001 — K1 ordem x dependências

## Contexto
A auditoria cega da parte 3 do bloco de governança apontou a contradição K1 (ordem x dependências) entre o livro e/ou entre as demandas. Demandas afetadas: todas.

## Decisão
O Guia §1 manda 10 passos em ordem. A primeira demanda de cada passo depende das últimas do passo anterior (tabela em D800 §3.5): D801→D803→D802→D804→D807→D805→D806→D808→D810→D811→D820→D821→{D822,D823,D824,D825}→D830→D831→D834→D832→D833→D840→{D841,D842,D843}→D844→D850→{D851,D852}→D860→{D861,D862}→D863→D870→{D871,D872}→D890→D891→D809. Bloco F depende de E (D906 depende de D891). D890 depende de todas as donas de teste adversarial. Dentro do passo 2 a ordem é D804, D807, D805, D806, D808 porque D805 usa o guard de D807

## Alternativas
Deixar a ordem do Guia §1 só como recomendação de leitura, sem o campo Dependências. Rejeitada: a ordem não seria imposta e uma demanda poderia ser verificada antes das que a sustentam.

## Consequências
A ordem é imposta pelo campo Dependências; D890 depende de todas as donas de teste adversarial e D809 fecha por último.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
