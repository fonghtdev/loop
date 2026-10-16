import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "./env.js";

declare module "fastify" {
  interface FastifyInstance {
    storage: ObjectStorage;
  }
}

export const UPLOAD_URL_SECONDS = 300;
export const DOWNLOAD_URL_SECONDS = 3600;

/**
 * The only module that talks to S3 (MinIO in dev, R2 in production): presigned PUT/GET, HEAD, ranged read,
 * delete. R2 has no presigned POST policies, so uploads are PUTs that the server verifies afterwards.
 */
const isStatus = (e: unknown, status: number) => e instanceof S3ServiceException && e.$metadata.httpStatusCode === status;

export function createStorage({ endpoint, region, bucket, accessKey, secretKey }: Env["s3"]) {
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    // the default adds a CRC32 query parameter to presigned URLs, which the uploading client would have to match
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  const Bucket = bucket;

  return {
    /** PUT URL bound to the key, the declared type and the declared length (signed headers the client must send). */
    presignPut: (Key: string, contentType: string, size: number) =>
      getSignedUrl(client, new PutObjectCommand({ Bucket, Key, ContentType: contentType, ContentLength: size }), {
        expiresIn: UPLOAD_URL_SECONDS,
        signableHeaders: new Set(["content-type", "content-length"]),
      }),

    /** `contentType` undefined = serve the type the object was stored with. */
    presignGet: (Key: string, contentType: string | undefined, contentDisposition: string) =>
      getSignedUrl(
        client,
        new GetObjectCommand({ Bucket, Key, ResponseContentType: contentType, ResponseContentDisposition: contentDisposition }),
        { expiresIn: DOWNLOAD_URL_SECONDS },
      ),

    /** Real size and ETag of the stored object, or null when it does not exist. */
    async head(Key: string) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key }));
        return { size: res.ContentLength ?? 0, etag: res.ETag! };
      } catch (e) {
        if (isStatus(e, 404)) return null;
        throw e;
      }
    },

    /** The first `length` bytes (the object must not be empty), or null when it is no longer the version with `etag`. */
    async firstBytes(Key: string, length: number, etag: string) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key, Range: `bytes=0-${length - 1}`, IfMatch: etag }));
        return await res.Body!.transformToByteArray();
      } catch (e) {
        if (isStatus(e, 412)) return null;
        throw e;
      }
    },

    /** Server-side copy of exactly the version with `etag`; false when the source changed since (nothing is copied). */
    async copy(from: string, to: string, etag: string) {
      try {
        await client.send(new CopyObjectCommand({ Bucket, Key: to, CopySource: `${Bucket}/${from}`, CopySourceIfMatch: etag }));
        return true;
      } catch (e) {
        if (isStatus(e, 412)) return false;
        throw e;
      }
    },

    /** Server-side upload of bytes the server itself verified (link preview thumbnails). */
    put: (Key: string, body: Uint8Array, contentType: string) =>
      client.send(new PutObjectCommand({ Bucket, Key, Body: body, ContentType: contentType })).then(() => undefined),

    /** Deleting a missing key is not an error. */
    remove: (Key: string) => client.send(new DeleteObjectCommand({ Bucket, Key })).then(() => undefined),

    close: () => client.destroy(),
  };
}

export type ObjectStorage = ReturnType<typeof createStorage>;
