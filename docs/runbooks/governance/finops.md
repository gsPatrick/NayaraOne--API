# Runbook — FinOps (coletor com falha, fatura que não importou)

Módulo: `src/features/core-governance/finops`. Rotas sob `$API/finops` (`governance:finops:read` e `:manage`). Estimado e faturado são séries separadas e nunca somadas; PROD nunca é desligado por custo.

Convenções: `$API` e `$TOKEN` como em `calendario.md`. Comandos `node -e` só no servidor do ambiente.

## Sintoma
- No `GET $API/finops/health` um coletor aparece `STALE` (sem dado novo) ou `dadoIncompleto` num domínio.
- A fatura da nuvem ou do provedor não aparece como `BILLED` no mês fechado.
- O orçamento não dispara o aviso esperado, ou dispara de novo.

## Causa provável
1. O job `finopsCollectJob` foi desligado no processo (`FINOPS_COLLECT_JOB_DISABLED=true`) ou falhou numa empresa (log `finopsCollectJob.company.failed`).
2. Fatura inválida (colunas, período, valores) ou de período ainda aberto (`GOV_FINOPS_PERIOD_OPEN`): a importação não grava nada.
3. Preços fora do dicionário `governanca.finops.precos`.

## Passo a passo
1. Ver o estado dos coletores e dos orçamentos:
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$API/finops/health"
   curl -s -H "Authorization: Bearer $TOKEN" "$API/finops/budgets"
   ```
2. Rodar a coleta na hora (fecha as horas encerradas e mede o armazenamento do dia anterior com `force`; idempotente, uma linha por hora):
   ```bash
   node -e "require('./src/engines/jobs/finopsCollectJob').runFinopsCollectJob(new Date(), { force: true }).then((r) => { console.log(JSON.stringify(r)); process.exit(0); })"
   ```
3. Fatura que não importou: conferir o período (deve estar encerrado) e o formato (CSV ou JSON). A importação é atômica e idempotente: a mesma fatura duas vezes não duplica (chave `fatura#linha`); crédito entra como `CREDIT` negativo. Corrigido o arquivo, reexecutar o passo 2 com a fonte da fatura.
4. Reexecutar os detectores de desperdício (somente leitura) e a degradação por custo:
   ```bash
   node -e "require('./src/engines/jobs/finopsDetectorsJob').runAllDetectorJobs(new Date(), { force: true }).then(() => process.exit(0))"
   node -e "require('./src/engines/jobs/finopsDegradationJob').runDegradationJob(new Date(), { force: true }).then(() => process.exit(0))"
   ```
   Os cinco detectores rodam juntos (README do módulo); a política de degradação só liga e desliga funções (nunca infraestrutura de PROD: 403 `GOV_FINOPS_PROD_PROTECTED`).
5. Ajustar limiares e preços em Configurações > Governança (chaves `governanca.finops.*`), nunca no código.

## Como confirmar
- `GET $API/finops/health` mostra o coletor `OK` com `lastDataAt` recente e `custos.estimado` e `custos.faturado` separados.
- O mês fechado com fatura mostra o percentual FINAL sobre a série BILLED.
- O teste nomeado `m9d861 FinOps budget alerta sem derrubar PROD` segue verde:
  ```bash
  bash scripts/ci-governanca.sh finops
  ```

## Quem escalar
O dono do orçamento (campo obrigatório) para decisão de custo; o financeiro para fatura divergente; plataforma para coletor com falha repetida.
