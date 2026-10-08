import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sns_subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";

export interface RephotoStackProps extends cdk.StackProps {
  /** Public host name (CloudFront alias). Without it the stack serves on the *.cloudfront.net name over HTTP to the ALB. */
  domainName?: string;
  /** ACM certificate ARN in eu-central-1 for the ALB listener (must cover domainName). */
  certificateArn?: string;
  /** ACM certificate ARN in us-east-1 for CloudFront (must cover domainName). */
  cloudFrontCertificateArn?: string;
  /** Verified SES sender. */
  mailFrom?: string;
  /** Optional e-mail subscription on the alarm topic. */
  alarmEmail?: string;
  /** Event slug baked into the web build (NEXT_PUBLIC_EVENT_SLUG). */
  eventSlug: string;
}

const API_PORT = 8787;
const WEB_PORT = 3000;
const DB_NAME = "rephoto";
const DB_USER = "rephoto";
// Postgres on db.t4g.medium (4 GiB): max_connections = LEAST(DBInstanceClassMemory/9531392, 5000) ≈ 450.
const DB_MAX_CONNECTIONS = 450;
const QUEUE_METRIC_NAMESPACE = "rephoto";
const QUEUE_METRIC_NAME = "QueueDepth";

/** Repo root: this file lives in infra/cdk/lib. Docker build contexts point here. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export class RephotoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RephotoStackProps) {
    super(scope, id, props);

    const region = this.region;
    const account = this.account;
    const hasTls = Boolean(props.domainName && props.certificateArn && props.cloudFrontCertificateArn);
    if ((props.domainName || props.certificateArn || props.cloudFrontCertificateArn) && !hasTls) {
      throw new Error("domainName, certificateArn and cloudFrontCertificateArn must be given together");
    }
    const mailFrom = props.mailFrom ?? (props.domainName ? `noreply@${props.domainName}` : "noreply@example.invalid");

    // ------------------------------------------------------------------ network
    const vpc = new ec2.Vpc(this, "Vpc", {
      // The AZ list is an AWS context lookup cached in cdk.context.json; the committed entry for
      // the placeholder account 123456789012 keeps `npm run synth` working offline.
      maxAzs: 2,
      // One NAT gateway: SESv2 and CloudWatch metrics have no gateway endpoint; everything
      // else below goes through VPC endpoints. The NAT is the single-AZ compromise of this stack.
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "app", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: "db", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });
    const appSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
    const endpointServices: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      Monitoring: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      Rekognition: ec2.InterfaceVpcEndpointAwsService.REKOGNITION,
      // email-smtp: SMTP relay endpoint. The app uses the SESv2 API (MAIL_TRANSPORT=ses), which
      // reaches the regional endpoint through the NAT gateway. Kept for an SMTP fallback.
      SesSmtp: ec2.InterfaceVpcEndpointAwsService.SES,
    };
    for (const [name, service] of Object.entries(endpointServices)) {
      vpc.addInterfaceEndpoint(name, { service, subnets: appSubnets });
    }

    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc, description: "ALB", allowAllOutbound: true });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP from CloudFront");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS from CloudFront");
    const apiSg = new ec2.SecurityGroup(this, "ApiSg", { vpc, description: "api tasks" });
    const webSg = new ec2.SecurityGroup(this, "WebSg", { vpc, description: "web tasks" });
    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", { vpc, description: "worker tasks" });
    const proxySg = new ec2.SecurityGroup(this, "ProxySg", { vpc, description: "RDS Proxy" });
    const dbSg = new ec2.SecurityGroup(this, "DbSg", { vpc, description: "RDS Postgres", allowAllOutbound: false });
    apiSg.addIngressRule(albSg, ec2.Port.tcp(API_PORT), "ALB to api");
    webSg.addIngressRule(albSg, ec2.Port.tcp(WEB_PORT), "ALB to web");
    proxySg.addIngressRule(apiSg, ec2.Port.tcp(5432), "api to proxy");
    proxySg.addIngressRule(workerSg, ec2.Port.tcp(5432), "worker to proxy");
    dbSg.addIngressRule(proxySg, ec2.Port.tcp(5432), "proxy to postgres");

    // ------------------------------------------------------------------ encryption + storage
    const key = new kms.Key(this, "Key", {
      description: "Frames of Me data at rest (S3, RDS)",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const webOrigin = hasTls ? `https://${props.domainName}` : undefined;
    // Literal name: the web build args (NEXT_PUBLIC_MEDIA_ORIGINS) must be known before deploy.
    const mediaBucketName = `rephoto-media-${account}-${region}`;
    const bucket = new s3.Bucket(this, "Media", {
      bucketName: mediaBucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        // Safety net: the match job deletes the selfie itself (CONTRACTS.md / DPIA).
        { id: "expire-selfies", prefix: "selfies/", expiration: Duration.days(2) },
        { id: "abort-multipart", abortIncompleteMultipartUploadAfter: Duration.days(2) },
      ],
      cors: [
        {
          // The browser PUTs parts straight to presigned URLs and reads thumbnails from them.
          allowedOrigins: webOrigin ? [webOrigin] : ["*"],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3600,
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const mediaOrigin = `https://${mediaBucketName}.s3.${region}.amazonaws.com`;

    // ------------------------------------------------------------------ database
    const db = new rds.DatabaseInstance(this, "Db", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      multiAz: false,
      allocatedStorage: 50,
      maxAllocatedStorage: 200,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      storageEncryptionKey: key,
      databaseName: DB_NAME,
      credentials: rds.Credentials.fromGeneratedSecret(DB_USER),
      backupRetention: Duration.days(7),
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
    });
    const dbSecret = db.secret!;
    const proxy = db.addProxy("Proxy", {
      secrets: [dbSecret],
      vpc,
      vpcSubnets: appSubnets,
      securityGroups: [proxySg],
      requireTLS: true,
      maxConnectionsPercent: 90,
      // The app uses prepared statements (prepare: true), which pin sessions on the proxy; the
      // proxy still absorbs connection churn from task restarts and scale-out.
      borrowTimeout: Duration.seconds(30),
    });

    // DATABASE_URL as one secret the tasks read whole. The password is a CloudFormation dynamic
    // reference to the RDS secret, resolved at deploy time; the generated password excludes
    // URL-reserved characters.
    const databaseUrl = new secretsmanager.Secret(this, "DatabaseUrl", {
      description: "postgres:// URL through the RDS Proxy",
      secretStringValue: cdk.SecretValue.unsafePlainText(
        `postgres://${DB_USER}:${dbSecret.secretValueFromJson("password").unsafeUnwrap()}@${proxy.endpoint}:5432/${DB_NAME}?sslmode=require`,
      ),
    });
    const sessionSecret = new secretsmanager.Secret(this, "SessionSecret", {
      description: "SESSION_SECRET for cookie signing",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    const originVerify = new secretsmanager.Secret(this, "OriginVerify", {
      description: "Header CloudFront adds so the ALB only serves CloudFront traffic",
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
    });

    // ------------------------------------------------------------------ ECS
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/rephoto/${name.toLowerCase()}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    const platform = ecr_assets.Platform.LINUX_ARM64;
    const runtimePlatform: ecs.RuntimePlatform = {
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };

    // Public origin: the custom domain, or the CloudFront domain (a token resolved at deploy).
    // Declared before the distribution exists via a lazy value to avoid ordering issues.
    let distribution: cloudfront.Distribution | undefined;
    const publicOrigin = webOrigin ?? cdk.Lazy.string({ produce: () => `https://${distribution!.distributionDomainName}` });

    const sharedEnv: Record<string, string> = {
      NODE_ENV: "production",
      S3_BUCKET: bucket.bucketName,
      S3_REGION: region,
      AWS_REGION: region,
      FACE_ENGINE: "rekognition",
      REKOGNITION_COLLECTION_PREFIX: "rephoto-",
      REKOGNITION_SEARCH_MAX_FACES: "500",
      REKOGNITION_INDEX_TPS: "5",
      REKOGNITION_SEARCH_TPS: "5",
      MAIL_TRANSPORT: "ses",
      SMTP_FROM: mailFrom,
      WEB_ORIGIN: publicOrigin,
      API_ORIGIN: publicOrigin,
      SEED_DEMO: "false",
      DATABASE_POOL_MAX: "10",
      // x-forwarded-for at the api is "client, cloudfront-edge": CloudFront appends the client,
      // the ALB appends the edge. Two trusted hops.
      TRUSTED_PROXY_HOPS: "2",
    };
    const sharedSecrets: Record<string, ecs.Secret> = {
      DATABASE_URL: ecs.Secret.fromSecretsManager(databaseUrl),
      SESSION_SECRET: ecs.Secret.fromSecretsManager(sessionSecret),
    };

    const rekognitionPolicy = (role: iam.IRole) => {
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: "RekognitionCollections",
          actions: [
            "rekognition:CreateCollection",
            "rekognition:DeleteCollection",
            "rekognition:DescribeCollection",
            "rekognition:IndexFaces",
            "rekognition:ListFaces",
            "rekognition:DeleteFaces",
            "rekognition:SearchFaces",
            "rekognition:SearchFacesByImage",
          ],
          resources: [`arn:aws:rekognition:${region}:${account}:collection/rephoto-*`],
        }),
      );
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: "RekognitionList",
          actions: ["rekognition:ListCollections"],
          resources: ["*"],
        }),
      );
    };
    const sesPolicy = (role: iam.IRole) => {
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: "SesSend",
          actions: ["ses:SendEmail", "ses:SendRawEmail"],
          resources: [`arn:aws:ses:${region}:${account}:identity/*`],
          conditions: { StringEquals: { "ses:FromAddress": mailFrom } },
        }),
      );
    };

    // api
    const apiTask = new ecs.FargateTaskDefinition(this, "ApiTask", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform,
    });
    apiTask.addContainer("api", {
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, { file: "apps/api/Dockerfile", platform }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "api", logGroup: logGroup("Api") }),
      environment: sharedEnv,
      secrets: sharedSecrets,
      portMappings: [{ containerPort: API_PORT }],
      healthCheck: {
        command: [
          "CMD-SHELL",
          `node -e "fetch('http://127.0.0.1:${API_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        startPeriod: Duration.seconds(60),
        retries: 3,
      },
    });
    bucket.grantReadWrite(apiTask.taskRole);
    rekognitionPolicy(apiTask.taskRole);
    sesPolicy(apiTask.taskRole);

    const apiService = new ecs.FargateService(this, "ApiService", {
      cluster,
      taskDefinition: apiTask,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      securityGroups: [apiSg],
      vpcSubnets: appSubnets,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: Duration.seconds(90),
    });
    apiService
      .autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 })
      .scaleOnCpuUtilization("Cpu", {
        targetUtilizationPercent: 60,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(1),
      });

    // worker
    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform,
    });
    workerTask.addContainer("worker", {
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, { file: "apps/worker/Dockerfile", platform }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "worker", logGroup: logGroup("Worker") }),
      environment: {
        ...sharedEnv,
        WORKER_CONCURRENCY: "4",
        WORKER_PUBLISH_METRICS: "true",
      },
      secrets: sharedSecrets,
      stopTimeout: Duration.seconds(90), // graceful shutdown waits up to 60 s for in-flight jobs
    });
    bucket.grantReadWrite(workerTask.taskRole);
    rekognitionPolicy(workerTask.taskRole);
    sesPolicy(workerTask.taskRole);
    workerTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "PublishQueueDepth",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": QUEUE_METRIC_NAMESPACE } },
      }),
    );

    const workerService = new ecs.FargateService(this, "WorkerService", {
      cluster,
      taskDefinition: workerTask,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      securityGroups: [workerSg],
      vpcSubnets: appSubnets,
      circuitBreaker: { enable: true, rollback: true },
    });
    const queueDepth = new cloudwatch.Metric({
      namespace: QUEUE_METRIC_NAMESPACE,
      metricName: QUEUE_METRIC_NAME,
      statistic: cloudwatch.Stats.MAXIMUM,
      period: Duration.minutes(1),
    });
    workerService
      .autoScaleTaskCount({ minCapacity: 1, maxCapacity: 8 })
      .scaleOnMetric("QueueDepth", {
        metric: queueDepth,
        adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
        cooldown: Duration.minutes(3),
        scalingSteps: [
          { upper: 50, change: -1 },
          { lower: 300, change: +1 },
          { lower: 1000, change: +2 },
          { lower: 3000, change: +4 },
        ],
      });

    // web
    const webTask = new ecs.FargateTaskDefinition(this, "WebTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform,
    });
    webTask.addContainer("web", {
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, {
        file: "apps/web/Dockerfile",
        platform,
        buildArgs: {
          NEXT_PUBLIC_EVENT_SLUG: props.eventSlug,
          NEXT_PUBLIC_MEDIA_ORIGINS: mediaOrigin,
          NEXT_PUBLIC_WEB_ORIGIN: webOrigin ?? "",
        },
      }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "web", logGroup: logGroup("Web") }),
      environment: {
        NODE_ENV: "production",
        // The ALB routes /v1/* straight to the api; the proxy only backs server-side fetches.
        API_PROXY_TARGET: publicOrigin,
        NEXT_PUBLIC_EVENT_SLUG: props.eventSlug,
        NEXT_PUBLIC_MEDIA_ORIGINS: mediaOrigin,
        NEXT_PUBLIC_WEB_ORIGIN: webOrigin ?? "",
      },
      portMappings: [{ containerPort: WEB_PORT }],
    });
    const webService = new ecs.FargateService(this, "WebService", {
      cluster,
      taskDefinition: webTask,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      securityGroups: [webSg],
      vpcSubnets: appSubnets,
      circuitBreaker: { enable: true, rollback: true },
    });
    webService
      .autoScaleTaskCount({ minCapacity: 2, maxCapacity: 4 })
      .scaleOnCpuUtilization("Cpu", { targetUtilizationPercent: 60 });

    // ------------------------------------------------------------------ ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: Duration.seconds(300), // ZIP streams and 60 MiB part uploads
      dropInvalidHeaderFields: true,
    });
    const listener = hasTls
      ? alb.addListener("Https", {
          port: 443,
          certificates: [acm.Certificate.fromCertificateArn(this, "AlbCert", props.certificateArn!)],
          sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
          defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: "text/plain", messageBody: "forbidden" }),
        })
      : alb.addListener("Http", {
          port: 80,
          defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: "text/plain", messageBody: "forbidden" }),
        });
    if (hasTls) {
      alb.addRedirect({ sourcePort: 80, targetPort: 443 });
    }
    const originHeader = elbv2.ListenerCondition.httpHeader("X-Origin-Verify", [originVerify.secretValue.unsafeUnwrap()]);
    const apiTargets = listener.addTargets("ApiTg", {
      priority: 10,
      conditions: [originHeader, elbv2.ListenerCondition.pathPatterns(["/v1/*"])],
      port: API_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService],
      deregistrationDelay: Duration.seconds(15),
      healthCheck: { path: "/health", interval: Duration.seconds(15), healthyThresholdCount: 2 },
    });
    listener.addTargets("WebTg", {
      priority: 20,
      conditions: [originHeader],
      port: WEB_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService],
      deregistrationDelay: Duration.seconds(15),
      healthCheck: { path: "/", interval: Duration.seconds(15), healthyThresholdCount: 2 },
    });

    // ------------------------------------------------------------------ WAF (regional, on the ALB)
    // A CLOUDFRONT-scoped web ACL must live in us-east-1, which this single eu-central-1 stack
    // cannot create. The ACL is attached to the ALB instead and rates by X-Forwarded-For, so the
    // counted address is the viewer, not the CloudFront edge.
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: "rephoto-waf" },
      rules: [
        {
          name: "AuthRateLimit",
          priority: 0,
          action: { block: {} },
          visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: "rephoto-auth-rate" },
          statement: {
            rateBasedStatement: {
              limit: 300,
              evaluationWindowSec: 300,
              aggregateKeyType: "FORWARDED_IP",
              forwardedIpConfig: { headerName: "X-Forwarded-For", fallbackBehavior: "MATCH" },
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  searchString: "/v1/auth/",
                  textTransformations: [{ priority: 0, type: "LOWERCASE" }],
                },
              },
            },
          },
        },
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 1,
          overrideAction: { none: {} },
          visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: "rephoto-common" },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
              // Multipart uploads go straight to S3, but the ZIP form and participant import
              // bodies can exceed the 8 KB body inspection size; keep the body rule in count mode.
              ruleActionOverrides: [{ name: "SizeRestrictions_BODY", actionToUse: { count: {} } }],
            },
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // ------------------------------------------------------------------ CloudFront
    const albOrigin = new origins.LoadBalancerV2Origin(alb, {
      protocolPolicy: hasTls ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      customHeaders: { "X-Origin-Verify": originVerify.secretValue.unsafeUnwrap() },
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(60),
    });
    const dynamic: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      compress: true,
    };
    distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: "Frames of Me web + api",
      defaultBehavior: dynamic,
      additionalBehaviors: {
        "/_next/static/*": {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
      },
      domainNames: hasTls ? [props.domainName!] : undefined,
      certificate: hasTls ? acm.Certificate.fromCertificateArn(this, "CdnCert", props.cloudFrontCertificateArn!) : undefined,
      minimumProtocolVersion: hasTls ? cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021 : undefined,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // EU + North America edges only (DPIA note)
    });

    // ------------------------------------------------------------------ alarms
    const alarmTopic = new sns.Topic(this, "Alarms", { displayName: "Frames of Me alarms" });
    if (props.alarmEmail) {
      alarmTopic.addSubscription(new sns_subs.EmailSubscription(props.alarmEmail));
    }
    const notify = (alarm: cloudwatch.Alarm) => {
      alarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));
      alarm.addOkAction(new cw_actions.SnsAction(alarmTopic));
    };

    notify(
      new cloudwatch.Alarm(this, "QueueDepthAlarm", {
        alarmDescription: "rephoto/QueueDepth above 2000 for 15 minutes",
        metric: queueDepth,
        threshold: 2000,
        evaluationPeriods: 15,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    notify(
      new cloudwatch.Alarm(this, "Api5xxAlarm", {
        alarmDescription: "api 5xx above 1% of requests over 5 minutes",
        metric: new cloudwatch.MathExpression({
          expression: "IF(req > 0, 100 * e5xx / req, 0)",
          usingMetrics: {
            e5xx: apiTargets.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
              period: Duration.minutes(5),
              statistic: cloudwatch.Stats.SUM,
            }),
            req: apiTargets.metrics.requestCount({ period: Duration.minutes(5), statistic: cloudwatch.Stats.SUM }),
          },
          period: Duration.minutes(5),
          label: "api 5xx %",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    notify(
      new cloudwatch.Alarm(this, "RdsCpuAlarm", {
        alarmDescription: "RDS CPU above 80%",
        metric: db.metricCPUUtilization({ period: Duration.minutes(5) }),
        threshold: 80,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      }),
    );
    notify(
      new cloudwatch.Alarm(this, "RdsConnectionsAlarm", {
        alarmDescription: `RDS connections above 80% of max (${DB_MAX_CONNECTIONS})`,
        metric: db.metricDatabaseConnections({ period: Duration.minutes(5), statistic: cloudwatch.Stats.MAXIMUM }),
        threshold: Math.floor(DB_MAX_CONNECTIONS * 0.8),
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      }),
    );
    notify(
      new cloudwatch.Alarm(this, "WorkerRunningAlarm", {
        alarmDescription: "no worker task running",
        metric: workerService.metricCpuUtilization({ period: Duration.minutes(5), statistic: cloudwatch.Stats.SAMPLE_COUNT }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
    );

    // ------------------------------------------------------------------ outputs
    new cdk.CfnOutput(this, "PublicUrl", { value: publicOrigin });
    new cdk.CfnOutput(this, "CloudFrontDomain", { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, "AlbDns", { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, "MediaBucket", { value: bucket.bucketName });
    new cdk.CfnOutput(this, "RdsProxyEndpoint", { value: proxy.endpoint });
    new cdk.CfnOutput(this, "AlarmTopicArn", { value: alarmTopic.topicArn });
    new cdk.CfnOutput(this, "QueueDepthMetric", {
      value: `${QUEUE_METRIC_NAMESPACE}/${QUEUE_METRIC_NAME} (no dimensions, Maximum, 1 min)`,
    });
  }
}
