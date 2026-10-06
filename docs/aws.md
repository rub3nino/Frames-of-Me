# Note di deploy AWS

Appunti, non Terraform e non una fattura. Data: 2026-10-06. Allineati a `CONTRACTS.md` (region, coda, soglia, bucket) e alla forma di deploy concordata per il primo evento. L'MVP non è finito: qui non c'è un template da applicare.

## Region e motori

Tutto in **eu-central-1**. `AWS_REGION` e `S3_REGION` sono quel valore e ogni altro va rifiutato. Niente GPU. Niente Qdrant. Niente runtime InsightFace.

Il confronto volti di produzione è l'adattatore `FaceEngine` con `FACE_ENGINE=rekognition`: una collection per evento, nome `rephoto-{eventId}`. Soglia `REKOGNITION_MIN_SIMILARITY` **90** (scala 0–100, match se `>=`). In locale il compose usa `FACE_ENGINE=fake` e non chiama AWS.

## Compute e dati

- **ECS su Fargate**, due servizi: `api` e `worker`. Nessuna istanza GPU.
- **RDS PostgreSQL** `db.t4g.medium`. Un solo Postgres, come il contratto (§9). La classe d'istanza è la scelta di questa nota di fase 0, non un campo del contratto.
- **S3**, bucket privato (in contratto il nome locale è `rephoto`). Nessuna policy pubblica. Letture solo con URL firmati, TTL **15 minuti** (`CONTRACTS.md` §4: thumb, web, originale). Il deploy mette **CloudFront** davanti al bucket per quegli URL. I PoP fuori dall'UE sono un punto aperto della DPIA (`docs/DPIA.md`), non una pratica già accettata.
- Lifecycle sui selfie: sul bucket AWS va messa una regola di scadenza a **2 giorni** sul prefisso `selfies/`. L'app non la crea, e MinIO nel compose non la applica. È una rete di sicurezza: il worker cancella il selfie quando la ricerca finisce. Non è configurata finché qualcuno non la aggiunge sul bucket.
- **SES** nella stessa region, solo a production access concesso. Fino ad allora l'account è in sandbox. Procedura: `docs/ses-produzione.md`.
- **Rekognition**, collection per evento, create alla prima indicizzazione se manca.
- **SQS** coda `rephoto-jobs`. Il body è lo stesso JSON di `jobs.payload` (`derive`, `index`, `search`, `email`). Non si usa ElasticMQ.
- **Secrets Manager** per i segreti applicativi. Non vanno nel repo, nel database, nei log, né in `ExternalImageId`.
- Cifratura a riposo **KMS** su RDS e S3; TLS verso i client e verso le API AWS.

## Rete

- **ALB** sulle subnet pubbliche, verso i task `api`.
- Task ECS (api e worker) e RDS sulle **subnet private**.
- **Gateway endpoint S3**, così i task raggiungono il bucket senza NAT per S3.
- Rekognition, SES, SQS, ECR, Secrets Manager e i log non passano da quel gateway. NAT oppure interface endpoint: questa nota non sceglie e non stima quella riga a parte.

Il worker non è sul bilanciatore. Non c'è un secondo servizio di ricerca.

## Costo

Non è una fattura e non è un impegno di spesa. Stima di fase 0, da rifare nell'**AWS Pricing Calculator** prima di ordinare:

- circa **315 USD al mese** con la GPU spenta (la forma sopra, senza istanze GPU);
- circa **160 USD di Rekognition per evento**, in più, non dentro i 315.

I prezzi AWS si muovono. La cifra non include una lettura aggiornata di CloudFront, NAT, Secrets Manager o i 1,2 TB di storage del contratto: vanno ricontrollati nel calcolatore insieme al resto.
