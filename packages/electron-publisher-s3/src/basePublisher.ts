import S3, { ClientConfiguration, CreateMultipartUploadRequest, ObjectCannedACL } from "aws-sdk/clients/s3"
import { Arch, debug } from "builder-util"
import { BaseS3Options } from "builder-util-runtime"
import { ProgressCallback, PublishContext, Publisher } from "electron-publish"
import { ensureDir, stat, symlink } from "fs-extra-p"
import mime from "mime"
import * as path from "path"
import { Uploader } from "./uploader"

export abstract class BaseS3Publisher extends Publisher {
  constructor(context: PublishContext, private options: BaseS3Options) {
    super(context)
  }

  protected abstract getBucketName(): string

  protected configureS3Options(s3Options: CreateMultipartUploadRequest) {
    // if explicitly set to null, do not add
    if (this.options.acl !== null) {
      s3Options.ACL = this.options.acl as ObjectCannedACL || "public-read"
    }
  }

  protected createClientConfiguration(): ClientConfiguration {
    return {signatureVersion: "v4"}
  }

  // http://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/s3-example-creating-buckets.html
  async upload(file: string, arch: Arch, safeArtifactName?: string): Promise<any> {
    const fileName = path.basename(file)
    const fileStat = await stat(file)
    const cancellationToken = this.context.cancellationToken

    const target = (this.options.path == null ? "" : `${this.options.path}/`) + fileName

    if (process.env.__TEST_S3_PUBLISHER__ != null) {
      const testFile = path.join(process.env.__TEST_S3_PUBLISHER__!, target)
      await ensureDir(path.dirname(testFile))
      await symlink(file, testFile)
      return
    }

    const s3Options: CreateMultipartUploadRequest  = {
      Key: target,
      Bucket: this.getBucketName(),
      ContentType: mime.getType(file) || "application/octet-stream"
    }
    this.configureS3Options(s3Options)

    const uploader = new Uploader(new S3(this.createClientConfiguration()), s3Options, file, fileStat)

    const progressBar = this.createProgressBar(fileName, fileStat)
    if (progressBar != null) {
      const callback = new ProgressCallback(progressBar)
      uploader.on("progress", () => {
        if (!cancellationToken.cancelled) {
          callback.update(uploader.loaded, uploader.contentLength)
        }
      })
    }

    return cancellationToken.createPromise((resolve, reject, onCancel) => {
      onCancel(() => uploader.abort())
      uploader.upload()
        .then(() => {
          try {
            debug(`${this.providerName} Publisher: ${fileName} was uploaded to ${this.getBucketName()}`)
          }
          finally {
            resolve()
          }
        })
        .catch(reject)
    })
  }

  toString() {
    return `${this.providerName} (bucket: ${this.getBucketName()})`
  }
}