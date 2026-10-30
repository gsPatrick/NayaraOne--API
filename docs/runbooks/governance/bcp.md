# Runbook — Continuidade operacional (importar lote e reconciliar)

Módulo: `src/features/core-governance/bcp`. Rotas sob `$API/bcp`. Permissões: `governance:bcp:record` (registrar), `governance:bcp:import` (importar), `governance:bcp:approve` (decidir conciliação). Os formulários em papel e o catálogo por setor estão em `docs/runbooks/bcp/*.md`.

Convenções: `$API` e `$TOKEN` como em `calendario.md`.

## Sintoma
- Depois de uma contingência (sistema fora do ar), os registros feitos no papel precisam entrar no sistema.
- A importação devolve itens com erro (`GOV_BCP_PAYLOAD_INVALID`, `GOV_BCP_COMMAND_REJECTED`) ou recusa o setor (`GOV_BCP_SECTOR_FORBIDDEN`).
- Uma conciliação de pagamento ficou pendente além dos dias úteis do parâmetro `governanca.bcp.conciliar_pagamento_dias`.

## Causa provável
1. A operação foi registrada com dados incompletos (fica `RECORDED` com `validation_errors`, por regra o registro nunca é recusado).
2. Quem importa não pertence ao setor do registro.
3. O mesmo registro foi importado duas vezes (a segunda resposta é igual à primeira: não duplica).

## Passo a passo
1. Registrar o que veio do papel (uma operação por vez, com a referência do formulário `<PREFIXO>-<AAAA>-<nnnnn>`):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @operacao.json "$API/bcp/manual-operations"
   ```
2. Corrigir um registro ainda `RECORDED` e conferir a lista do setor:
   ```bash
   curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @correcao.json "$API/bcp/manual-operations/<id>"
   curl -s -H "Authorization: Bearer $TOKEN" "$API/bcp/manual-operations?status=RECORDED&limit=50"
   ```
3. Importar o lote por ids ou pela referência de correlação (idempotente; devolve `items` e `summary`):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"correlationRef":"<referência do lote>"}' "$API/bcp/manual-operations/import"
   ```
4. Reconciliar: listar as pendentes e decidir com nota (`ACCEPT` ou `REVERSE`):
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$API/bcp/reconciliations?pending=true"
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"decision":"ACCEPT","note":"extrato do banco confere"}' "$API/bcp/reconciliations/<id>/decide"
   ```
5. Reimprimir formulários numerados de um setor: `GET $API/bcp/form-templates/<setor>/<formType>/print?from=1&to=50&year=2026`.

## Como confirmar
- O resumo da importação mostra todos os itens como importados; repetir o comando não cria registro novo.
- A conciliação sai da lista de pendentes e a decisão tem nota e usuário; decidir de novo devolve 409 `GOV_BCP_ALREADY_FINAL`.
- O teste nomeado `m9d832 BCP record importado 2x não duplica` segue verde:
  ```bash
  bash scripts/ci-governanca.sh bcp
  ```

## Quem escalar
O responsável do setor dono do formulário; o financeiro para estorno recusado; plataforma para erro técnico com o `traceId`.
