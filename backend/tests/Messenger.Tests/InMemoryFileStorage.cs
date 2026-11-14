using System.Collections.Concurrent;
using Messenger.Api.Storage;

namespace Messenger.Tests;

/// <summary>Хранилище в памяти для тестов API: настоящий S3 нужен только живому тесту в StorageTests.</summary>
public sealed class InMemoryFileStorage : IFileStorage
{
    private readonly ConcurrentDictionary<string, (byte[] Data, string ContentType)> _files = new();

    public bool Contains(string key) => _files.ContainsKey(key);

    public async Task PutAsync(string key, Stream content, long length, string contentType, CancellationToken ct = default)
    {
        var ms = new MemoryStream();
        await content.CopyToAsync(ms, ct);
        _files[key] = (ms.ToArray(), contentType);
    }

    public Task<IStoredFile?> GetAsync(string key, CancellationToken ct = default) =>
        Task.FromResult<IStoredFile?>(_files.TryGetValue(key, out var f) ? new File(f.Data, f.ContentType, key) : null);

    public Task DeleteAsync(string key, CancellationToken ct = default) { _files.TryRemove(key, out _); return Task.CompletedTask; }

    public Task CopyAsync(string sourceKey, string destinationKey, CancellationToken ct = default)
    {
        if (!_files.TryGetValue(sourceKey, out var f)) throw new FileNotFoundException(sourceKey);
        _files[destinationKey] = f;
        return Task.CompletedTask;
    }

    public Task<long?> SizeAsync(string key, CancellationToken ct = default) =>
        Task.FromResult<long?>(_files.TryGetValue(key, out var f) ? f.Data.Length : null);

    public Task<byte[]?> ReadStartAsync(string key, int count, CancellationToken ct = default) =>
        Task.FromResult<byte[]?>(_files.TryGetValue(key, out var f) ? f.Data.Take(count).ToArray() : null);

    public string GetUploadUrl(string key, string contentType, TimeSpan ttl) => "http://test.local/upload/" + key;

    /// <summary>Имитация шага 2: клиент загрузил файл в хранилище по временной ссылке.</summary>
    public void Seed(string key, byte[] data, string contentType = "video/mp4") => _files[key] = (data, contentType);

    public Task<IReadOnlyList<string>> ListAsync(string prefix, int max, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<string>>(_files.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)).OrderBy(k => k).Take(max).ToList());

    public string GetDownloadUrl(string key, TimeSpan ttl) => "http://test.local/" + key;

    private sealed class File(byte[] data, string contentType, string key) : IStoredFile
    {
        public Stream Content { get; } = new MemoryStream(data);
        public string ContentType => contentType;
        public long Length => data.Length;
        public string? ETag => Convert.ToHexString(System.Security.Cryptography.MD5.HashData(data)) + key.Length;
        public ValueTask DisposeAsync() => Content.DisposeAsync();
    }
}
