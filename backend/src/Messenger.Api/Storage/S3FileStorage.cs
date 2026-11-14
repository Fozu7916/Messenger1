using System.Net;
using Amazon;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Amazon.S3.Util;

namespace Messenger.Api.Storage;

/// <summary>Реализация поверх любого S3-совместимого хранилища (Yandex Object Storage, MinIO, AWS S3, R2).</summary>
public sealed class S3FileStorage : IFileStorage, IDisposable
{
    private readonly StorageOptions _o;
    private readonly ILogger<S3FileStorage> _log;
    private readonly AmazonS3Client _s3;

    public S3FileStorage(StorageOptions options, ILogger<S3FileStorage> log)
    {
        _o = options;
        _log = log;
        var cfg = new AmazonS3Config
        {
            ForcePathStyle = options.ForcePathStyle,
            // Новые версии SDK по умолчанию добавляют контрольные суммы CRC32, которые не все S3-совместимые хранилища понимают.
            // Считаем их только там, где протокол этого требует.
            RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
            ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
        };
        if (!string.IsNullOrWhiteSpace(options.Endpoint))
        {
            cfg.ServiceURL = options.Endpoint;
            cfg.AuthenticationRegion = options.Region;
        }
        else cfg.RegionEndpoint = RegionEndpoint.GetBySystemName(options.Region);
        _s3 = new AmazonS3Client(new BasicAWSCredentials(options.AccessKey, options.SecretKey), cfg);
    }

    public async Task PutAsync(string key, Stream content, long length, string contentType, CancellationToken ct = default)
    {
        var req = new PutObjectRequest
        {
            BucketName = _o.Bucket,
            Key = key,
            InputStream = content,
            ContentType = contentType,
            AutoCloseStream = false,
        };
        req.Headers.ContentLength = length;
        await _s3.PutObjectAsync(req, ct);
    }

    public async Task<IStoredFile?> GetAsync(string key, CancellationToken ct = default)
    {
        try { return new S3StoredFile(await _s3.GetObjectAsync(_o.Bucket, key, ct)); }
        catch (AmazonS3Exception e) when (e.StatusCode == HttpStatusCode.NotFound) { return null; }
    }

    public Task DeleteAsync(string key, CancellationToken ct = default) => _s3.DeleteObjectAsync(_o.Bucket, key, ct);

    public Task CopyAsync(string sourceKey, string destinationKey, CancellationToken ct = default) =>
        _s3.CopyObjectAsync(_o.Bucket, sourceKey, _o.Bucket, destinationKey, ct);

    public async Task<long?> SizeAsync(string key, CancellationToken ct = default)
    {
        try { return (await _s3.GetObjectMetadataAsync(_o.Bucket, key, ct)).ContentLength; }
        catch (AmazonS3Exception e) when (e.StatusCode == HttpStatusCode.NotFound) { return null; }
    }

    public async Task<byte[]?> ReadStartAsync(string key, int count, CancellationToken ct = default)
    {
        try
        {
            using var r = await _s3.GetObjectAsync(new GetObjectRequest { BucketName = _o.Bucket, Key = key, ByteRange = new ByteRange(0, count - 1) }, ct);
            var buf = new byte[count];
            var n = 0;
            while (n < count)
            {
                var read = await r.ResponseStream.ReadAsync(buf.AsMemory(n), ct);
                if (read == 0) break;
                n += read;
            }
            return buf[..n];
        }
        catch (AmazonS3Exception e) when (e.StatusCode == HttpStatusCode.NotFound) { return null; }
    }

    public string GetUploadUrl(string key, string contentType, TimeSpan ttl) => _s3.GetPreSignedURL(new GetPreSignedUrlRequest
    {
        BucketName = _o.Bucket,
        Key = key,
        Verb = HttpVerb.PUT,
        ContentType = contentType,
        Expires = DateTime.UtcNow.Add(ttl),
        Protocol = _o.Endpoint.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ? Protocol.HTTP : Protocol.HTTPS,
    });

    public async Task<IReadOnlyList<string>> ListAsync(string prefix, int max, CancellationToken ct = default)
    {
        var r = await _s3.ListObjectsV2Async(new ListObjectsV2Request { BucketName = _o.Bucket, Prefix = prefix, MaxKeys = max }, ct);
        return (r.S3Objects ?? []).Select(o => o.Key).ToList();
    }

    public string GetDownloadUrl(string key, TimeSpan ttl) => _s3.GetPreSignedURL(new GetPreSignedUrlRequest
    {
        BucketName = _o.Bucket,
        Key = key,
        Verb = HttpVerb.GET,
        Expires = DateTime.UtcNow.Add(ttl),
        Protocol = _o.Endpoint.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ? Protocol.HTTP : Protocol.HTTPS,
    });

    /// <summary>Проверка доступа к бакету при старте (и создание бакета, если EnsureBucket включён).</summary>
    public async Task EnsureReadyAsync(CancellationToken ct)
    {
        if (_o.EnsureBucket && !await AmazonS3Util.DoesS3BucketExistV2Async(_s3, _o.Bucket))
        {
            await _s3.PutBucketAsync(_o.Bucket, ct);
            _log.LogInformation("Storage bucket {Bucket} created", _o.Bucket);
        }
        await _s3.ListObjectsV2Async(new ListObjectsV2Request { BucketName = _o.Bucket, MaxKeys = 1 }, ct);
    }

    public void Dispose() => _s3.Dispose();

    private sealed class S3StoredFile(GetObjectResponse r) : IStoredFile
    {
        public Stream Content => r.ResponseStream;
        public string ContentType => r.Headers.ContentType ?? "application/octet-stream";
        public long Length => r.ContentLength;
        public string? ETag => r.ETag;
        public ValueTask DisposeAsync() { r.Dispose(); return ValueTask.CompletedTask; }
    }
}
