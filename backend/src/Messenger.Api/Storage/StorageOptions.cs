namespace Messenger.Api.Storage;

/// <summary>
/// Настройки S3-совместимого хранилища (секция "Storage", env: Storage__Bucket и т. д.).
/// Один и тот же код работает с Yandex Object Storage (прод), MinIO (локально), AWS S3, Cloudflare R2 и т. п.
/// </summary>
public sealed class StorageOptions
{
    /// <summary>Адрес API хранилища. Yandex: https://storage.yandexcloud.net, MinIO: http://localhost:9000. Пусто — AWS по Region.</summary>
    public string Endpoint { get; set; } = "";
    /// <summary>Регион для подписи запросов. Yandex: ru-central1, MinIO: любой (us-east-1).</summary>
    public string Region { get; set; } = "us-east-1";
    public string Bucket { get; set; } = "";
    public string AccessKey { get; set; } = "";
    public string SecretKey { get; set; } = "";
    /// <summary>true — адрес вида host/bucket/key (нужен MinIO), false — bucket.host/key (Yandex и AWS).</summary>
    public bool ForcePathStyle { get; set; }
    /// <summary>Создать бакет при старте, если его нет. Только для локальной разработки: в проде бакет создаётся в консоли.</summary>
    public bool EnsureBucket { get; set; }

    /// <summary>Хранилище считается подключённым, только если заданы бакет и оба ключа; иначе файловые функции отвечают 503.</summary>
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(Bucket) && !string.IsNullOrWhiteSpace(AccessKey) && !string.IsNullOrWhiteSpace(SecretKey);
}
