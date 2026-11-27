using System.Threading.Channels;

namespace Messenger.Api.Email;

public sealed record EmailJob(string To, string Subject, string Body);

public interface IEmailQueue
{
    void Enqueue(string to, string subject, string body);
}

public sealed class EmailQueue(ILogger<EmailQueue> log) : IEmailQueue
{
    private readonly Channel<EmailJob> _channel = Channel.CreateBounded<EmailJob>(
        new BoundedChannelOptions(500) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });

    public ChannelReader<EmailJob> Reader => _channel.Reader;

    public void Enqueue(string to, string subject, string body)
    {
        if (!_channel.Writer.TryWrite(new EmailJob(to, subject, body)))
            log.LogWarning("Очередь писем переполнена, письмо «{Subject}» отброшено", subject);
    }
}

public sealed class EmailQueueWorker(EmailQueue queue, IServiceScopeFactory scopes, ILogger<EmailQueueWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var job in queue.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                var sender = scope.ServiceProvider.GetRequiredService<IEmailSender>();
                await sender.SendAsync(job.To, job.Subject, job.Body, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Не удалось отправить письмо «{Subject}»", job.Subject);
            }
        }
    }
}