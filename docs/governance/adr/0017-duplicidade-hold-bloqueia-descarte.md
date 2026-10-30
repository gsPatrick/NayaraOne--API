# ADR 0017 — Duplicidade: Hold bloqueia descarte

## Contexto
Mais de uma demanda do bloco de governança descrevia o mesmo assunto (Hold bloqueia descarte).

## Decisão
A dona confirmada é D912. D911 referencia D912 (exceção, dry-run e apply).

## Alternativas
Manter a regra repetida em mais de uma demanda. Rejeitada: duas fontes de verdade divergem com o tempo; a dona única mantém o valor e as demais referenciam.

## Consequências
Há uma só fonte para o valor e para o teste; mudar a regra exige mexer em um lugar.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
