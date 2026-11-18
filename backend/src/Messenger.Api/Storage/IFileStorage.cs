namespace Messenger.Api.Storage;

/// <summary>Файл, прочитанный из хранилища. Поток нужно освободить (DisposeAsync), иначе соединение останется занятым.</summary>
public interface IStoredFile : IAsyncDisposable
{
    Stream Content { get; }
    string ContentType { get; }
    long Length { get; }
    string? ETag { get; }
}

/// <summary>Хранилище файлов (аватарки, обои, голосовые, фото). Ключи — вида "avatars/{userId}/{ulid}.webp".</summary>
public interface IFileStorage
{
    /// <summary>Кладёт файл. length — точный размер потока в байтах (S3 нужен размер заранее).</summary>
    Task PutAsync(string key, Stream content, long length, string contentType, CancellationToken ct = default);

    /// <summary>Читает файл; null, если ключа нет.</summary>
    Task<IStoredFile?> GetAsync(string key, CancellationToken ct = default);

    /// <summary>Удаляет файл; отсутствие ключа — не ошибка.</summary>
    Task DeleteAsync(string key, CancellationToken ct = default);

    /// <summary>Копия объекта на стороне хранилища (без скачивания); бросает исключение, если исходного нет.</summary>
    Task CopyAsync(string sourceKey, string destinationKey, CancellationToken ct = default);

    /// <summary>Ключи с данным префиксом (не больше max).</summary>
    Task<IReadOnlyList<string>> ListAsync(string prefix, int max, CancellationToken ct = default);
}

/// <summary>Хранилище не настроено (не заданы Storage__Bucket, Storage__AccessKey, Storage__SecretKey).</summary>
public sealed class StorageNotConfiguredException()
    : InvalidOperationException("File storage is not configured (env: Storage__Bucket, Storage__AccessKey, Storage__SecretKey).");

/// <summary>Заглушка для окружений без хранилища: приложение работает, а любая файловая операция бросает StorageNotConfiguredException.</summary>
public sealed class DisabledFileStorage : IFileStorage
{
    public Task PutAsync(string key, Stream content, long length, string contentType, CancellationToken ct = default) => throw new StorageNotConfiguredException();
    public Task<IStoredFile?> GetAsync(string key, CancellationToken ct = default) => throw new StorageNotConfiguredException();
    public Task DeleteAsync(string key, CancellationToken ct = default) => throw new StorageNotConfiguredException();
    public Task CopyAsync(string sourceKey, string destinationKey, CancellationToken ct = default) => throw new StorageNotConfiguredException();
    public Task<IReadOnlyList<string>> ListAsync(string prefix, int max, CancellationToken ct = default) => throw new StorageNotConfiguredException();
}
