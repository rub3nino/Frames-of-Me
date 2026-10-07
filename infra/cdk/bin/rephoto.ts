import * as cdk from "aws-cdk-lib";
import { RephotoStack } from "../lib/rephoto-stack.js";

// Region is fixed by the contract (CONTRACTS.md): everything lives in eu-central-1.
// The account must be concrete at synth time because the bucket name and the web build
// args derive from it: `cdk` sets CDK_DEFAULT_ACCOUNT from the credentials in use.
const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account) {
  throw new Error("CDK_DEFAULT_ACCOUNT is not set (configure AWS credentials, or export it for an offline synth)");
}

const app = new cdk.App();

new RephotoStack(app, "RephotoStack", {
  env: { account, region: "eu-central-1" },
  description: "RePhoto v2: ECS Fargate api/worker/web, RDS Postgres 16 + Proxy, S3, CloudFront, WAF",
  // Optional context (-c key=value or cdk.json "context"):
  //   domainName                 public host name served by CloudFront (e.g. foto.example.it)
  //   certificateArn             ACM certificate in eu-central-1 for the ALB (same host name)
  //   cloudFrontCertificateArn   ACM certificate in us-east-1 for CloudFront (same host name)
  //   mailFrom                   verified SES sender (default noreply@<domainName> or noreply@example.invalid)
  //   alarmEmail                 e-mail subscription for the alarm topic
  domainName: app.node.tryGetContext("domainName"),
  certificateArn: app.node.tryGetContext("certificateArn"),
  cloudFrontCertificateArn: app.node.tryGetContext("cloudFrontCertificateArn"),
  mailFrom: app.node.tryGetContext("mailFrom"),
  alarmEmail: app.node.tryGetContext("alarmEmail"),
  eventSlug: app.node.tryGetContext("eventSlug") ?? "demo",
});

app.synth();
