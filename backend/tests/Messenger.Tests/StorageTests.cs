using Messenger.Api.Storage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Messenger.Tests;

/// <summary>Файловое хранилище: поведение без настроек и (по желанию) живая проверка против настоящего S3.</summary>
[Collection(ApiCollection.Name)]
public sealed class StorageTests(ApiFactory factory)
{
    [Theory]
    [InlineData("", "key", "secret", false)]
    [InlineData("bucket", "", "secret", false)]
    [InlineData("bucket", "key", "", false)]
    [InlineData("bucket", "key", "secret", true)]
    public void Options_are_configured_only_with_bucket_and_both_keys(string bucket, string key, string secret, bool expected) =>
        Assert.Equal(expected, new StorageOptions { Bucket = bucket, AccessKey = key, SecretKey = secret }.IsConfigured);

    [Fact]
    public async Task Disabled_storage_refuses_every_operation()
    {
        IFileStorage storage = new DisabledFileStorage();
        await Assert.ThrowsAsync<StorageNotConfiguredException>(() =>
            storage.PutAsync("avatars/x.png", new MemoryStream([1, 2, 3]), 3, "image/png"));
        Assert.Throws<StorageNotConfiguredException>(() => storage.GetDownloadUrl("avatars/x.png", TimeSpan.FromMinutes(1)));
    }

    /// <summary>
    /// Живая проверка круга «положить → прочитать → ссылка → удалить» против настоящего хранилища (MinIO локально или тестовый бакет Yandex).
    /// Запускается, только если заданы STORAGE_TEST_BUCKET, STORAGE_TEST_ACCESS_KEY, STORAGE_TEST_SECRET_KEY
    /// (и по необходимости STORAGE_TEST_ENDPOINT, STORAGE_TEST_REGION, STORAGE_TEST_PATH_STYLE=true); иначе тест тихо пропускается.
    /// </summary>
    [Fact]
    public async Task Live_roundtrip_against_a_real_bucket_when_configured()
    {
        string? Env(string n) => Environment.GetEnvironmentVariable(n);
        var options = new StorageOptions
        {
            Endpoint = Env("STORAGE_TEST_ENDPOINT") ?? "",
            Region = Env("STORAGE_TEST_REGION") ?? "us-east-1",
            Bucket = Env("STORAGE_TEST_BUCKET") ?? "",
            AccessKey = Env("STORAGE_TEST_ACCESS_KEY") ?? "",
            SecretKey = Env("STORAGE_TEST_SECRET_KEY") ?? "",
            ForcePathStyle = Env("STORAGE_TEST_PATH_STYLE") == "true",
            EnsureBucket = Env("STORAGE_TEST_PATH_STYLE") == "true",
        };
        if (!options.IsConfigured) return;

        using var storage = new S3FileStorage(options, NullLogger<S3FileStorage>.Instance);
        await storage.EnsureReadyAsync(CancellationToken.None);
        var key = $"tests/{Guid.NewGuid():N}.bin";
        byte[] data = [1, 2, 3, 4, 5, 250];
        try
        {
            await storage.PutAsync(key, new MemoryStream(data), data.Length, "application/octet-stream");

            await using (var file = await storage.GetAsync(key))
            {
                Assert.NotNull(file);
                Assert.Equal(data.Length, file!.Length);
                var back = new MemoryStream();
                await file.Content.CopyToAsync(back);
                Assert.Equal(data, back.ToArray());
            }
            Assert.StartsWith("http", storage.GetDownloadUrl(key, TimeSpan.FromMinutes(1)));
        }
        finally { await storage.DeleteAsync(key); }
        Assert.Null(await storage.GetAsync(key));
    }
}
