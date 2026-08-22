import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppEnv } from '../../config/env.js';

export interface ObjectStorage {
  put(key: string, contents: Buffer): Promise<{ objectUrl: string }>;
  open(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

export class LocalObjectStorage implements ObjectStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(process.cwd(), root);
  }

  async put(key: string, contents: Buffer): Promise<{ objectUrl: string }> {
    const target = this.target(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, { flag: 'wx' });
    return { objectUrl: `local-object://${key}` };
  }

  async open(key: string): Promise<Readable> {
    return createReadStream(this.target(key));
  }

  async remove(key: string): Promise<void> {
    try { await unlink(this.target(key)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private target(key: string): string {
    if (!/^[a-zA-Z0-9/_-]+\.(jpg|png|webp|pdf)$/.test(key)) throw new Error('OBJECT_KEY_INVALID');
    const target = resolve(this.root, key);
    if (!target.startsWith(`${this.root}${sep}`)) throw new Error('OBJECT_KEY_OUTSIDE_ROOT');
    return target;
  }
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly bucket: string, env: AppEnv) {
    this.client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? {
        credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
      } : {}),
    });
  }

  async put(key: string, contents: Buffer): Promise<{ objectUrl: string }> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: contents, ContentLength: contents.length,
      CacheControl: 'private, no-store',
    }));
    return { objectUrl: `s3://${this.bucket}/${key}` };
  }

  async open(key: string): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error('OBJECT_NOT_FOUND');
    if (result.Body instanceof Readable) return result.Body;
    return Readable.fromWeb(result.Body.transformToWebStream());
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createObjectStorage(env: AppEnv): ObjectStorage {
  if (env.OBJECT_STORAGE_PROVIDER === 's3') {
    if (!env.S3_BUCKET) throw new Error('S3_BUCKET_REQUIRED');
    return new S3ObjectStorage(env.S3_BUCKET, env);
  }
  return new LocalObjectStorage(env.OBJECT_STORAGE_PATH);
}
