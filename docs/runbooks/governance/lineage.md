# Runbook — Linhagem de dados (adicionar KPI crítico)

Módulo: `src/features/core-governance/lineage`. Rotas sob `$API/data-lineage` (permissão `governance:lineage:manage`). Regra do livro: indicador crítico sem caminho completo (campo de origem, campo de domínio, evento, read model, métrica) reprova o build, sem lista de isenção.

## Sintoma
- O CI falha em `npm run check:lineage` com `GOV_LINEAGE_UNCOVERED`.
- `GET $API/data-lineage` mostra `cobertura.uncovered` maior que zero.
- Um novo KPI do BI foi criado e não aparece na linhagem.

## Causa provável
1. O KPI novo não trouxe a semente de linhagem em `src/features/core-governance/lineage/seeds/*.seed.js`.
2. A semente existe, mas o arquivo `docs/governance/lineage-registry.json` não foi regenerado.
3. Nó sem responsável ou sem descrição, ou camada pulada.

## Passo a passo
1. Ver o que falta e em qual área:
   ```bash
   npm run check:lineage
   ```
2. Adicionar a semente do KPI (um nó por camada, na ordem origem, domínio, evento, read model, métrica, com `owner_domain`, `description` e `area`) no arquivo `seeds/<dominio>.seed.js` do domínio dono do indicador. Nunca criar arquivo ou gerador próprio.
3. Regenerar o registro versionado (somente em banco descartável, o script recusa o resto):
   ```bash
   npm run sync:lineage
   npm run sync:lineage -- --check
   ```
4. Rodar os testes do portão e das regras:
   ```bash
   NODE_ENV=test node --test test/marco9/governanca/m9d811.gate.test.js test/marco9/governanca/m9d811.ci.test.js
   ```
5. Em ambiente publicado, a empresa aplica a semente na primeira leitura de `GET $API/data-lineage`.

## Como confirmar
- `npm run check:lineage` termina com `covered=N/N percent=100 uncovered=[]` e exit 0.
- `npm run sync:lineage -- --check` não mostra diferenças.
- O teste nomeado `m9d811 KPI sem lineage crítico falha gate` continua verde.

## Quem escalar
O dono do KPI (domínio de BI) para descrever origem e métrica; o time de plataforma para falha do gerador.
