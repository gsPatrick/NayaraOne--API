# Runbook — Banco fora do ar / pagamento incerto / estorno

Auditoria externa (contrato bruto, Anexo I, Centro Financeiro §8 "Fluxo de pagamento", item 8:
"Integração bancária retorna estado; sistema nunca presume sucesso." — e teste citado
FIN-TS-018 "Banco timeout | Execução sem confirmação | Não cria sucesso falso"). Este documento
é o procedimento OPERACIONAL para quem está de olho no financeiro (não precisa ler código) nos
três cenários mais prováveis de falha na integração bancária.

## Garantia de código (confirmada por teste automatizado)

`submitPaymentIntentToBank` (`src/features/finance/bankPayments.service.js`) NUNCA chama
`settleFinancialEntry` — só `confirmBankPayment` faz isso, e só quando o status reportado pelo
adapter/webhook é literalmente `'CONFIRMED'`. Qualquer outro valor (`'TIMEOUT'`, `'FAILED'`,
`'REJECTED'`, ausência de resposta) cai no branch `else`: o `PaymentIntent` vai para `FAILED`
e **nenhum ledger é criado, nenhum `FinancialEntry` é liquidado**. Isso é exercitado pelo teste
automatizado `FIN-TS-018 banco timeout — execução sem confirmação não cria sucesso falso` em
`test/marco4.contract.gaps.test.js`.

## Cenário 1 — "O banco está fora do ar" (timeout de rede, 5xx do provedor)

**Sintoma**: `submitPaymentIntentToBank` lança erro, ou o adapter nunca retorna um
`externalStatus` dentro do prazo esperado.

**O que o sistema garante**: nenhum `PaymentIntent` sai de `SUBMITTED` sem uma confirmação
explícita. Nenhum dinheiro "sai" logicamente do sistema (ledger/`FinancialEntry.SETTLED`) só
porque a chamada ao banco foi disparada.

**Procedimento**:
1. Verifique `GET /v1/health` e `GET /api/metrics` (ver `src/documentacao/RUNBOOK.md`) para
   confirmar se é o nosso lado ou o do provedor.
2. Liste os `PaymentIntent` com `status = 'SUBMITTED'` há mais tempo que o esperado (SLA do
   provedor configurado) — são candidatos a "pagamento incerto" (Cenário 2).
3. Não reenvie (`submitPaymentIntentToBank`) o mesmo intent "só para garantir" — o
   `idempotencyKey` (`payment-intent:${intent.id}`) já impede duplicidade no adapter, mas
   reenviar sem necessidade aumenta o risco de confusão operacional. Espere o prazo de SLA do
   provedor, depois trate como Cenário 2.

## Cenário 2 — "Pagamento incerto" (submetido, sem confirmação, prazo do provedor esgotado)

**Sintoma**: `PaymentIntent.status === 'SUBMITTED'` por mais tempo que o SLA do provedor
configurado, sem webhook de confirmação (`confirmBankPayment`) nem de falha ter chegado.

**O que o sistema garante**: enquanto não houver confirmação, o `FinancialEntry` de origem
continua `PENDING`/`PARTIALLY_SETTLED` — nunca é tratado como pago. Não existe liquidação
"otimista".

**Procedimento**:
1. Consulte o status real do pagamento DIRETAMENTE no painel do provedor bancário (fora deste
   sistema) usando o `externalSubmissionId` gravado em
   `finance.bank_payment_provider_routing` (tabela de roteamento usada pelo webhook).
2. **Se o provedor confirma que o pagamento foi efetivado** (saiu do nosso lado, chegou no
   destino): force a reconciliação chamando `confirmBankPayment(externalSubmissionId,
   'CONFIRMED', transaction)` manualmente (via console administrativo/suporte, nunca direto no
   banco) — isso cria o ledger com rastreabilidade. **Nunca** marque o `FinancialEntry` como
   `SETTLED` por fora desse fluxo (ex.: UPDATE manual no banco) — perde toda a auditoria.
3. **Se o provedor confirma que o pagamento NÃO foi efetivado** (falhou/caiu): chame
   `confirmBankPayment(externalSubmissionId, 'FAILED', transaction)` (ou o status real
   retornado) — o `PaymentIntent` vai para `FAILED` e o `FinancialEntry` original permanece
   disponível para nova tentativa de pagamento (`submitPaymentIntentToBank` de novo, com um
   `idempotencyKey` novo se for um novo `PaymentIntent`).
4. **Se o provedor também não sabe informar** (caso raro, mas real): documente o caso como
   pendência manual — NÃO adivinhe. É preferível um pagamento "congelado" em `SUBMITTED` por
   mais tempo do que arriscar duplicidade ou perda de registro. Escale para o responsável
   técnico (ver `src/documentacao/RUNBOOK.md`, seção Owner).

## Cenário 3 — "Estorno" (pagamento confirmado que precisa ser desfeito/corrigido)

**Sintoma**: um `FinancialEntry` já `SETTLED` (ledger real criado) precisa ser revertido —
erro de valor, beneficiário errado identificado depois do fato, devolução, etc.

**O que o sistema garante** (FIN-010 "Estorno não apaga" — Centro Financeiro §2): o lançamento
original NUNCA é apagado nem editado. `reverseFinancialEntry`
(`src/features/finance/financialEntries.service.js`) marca o original como `REVERSED` e cria um
**novo** lançamento compensatório (`entryType` invertido, mesmo valor, `reversalOfEntryId`
apontando para o original). O histórico completo (original + reversão) permanece consultável
para sempre.

**Procedimento**:
1. Nunca tente "desfazer" um pagamento editando o valor do `FinancialEntry` original ou
   apagando linhas — está bloqueado pela invariante de ledger imutável, e mesmo que não
   estivesse, destruiria a trilha de auditoria.
2. Chame `reverseFinancialEntry(id, motivoDocumentado, actorUserId, transaction)` — o motivo é
   obrigatório e vai para `audit.audit_log`.
3. Se o estorno for de um pagamento que já tinha comissão associada e paga, ver também o
   procedimento de **ajuste de comissão por cancelamento**
   (`cancelCommission`/`adjustCommissionForCancellation` em
   `src/features/finance/commissions.service.js`) — mesma lógica de "ajuste, nunca apaga
   histórico".
4. Se o estorno envolveu movimentação bancária real (dinheiro já saiu/chegou fisicamente),
   confirme a devolução/compensação com o provedor bancário ANTES de considerar o caso
   encerrado — o estorno no sistema é o registro contábil, não a movimentação bancária real em
   si.

## Sinalizadores de alerta (para identificar os cenários acima proativamente)

`checkFrequentReversalAlert`/`checkRecurringManualReconciliationAlert`
(`src/features/finance/financeAntifraud.service.js`) contam, por empresa, estornos e
conciliações manuais recorrentes nos últimos 30 dias — um volume alto de qualquer um dos dois é
sinal de que vale revisar os cenários acima com mais atenção (ex.: provedor instável gerando
muitos pagamentos incertos tratados via estorno manual).
