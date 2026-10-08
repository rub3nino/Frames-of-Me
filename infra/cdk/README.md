# Frames of Me — stack AWS di riferimento (CDK v2)

Uno stack, `RephotoStack`, in **eu-central-1**. È il modello di deploy descritto in `docs/v2-spec.md` §7: non viene applicato da nessuna pipeline, si applica a mano con `cdk deploy`. Questa cartella non fa parte dei workspace npm del repo: ha il suo `package.json`.

## Cosa crea

- **Rete**: VPC su 2 AZ (subnet pubbliche per l'ALB, private con NAT per i task, isolate per il DB), gateway endpoint S3, interface endpoint per ECR (api + dkr), CloudWatch Logs e Monitoring, Secrets Manager, Rekognition, SES SMTP. Un solo NAT gateway: serve per l'API SESv2 (nessun endpoint) ed è il punto singolo di questa forma.
- **Dati**: RDS PostgreSQL 16 `db.t4g.medium` (single-AZ, gp3 50→200 GB, KMS, backup 7 giorni, deletion protection) con **RDS Proxy** (TLS obbligatorio). Bucket S3 `rephoto-media-<account>-eu-central-1` privato, KMS, CORS per l'origine web, lifecycle: `selfies/` scade dopo 2 giorni, multipart incompleti abortiti dopo 2 giorni.
- **Segreti**: `SESSION_SECRET` generato; `DATABASE_URL` costruito dal segreto RDS e dall'endpoint del proxy (`?sslmode=require`); un header segreto `X-Origin-Verify` che CloudFront aggiunge e l'ALB pretende (senza, `403`).
- **Compute**: cluster ECS Fargate (ARM64, Container Insights) con tre servizi costruiti dai Dockerfile del repo (`ecs.ContainerImage.fromAsset`):
  - `api` (1 vCPU / 2 GB): min 2, max 6, target CPU 60 %;
  - `worker` (2 vCPU / 4 GB): min 1, max 8, step scaling sulla metrica custom `rephoto/QueueDepth` (Maximum, 1 min, nessuna dimensione) che il worker pubblica con `WORKER_PUBLISH_METRICS=true`: −1 sotto 50, +1 da 300, +2 da 1000, +4 da 3000;
  - `web` (0,5 vCPU / 1 GB): min 2, max 4.
- **Ingresso**: ALB (`/v1/*` → api, resto → web) dietro **CloudFront** (cache disabilitata tranne `/_next/static/*`, HTTP/2+3, price class 100). **WAF** regionale associato all'ALB: rate rule 300 richieste / 5 minuti per IP (via `X-Forwarded-For`, quindi l'IP del visitatore e non quello dell'edge) limitata a `/v1/auth/*`, più `AWSManagedRulesCommonRuleSet`.
- **Osservabilità**: log group con retention 30 giorni; allarmi su SNS: `QueueDepth` > 2000 per 15 minuti, 5xx dell'api > 1 % su 5 minuti, CPU RDS > 80 %, connessioni RDS > 80 % del massimo (~450 su t4g.medium), nessun task worker in esecuzione.
- **IAM** minimo per i task role: Rekognition solo su `collection/rephoto-*` (`ListCollections` richiede `*`), S3 solo sul bucket (con la chiave KMS), `ses:SendEmail`/`SendRawEmail` solo con `ses:FromAddress` = mittente configurato, `cloudwatch:PutMetricData` solo nel namespace `rephoto` (worker).

## Prerequisiti

- Node 20+, credenziali AWS con diritti da amministratore sull'account, Docker in esecuzione (le immagini vengono costruite in locale per `linux/arm64` al deploy).
- `npm install` in questa cartella.

## Contesto opzionale

| Chiave | Significato |
| --- | --- |
| `domainName` | host pubblico (es. `foto.example.it`) |
| `certificateArn` | certificato ACM in **eu-central-1** per l'ALB |
| `cloudFrontCertificateArn` | certificato ACM in **us-east-1** per CloudFront |
| `mailFrom` | mittente SES verificato (default `noreply@<domainName>`) |
| `alarmEmail` | sottoscrizione e-mail al topic degli allarmi |
| `eventSlug` | slug compilato nel build web (`NEXT_PUBLIC_EVENT_SLUG`, default `demo`) |

Le tre chiavi di dominio vanno insieme. Senza, lo stack risponde sul nome `*.cloudfront.net` e CloudFront parla con l'ALB in HTTP (dentro AWS); `NEXT_PUBLIC_WEB_ORIGIN` resta vuoto e HSTS è spento. Con dominio e certificati il percorso è TLS end to end e il CORS del bucket accetta solo quell'origine.

## Comandi

```sh
cd infra/cdk
npm install
npm run synth                                  # cdk synth, funziona anche senza credenziali
npx cdk bootstrap aws://<account>/eu-central-1  # una volta per account
npx cdk deploy -c domainName=foto.example.it \
  -c certificateArn=arn:aws:acm:eu-central-1:...:certificate/... \
  -c cloudFrontCertificateArn=arn:aws:acm:us-east-1:...:certificate/... \
  -c mailFrom=noreply@foto.example.it -c alarmEmail=ops@example.it
```

Synth offline: `CDK_DEFAULT_ACCOUNT=123456789012 npm run synth`. L'account deve essere noto al synth (nome del bucket e build arg del web); `cdk.context.json` contiene la lista di AZ per l'account segnaposto. Con credenziali vere `cdk` aggiunge la voce dell'account reale da solo.

Dopo il deploy: puntare il DNS del dominio all'output `CloudFrontDomain` (CNAME o alias Route 53), poi creare l'evento e invitare i fotografi dall'`/admin`. L'api esegue le migrazioni al boot sotto advisory lock, quindi più task possono partire insieme.

## Costo (ordine di grandezza, da rifare nel Pricing Calculator)

Con i minimi di scala e senza traffico: Fargate ARM (2 api + 1 worker + 2 web) ~120 USD/mese, RDS t4g.medium + proxy ~95 USD, NAT gateway ~35 USD + traffico, 7 interface endpoint ~55 USD, ALB ~20 USD, WAF ~10 USD, KMS/Secrets/log/allarmi ~10 USD. Totale circa **350 USD/mese** fermo. Durante l'evento si aggiungono storage S3 (1,2 TB ≈ 30 USD/mese), traffico CloudFront e Rekognition (~160 USD per evento da 150k foto, come in `docs/infra.md`). Spegnere lo stack tra un evento e l'altro: `cdk destroy` lascia bucket, chiave KMS e istanza RDS (removal policy RETAIN, deletion protection sul DB).

## Cosa NON è automatizzato

- **SES production access**: l'account nasce in sandbox; procedura in `docs/ses-produzione.md` e `scripts/request-ses-production.sh`. Verificare il dominio/mittente in SES prima del deploy.
- **Quota Rekognition**: `IndexFaces` e `SearchFacesByImage` hanno 5 TPS di default per account; per più di un'istanza worker alzare la quota in Service Quotas e `REKOGNITION_*_TPS` di conseguenza.
- **Dominio e certificati**: i due certificati ACM (eu-central-1 per l'ALB, us-east-1 per CloudFront) e il record DNS.
- **WAF su CloudFront**: una web ACL con scope `CLOUDFRONT` vive in us-east-1 e non può stare in questo stack; la regola è sull'ALB. L'ALB resta raggiungibile da Internet ma risponde `403` senza l'header di CloudFront; per chiudere del tutto, limitare il security group dell'ALB alla prefix list gestita `com.amazonaws.global.cloudfront.origin-facing`.
- **Multi-AZ RDS e secondo NAT**: scelte di costo di questa fase; sono due righe nello stack.
- Rekognition Face Liveness, uploader desktop, SQS: fuori scope (`docs/v2-spec.md` §7).
