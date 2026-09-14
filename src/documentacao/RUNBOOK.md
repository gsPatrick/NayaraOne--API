# Runbook operacional — Nayara One API

Documento vivo (TEC-13/TEC-23): como investigar e responder aos incidentes mais prováveis
deste sistema. Escrito para quem tem acesso ao Easypanel e ao banco, mas não necessariamente
ao código-fonte na ponta dos dedos.

## Owner

Responsável técnico atual: Patrick Gomes Siqueira. Sem plantão formal / SLA de resposta
definido neste estágio do contrato — a definir junto com a contratante se/quando fizer sentido.

## Onde olhar primeiro

- **Logs**: Easypanel captura a saída do container (stdout/stderr) automaticamente. Desde
  10/09/2026 os logs são JSON estruturado (um objeto por linha) — cada linha tem `level`,
  `time`, `correlationId` (quando aplicável), `msg`. Para achar tudo que uma requisição
  específica disparou, procure pelo `correlationId` dela (vem no header de resposta
  `X-Correlation-Id` de toda chamada à API).
- **`GET /health`**: status geral do processo + conectividade com o banco (`database: "up"` ou
  `"down"`). Responde em até 4 segundos sempre, mesmo com o banco fora do ar — nunca fica
  pendurado.
- **`GET /v1/health/db`**: mesma ideia, mas com status HTTP 503 quando o banco não responde
  (útil para healthcheck de orquestrador que espera código de erro, não só um campo no JSON).
- **`GET /api/metrics`**: métricas em formato Prometheus — quantidade/latência de requisições
  por rota, e o tamanho da fila de eventos pendentes/mortos do Outbox
  (`nayaraone_api_outbox_pending_events`, `nayaraone_api_outbox_dead_letter_events`). Funciona
  via `curl` direto, sem precisar de nenhum coletor configurado.

## Cenários comuns

### "O sistema está lento / não responde"
1. `curl <url-da-api>/api/health` — se `database: "down"`, o problema é o banco (ver seção
   abaixo). Se `database: "up"` mas a resposta demorou, o problema é outro (carga, rede).
2. `curl <url-da-api>/api/metrics | grep http_request_duration` — compare com valores normais
   de referência anotados no dia do teste de carga (09/09/2026): p50 ~300ms pra rotas simples,
   ~1.8s pra rotas com várias tabelas relacionadas (ex.: listagem de Contatos).

### "Um evento (webhook, notificação) não chegou"
1. Todo evento de domínio passa por "integration"."outbox_events" antes de ser efetivamente
   despachado. Um job interno (`outboxDispatcherJob.js`) roda a cada 30 segundos e processa o
   que estiver `PENDING`.
2. Se `nayaraone_api_outbox_dead_letter_events` (em `/api/metrics`) estiver maior que zero,
   existem eventos que falharam 5 vezes seguidas e pararam de tentar — busque na tabela
   `deadLetterReason` pra entender o motivo.
3. **Atenção**: hoje `publishToBroker` (em `src/engines/events/outbox-dispatcher.js`) só
   *loga* o evento — não existe integração real com um broker externo. Não é bug: é uma
   decisão de design documentada (ver comentário no próprio arquivo) até haver um consumidor
   real definido.

### "Banco caiu / inacessível"
- Confirmado por teste real (drill de 10/09/2026): a API não trava nem derruba o processo —
  `/health` continua respondendo normalmente com `database: "down"`, e qualquer rota que
  dependa do banco retorna erro claro (não trava a requisição do cliente indefinidamente).
- Não existe hoje replicação/failover automático de banco — é uma única instância Postgres.
  Restauração de backup é procedimento manual (não coberto por automação neste momento —
  ver pendência TEC-16/TEC-17 nos documentos de homologação).

### "Preciso saber quem fez o quê"
- Toda mutação relevante do sistema grava uma linha em `"audit"."audit_log"` — visível na tela
  Atividades do painel administrativo. Desde 10/09/2026, cada linha carrega o `correlationId`
  da requisição que a originou, permitindo cruzar com os logs do container pra reconstruir a
  cadeia completa (requisição HTTP → auditoria → evento de domínio).

## O que ainda depende de decisão/infraestrutura da contratante

- **Coletor de métricas/logs** (Grafana, Better Stack, Datadog etc.): `/api/metrics` já expõe
  no formato padrão, mas nada coleta/armazena histórico nem dispara alerta hoje — é decisão
  de custo/fornecedor, não algo resolvido só com código.
- **Backup automático e restore testado** (TEC-16/TEC-17): depende de provisionar isso no
  Postgres gerenciado (o Easypanel pode ou não já oferecer isso conforme o plano contratado —
  checar direto com o Easypanel).
- ~~Usuário de banco com privilégio mínimo (TEC-03/04)~~ — **resolvido em 14/09/2026**. Criado
  o role `nayara_runtime` (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`), com grants
  explícitos de SELECT/INSERT/UPDATE/DELETE nos 11 schemas da aplicação e `ALTER DEFAULT
  PRIVILEGES` para que migrations futuras já herdem o grant automaticamente. Confirmado ao
  vivo: `SELECT` com `app.company_id` falso retorna 0 linhas (antes retornava dados reais).
  A troca revelou e corrigiu dois bugs reais de RLS que estavam mascarados pelo superusuário
  (checagem de sessão do ADV-12 e revogação de sessão do TEC-12, ambas rodavam sem contexto de
  tenant) — suite completa (86/86) revalidada contra o usuário novo. **Pendente**: atualizar a
  variável `DATABASE_URL` no ambiente do Easypanel com a credencial nova (fora do meu acesso
  direto à plataforma).
