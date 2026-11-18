namespace Messenger.Api.Storage;

/// <summary>
/// Настройки S3-совместимого хранилища (секция "Storage", env: Storage__Bucket и т. д.).
/// Код работает с Yandex Object Storage (прод), AWS S3, Cloudflare R2 и другими S3-совместимыми хранилищами. Локально хранилище не поднимается: без настроек файловые функции отвечают 503.
/// </summary>
public sealed class StorageOptions
{
    /// <summary>Адрес API хранилища. Yandex: https://storage.yandexcloud.net. Пусто — AWS по Region.</summary>
    public string Endpoint { get; set; } = "";
    /// <summary>Регион для подписи запросов. Yandex: ru-central1.</summary>
    public string Region { get; set; } = "us-east-1";
    public string Bucket { get; set; } = "";
    public string AccessKey { get; set; } = "";
    public string SecretKey { get; set; } = "";
    /// <summary>true — адрес вида host/bucket/key, false — bucket.host/key (Yandex и AWS).</summary>
    public bool ForcePathStyle { get; set; }
    /// <summary>Создать бакет при старте, если его нет. Нужно только для собственного тестового хранилища: в проде бакет создаётся в консоли.</summary>
    public bool EnsureBucket { get; set; }

    /// <summary>Хранилище считается подключённым, только если заданы бакет и оба ключа; иначе файловые функции отвечают 503.</summary>
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(Bucket) && !string.IsNullOrWhiteSpace(AccessKey) && !string.IsNullOrWhiteSpace(SecretKey);
}
