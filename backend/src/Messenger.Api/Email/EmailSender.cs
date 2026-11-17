using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Mail;
using Microsoft.Extensions.Options;

namespace Messenger.Api.Email;

public sealed class SmtpOptions
{
    public string Host { get; set; } = "";
    /// <summary>587 + STARTTLS. Неявный SSL на 465 стандартный SmtpClient не поддерживает.</summary>
    public int Port { get; set; } = 587;
    public bool UseSsl { get; set; } = true;
    public string User { get; set; } = "";
    public string Password { get; set; } = "";
    public string From { get; set; } = "";
    public string FromName { get; set; } = "Messenger";
}

public sealed class ResendOptions
{
    public string ApiKey { get; set; } = "";
    /// <summary>Адрес на домене, подтверждённом в Resend (например, no-reply@fozu-dev.site).</summary>
    public string From { get; set; } = "";
    public string FromName { get; set; } = "Messenger";
}

public interface IEmailSender
{
    Task SendAsync(string to, string subject, string body, CancellationToken ct = default);
}

public sealed class SmtpEmailSender(IOptions<SmtpOptions> options) : IEmailSender
{
    public async Task SendAsync(string to, string subject, string body, CancellationToken ct = default)
    {
        var o = options.Value;
        using var msg = new MailMessage { From = new MailAddress(o.From, o.FromName), Subject = subject, Body = body, IsBodyHtml = false };
        msg.To.Add(to);
        using var client = new SmtpClient(o.Host, o.Port)
        {
            EnableSsl = o.UseSsl,
            Credentials = string.IsNullOrEmpty(o.User) ? null : new NetworkCredential(o.User, o.Password),
        };
        await client.SendMailAsync(msg, ct);
    }
}

/// <summary>Отправка через HTTPS-API Resend (порт 443). Работает и на бесплатном Render, где SMTP-порты закрыты.</summary>
public sealed class ResendEmailSender(HttpClient http, IOptions<ResendOptions> options) : IEmailSender
{
    public async Task SendAsync(string to, string subject, string body, CancellationToken ct = default)
    {
        var o = options.Value;
        using var req = new HttpRequestMessage(HttpMethod.Post, "https://api.resend.com/emails")
        {
            Content = JsonContent.Create(new { from = $"{o.FromName} <{o.From}>", to = new[] { to }, subject, text = body }),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", o.ApiKey);
        req.Headers.UserAgent.ParseAdd("messenger-api/1.0");
        using var res = await http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
            throw new HttpRequestException($"Resend вернул {(int)res.StatusCode}: {await res.Content.ReadAsStringAsync(ct)}");
    }
}

/// <summary>Без SMTP: в разработке пишет письмо в лог (там видна ссылка), в проде — только предупреждение, без тела (в нём токен).</summary>
public sealed class LogEmailSender(ILogger<LogEmailSender> log, IHostEnvironment env) : IEmailSender
{
    public Task SendAsync(string to, string subject, string body, CancellationToken ct = default)
    {
        if (env.IsDevelopment() || env.EnvironmentName == "Testing")
            log.LogInformation("Email (SMTP не настроен) to {To}: {Subject}\n{Body}", to, subject, body);
        else
            log.LogWarning("Почта не настроена (Resend:ApiKey или Smtp:Host): письмо «{Subject}» не отправлено", subject);
        return Task.CompletedTask;
    }
}
