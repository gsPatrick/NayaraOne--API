# Ordem de implementação e sprints das integrações (M9-D255)

Arquivo GERADO por `node scripts/integrationSprintGate.js --gerar-doc` a partir da tabela da demanda M9-D255. Não edite à mão: o teste `sprints_documento_atualizado` compara.

## Passos do livro para demandas

| Passo | Conteúdo | Demandas |
|---|---|---|
| 1 | provider registry/connections | D200, D201 |
| 2 | secret references | D202 |
| 3 | generic dispatch/inbox | D203, D204, D205, D209, D210, D214, D215, D219, D220 |
| 4 | retry/circuit breaker | D216, D217, D218 |
| 5 | health/metrics | D206, D207, D223, D224, D225 |
| 6 | primeiro adapter sandbox | D229, D222 |
| 7 | webhook framework | D211, D212, D213 |
| 8 | WhatsApp/site/portal | D229, D230, D231, D232, D233, D259 |
| 9 | assinatura/bancos/seguros | D236, D237, D238 |
| 10 | demais providers | D234, D235, D239, D240, D241, D242, D243 |
| 11 | contingency/failure drills | D226, D227, D228, D251, D252 |

Transversais de segurança e administração: D244, D245, D246, D247, D248, D249, D250, D253, D254, D256, D257.

## Sprints

| Sprint | Escopo | Demandas (ordem de execução) | Portão de saída |
|---|---|---|---|
| I1 | registry/dispatch/inbox | D200, D201, D202, D203, D204, D205, D208, D209, D210, D219, D214 | tabelas + dispatch + inbox com testes verdes e Correspondente verde |
| I2 | retry/circuit/health | D206, D207, D216, D215, D217, D218, D223, D224, D225 | classes de erro + circuito + health no painel |
| I3 | WhatsApp adapter | D211, D212, D213, D229, D222, D226, D242, D247, D230 | webhook framework + adapter sandbox + suíte de contrato verde no `messaging-sandbox` + framework de contingência + storage/identidade + quarentena |
| I4 | site/portal | D231, D232, D233, D249, D259 | read model + portais sandbox + APIs de leitura |
| I5 | signature | D236 | assinatura com evidência |
| I6 | bank/insurance | D237, D238 | pagamento por evidência + apólice versionada |
| I7 | financing providers | D240 | Correspondente migrado, bateria verde |
| I8 | social/fiscal | D239, D241, D234, D235, D243 | redes, NFS-e, e-mail, storage, identidade, analytics |
| I9 | contingency/security/load | D220, D221, D227, D228, D244, D245, D246, D248, D250, D251, D252, D254, D253, D256, D257, D258 | 15 testes de falha + DoD + failure drill + carga |

## Como conferir

- `node scripts/integrationSprintGate.js` mostra o painel e reprova cobertura quebrada, passo sem demanda e dependência que contraria a ordem.
- `node scripts/integrationSprintGate.js --sprint I3 [--executar]` avalia o portão de saída (demandas verificadas, testes e comandos); `--executar` só em banco descartável.
- `node scripts/withDisposableDb.js -- bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && node scripts/loadTestIntegrations.js"` roda a carga do I9 (volume nos parâmetros `integration.load.*`).
