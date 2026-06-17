import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

class RawUsageStorageError extends Data.TaggedError("RawUsageStorageError")<{
  readonly cause: unknown;
}> {}

interface R2BucketLike {
  put(
    key: string,
    value: string,
    options?: {
      customMetadata?: Record<string, string>;
      httpMetadata?: { contentType?: string };
    },
  ): Effect.Effect<unknown, unknown, any>;
}

interface RawUsageObjectStoreShape {
  putObject(input: {
    key: string;
    payloadBytes: number;
    payloadHash: string;
    payloadJson: string;
  }): Effect.Effect<void, RawUsageStorageError, any>;
}

class RawUsageObjectStore extends Context.Service<RawUsageObjectStore, RawUsageObjectStoreShape>()(
  "@tokenmaxxing/api/RawUsageObjectStore",
) {
  static layer(bucket: R2BucketLike): Layer.Layer<RawUsageObjectStore> {
    return Layer.succeed(
      RawUsageObjectStore,
      RawUsageObjectStore.of({
        putObject: ({ key, payloadBytes, payloadHash, payloadJson }) =>
          bucket
            .put(key, payloadJson, {
              customMetadata: {
                payloadBytes: String(payloadBytes),
                payloadHash,
              },
              httpMetadata: { contentType: "application/json" },
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError((cause) => new RawUsageStorageError({ cause })),
            ),
      }),
    );
  }
}

export { RawUsageObjectStore, RawUsageStorageError };

export type { RawUsageObjectStoreShape };
