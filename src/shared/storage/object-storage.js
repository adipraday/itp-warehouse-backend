import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

// Object storage for uploaded documents (supplier invoice PDFs), on Cloudflare R2 through its
// S3-compatible API. Files never pass through the browser's reach directly: the API authenticates
// the caller, checks the purchase's BU scope, and only then reads/writes the bucket, so the bucket
// stays private and needs no CORS setup.
//
// Optional by design: with the R2_* variables unset the app still boots and everything else works;
// only the upload/download endpoints answer 503 STORAGE_NOT_CONFIGURED.
export function createObjectStorage(config, { client = null } = {}) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = config;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    return null;
  }

  const s3 =
    client ??
    new S3Client({
      region: 'auto',
      endpoint: config.R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
    });

  return {
    async putObject(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: contentType }));
    },

    // Returns { body: Buffer, contentType } or null when the object does not exist.
    async getObject(key) {
      try {
        const result = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        const bytes = await result.Body.transformToByteArray();
        return { body: Buffer.from(bytes), contentType: result.ContentType ?? 'application/octet-stream' };
      } catch (error) {
        if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },

    async deleteObject(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    }
  };
}
