import { RemovalPolicy } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";

function bucketNameForStage(stage: string): string {
  return `tokenmaxxing-${stage}`;
}

const Bucket = Cloudflare.R2Bucket(
  "BUCKET",
  Stack.useSync(({ stage }) => ({
    name: bucketNameForStage(stage),
  })),
).pipe(RemovalPolicy.retain());

export { Bucket, bucketNameForStage };
