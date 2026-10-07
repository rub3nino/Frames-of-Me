import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import type { Database } from "@rephoto/db";

export const METRIC_NAMESPACE = "rephoto";
export const QUEUE_DEPTH_METRIC = "QueueDepth";

export type MetricPublisher = (value: number) => Promise<void>;

export function createCloudWatchPublisher(region: string): MetricPublisher {
  const client = new CloudWatchClient({ region });
  return async (value) => {
    await client.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: QUEUE_DEPTH_METRIC,
            Value: value,
            Unit: "Count",
            Timestamp: new Date(),
          },
        ],
      }),
    );
  };
}

/** Publishes `jobsQueued` once; errors are logged, never thrown (the loop must not die). */
export async function publishQueueDepth(db: Database, publish: MetricPublisher): Promise<void> {
  try {
    const { jobsQueued } = await db.metrics();
    await publish(jobsQueued);
  } catch (error) {
    console.error(
      JSON.stringify({ ts: new Date().toISOString(), metric: QUEUE_DEPTH_METRIC, error: String(error) }),
    );
  }
}
