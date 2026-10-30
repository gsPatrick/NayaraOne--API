# Runbook — Dados mestres (fila de duplicidade e alteração em lote)

Módulo: `src/features/core-governance/data-quality`. Rotas sob `$API/data-quality`. Permissões: `governance:data-quality:read`, `:manage` e `:bulk`.

Convenções: `$API` e `$TOKEN` como em `calendario.md`. Comandos `node -e` só no servidor do ambiente; em desenvolvimento, banco descartável.

## Sintoma
- A fila de duplicidades (merge) está parada ou cresce sem decisão.
- Um domínio aparece "sem responsável" ou "sem steward".
- Uma alteração em lote foi recusada (403, 409, 422) ou aplicada em quantidade diferente da prevista.
- A nota de qualidade de um cadastro não reflete uma correção.

## Causa provável
1. Quem decide não é owner nem steward vigente do domínio (PESSOAS, IMOVEIS, FORNECEDORES).
2. O usuário que era steward foi desativado: as designações foram fechadas e o administrador foi avisado.
3. Lote sem `Idempotency-Key`, sem MFA recente, sem `reason` ou acima de `governanca.dados.bulk.max_registros`.
4. A varredura noturna ainda não rodou depois da correção.

## Passo a passo
1. Ver a fila e o impacto da união antes de decidir:
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$API/data-quality/queue?status=OPEN&limit=20"
   curl -s -H "Authorization: Bearer $TOKEN" "$API/data-quality/queue/<id>/impact?survivorId=<id do sobrevivente>"
   ```
2. Decidir o item (MERGED, KEPT_SEPARATE ou DISMISSED), com nota:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"decision":"KEPT_SEPARATE","note":"homônimos, documentos diferentes"}' "$API/data-quality/queue/<id>/decision"
   ```
3. Domínio sem responsável: designar owner e steward (PUT idempotente; quem sai tem a vigência encerrada):
   ```bash
   curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"designations":[{"role":"OWNER","userId":"<uuid>"},{"role":"STEWARD","userId":"<uuid>"}]}' "$API/data-quality/domains/PESSOAS/assignments"
   ```
4. Alteração em lote: simular primeiro (não grava), depois aplicar com chave de idempotência e MFA recente:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"entity_type":"PERSON","filter":{},"patch":{}}' "$API/data-quality/bulk-changes/impact"
   curl -s -H "Authorization: Bearer $TOKEN" "$API/data-quality/bulk-changes?limit=10"
   ```
   O corpo real do POST em `/data-quality/bulk-changes` segue o README do módulo (`entity_type`, `filter`, `patch`, `reason`, `change_evidence` para campo crítico) e exige o cabeçalho `Idempotency-Key`.
5. Rodar a detecção e a varredura fora do horário (servidor do ambiente):
   ```bash
   node -e "require('./src/engines/jobs/dataQualityMergeDetectionJob').runDataQualityMergeDetectionJob(new Date(), { force: true }).then(() => process.exit(0))"
   node -e "require('./src/engines/jobs/dataQualityScanJob').runDataQualityScanJob(new Date(), { force: true }).then(() => process.exit(0))"
   ```

## Como confirmar
- `GET $API/data-quality/domains` mostra owner e steward vigentes e nenhuma pendência.
- `GET $API/data-quality/bulk-changes/<id>` mostra o lote com a contagem igual à da simulação; cada registro tem auditoria `governance.bulk_change.item` com o `bulk_change_id`.
- Uma segunda chamada com a mesma `Idempotency-Key` devolve a resposta original sem aplicar de novo.

## Quem escalar
O owner do domínio afetado e, para decisão de união com impacto financeiro, o financeiro; falha técnica: time de plataforma com o `traceId` e o `bulk_change_id`.
