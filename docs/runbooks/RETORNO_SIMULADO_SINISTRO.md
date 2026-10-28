# Retorno simulado do sinistro (seguradora de teste) e conferência no Financeiro

Serve para a conferência do Marco 7: provar que o retorno da seguradora fecha o sinistro e integra o Financeiro, **sem nenhuma operação real**. Só vale com o provider de seguro `sandbox` e fora de produção (`INSURANCE_SANDBOX_FORBIDDEN_IN_PRODUCTION` recusa em produção).

## Pré-requisitos
1. Provider de seguro da empresa em `sandbox` (configuração `procurement.insurance_provider`; o padrão já é `sandbox`).
2. Um segredo de teste para o webhook gravado na empresa (configuração `procurement.insurance_webhook_secret`, guardada cifrada). Quem tem `settings:update` grava: `PUT /v1/settings/procurement.insurance_webhook_secret` com `{ "value": "<segredo de teste>" }`. O mesmo segredo é passado ao script pela variável `INSURANCE_WEBHOOK_SECRET` (nunca por argumento).
3. Uma apólice emitida (Compras › Seguros) e dois usuários: quem abre o sinistro (`procurement:create`) e quem submete (`procurement:approve`).

## Passo a passo
1. **Abrir o sinistro:** Compras › Seguros › apólice › "Abrir sinistro", com descrição e valor (ex.: R$ 1.500,00). Esperado: status `OPEN`, evento `OPENED`. Um segundo sinistro ativo igual na mesma apólice é recusado (`INSURANCE_CLAIM_DUPLICATE`).
2. **Submeter à seguradora (o aprovador):** "Submeter". Esperado: status `SUBMITTED`, evento `SUBMITTED`, id externo `sandbox-claim-insurance-claim:<id do sinistro>`. Ainda não há lançamento no Financeiro (só a liquidação cria).
3. **Enviar o retorno simulado** (no servidor ou na máquina de quem confere, com o segredo de teste):
   ```
   INSURANCE_WEBHOOK_SECRET='<segredo de teste>' node scripts/simularRetornoSinistro.js \
     --url https://<host-da-api>/api --claim-id <id do sinistro> --status SETTLED --amount 1500.00
   ```
   Esperado: `HTTP 200` com `{"received":true,"processed":true}`.
4. **Conferir os efeitos** (tudo na empresa do sinistro):
   - Sinistro: status `SETTLED`, valor liquidado = 1500,00, evento `SETTLED` ("Lançamento <id> criado").
   - Financeiro › Lançamentos: um lançamento **a receber (crédito)** de R$ 1.500,00, "Indenização de sinistro de seguro — apólice <número>", no centro de resultado "Indenizações de seguro" (código `SEGUROS-INDENIZACOES`), vencimento na data do retorno.
   - Auditoria: ação `procurement.insurance_claim.settle` com o estado antes (`SUBMITTED`) e depois (`SETTLED`).

## Cenários de recusa e de proteção (cada um com o efeito esperado)
| Cenário | Como | Esperado |
|---|---|---|
| Retorno repetido | rodar o passo 3 de novo para o mesmo sinistro | `HTTP 200`, sem novo lançamento (o sinistro já saiu de `SUBMITTED`) |
| Assinatura errada | acrescentar `--assinatura-errada` | `HTTP 401` `INSURANCE_WEBHOOK_HMAC_INVALID`, nada muda |
| Seguradora recusa | `--status REJECTED` em outro sinistro submetido | sinistro `REJECTED`, evento `REJECTED`, **nenhum** lançamento no Financeiro |
| Valor acima do sinistro | `--amount 9999.00` num sinistro de 1.500,00 | lançado só R$ 1.500,00; a nota do evento registra "Seguradora informou 9999.00; lançado 1500.00 (limitado ao valor do sinistro). A diferença exige conferência manual." |
| Sinistro desconhecido | `--external-id sandbox-claim-insurance-claim:00000000-0000-0000-0000-000000000000` | `HTTP 200` `{"received":true,"processed":false,"reason":"unknown_routing"}` |

## Observações
- O script não grava nada sozinho: ele só faz a chamada HTTP que a seguradora faria. Todo o efeito vem das regras do próprio sistema.
- Os registros fictícios criados aqui ficam preservados, como a Nayara pediu.
- Teste do script: `node --test test/simularRetornoSinistro.test.js` (a assinatura do script é a que o webhook valida).
