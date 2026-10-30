# ADR 0018 — Duplicidade: Lineage: estrutura e semente

## Contexto
Mais de uma demanda do bloco de governança descrevia o mesmo assunto (Lineage: estrutura e semente).

## Decisão
A dona confirmada é D810 estrutura, D914 semente MIGRATION. Um arquivo (`lineage-registry.json`) e um gerador (`syncLineageRegistry.js`) em D810; D914 virou seed `migration.seed.js`; a conferência do mapa virou regra 6 do comando de D811.

## Alternativas
Manter a regra repetida em mais de uma demanda. Rejeitada: duas fontes de verdade divergem com o tempo; a dona única mantém o valor e as demais referenciam.

## Consequências
Há uma só fonte para o valor e para o teste; mudar a regra exige mexer em um lugar.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
