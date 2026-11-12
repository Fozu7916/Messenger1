namespace Messenger.Api.Storage;

public static class StorageExtensions
{
    /// <summary>
    /// Подключает файловое хранилище. Без настроек (Storage__Bucket/AccessKey/SecretKey) регистрируется заглушка:
    /// приложение стартует и без хранилища, а файловые эндпоинты отвечают 503.
    /// </summary>
    public static IServiceCollection AddFileStorage(this IServiceCollection services, IConfiguration config)
    {
        var options = config.GetSection("Storage").Get<StorageOptions>() ?? new StorageOptions();
        services.AddSingleton(options);
        if (!options.IsConfigured)
        {
            services.AddSingleton<IFileStorage, DisabledFileStorage>();
            return services;
        }
        services.AddSingleton<S3FileStorage>();
        services.AddSingleton<IFileStorage>(sp => sp.GetRequiredService<S3FileStorage>());
        services.AddHostedService<StorageStartupCheck>();
        return services;
    }
}

/// <summary>Один раз при старте проверяет доступ к бакету и пишет результат в лог. Ошибка не останавливает приложение.</summary>
public sealed class StorageStartupCheck(S3FileStorage storage, StorageOptions options, ILogger<StorageStartupCheck> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await storage.EnsureReadyAsync(stoppingToken);
            log.LogInformation("Storage is ready: bucket {Bucket} at {Endpoint}", options.Bucket, string.IsNullOrEmpty(options.Endpoint) ? "AWS " + options.Region : options.Endpoint);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Storage check failed for bucket {Bucket}: проверьте Storage__Endpoint, Storage__Region, ключи и права на бакет", options.Bucket);
        }
    }
}
