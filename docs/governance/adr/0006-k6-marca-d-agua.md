# ADR 0006 — K6 marca d'água

## Contexto
A auditoria cega da parte 3 do bloco de governança apontou a contradição K6 (marca d'água) entre o livro e/ou entre as demandas. Demandas afetadas: D820, D822, D920.

## Decisão
O livro diz opcional: `require_watermark` é campo da política, nunca obrigação do código; padrão ligado só em RESTRICTED, editável; o usuário pode pedir em qualquer saída. D820 é a dona; D822 e D920 só aplicam; PRINT HIGH deixou de exigir marca na matriz

## Alternativas
Marca d'água obrigatória em toda saída. Rejeitada: o livro diz opcional; obrigação rígida fora do livro é proibida pela regra do Patrick.

## Consequências
`require_watermark` é campo da política; padrão ligado só em RESTRICTED e editável; D822 e D920 só aplicam.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
