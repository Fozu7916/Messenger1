using System.Collections.Concurrent;
using System.Net;
using System.Text.RegularExpressions;
using Messenger.Api.Email;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Messenger.Tests;

/// <summary>Запоминает «отправленные» письма, чтобы тест мог достать из них токен.</summary>
public sealed class CapturingEmailSender : IEmailSender
{
    private readonly ConcurrentQueue<(string To, string Subject, string Body)> _sent = new();

    public int CountTo(string to) => _sent.Count(m => m.To == to);

    public Task SendAsync(string to, string subject, string body, CancellationToken ct = default)
    {
        _sent.Enqueue((to, subject, body));
        return Task.CompletedTask;
    }

    /// <summary>Письма уходят в фоне, поэтому ждём до пяти секунд.</summary>
    public async Task<string> TokenAsync(string to, string subjectPart)
    {
        for (var i = 0; i < 100; i++)
        {
            foreach (var m in _sent)
            {
                if (m.To != to || !m.Subject.Contains(subjectPart)) continue;
                var match = Regex.Match(m.Body, "#token=([A-Za-z0-9_-]+)");
                if (match.Success) return match.Groups[1].Value;
            }
            await Task.Delay(50);
        }
        throw new TimeoutException($"Письмо «{subjectPart}» для {to} не пришло");
    }
}

[Collection(ApiCollection.Name)]
public sealed class RecoveryTests(ApiFactory factory)
{
    private const string Password = "Passw0rd!x";

    private static WebApplicationFactory<Program> With(ApiFactory f, CapturingEmailSender mail, bool requireConfirmed = false) =>
        f.WithWebHostBuilder(b =>
        {
            if (requireConfirmed) b.UseSetting("Auth:RequireConfirmedEmail", "true");
            b.ConfigureTestServices(s => { s.RemoveAll<IEmailSender>(); s.AddSingleton<IEmailSender>(mail); });
        });

    private static async Task<(string Login, string Email)> RegisterAsync(HttpClient http)
    {
        var login = "rec" + Guid.NewGuid().ToString("N")[..8];
        var email = $"{login}@test.local";
        var resp = await http.PostAsJsonAsync("/api/auth/register", new { login, email, password = Password, displayName = login });
        resp.EnsureSuccessStatusCode();
        return (login, email);
    }

    [Fact]
    public async Task Forgot_password_for_unknown_email_returns_204_and_sends_nothing()
    {
        var mail = new CapturingEmailSender();
        await using var app = With(factory, mail);
        using var http = app.CreateClient();
        var email = $"nobody{Guid.NewGuid():N}@test.local";

        var resp = await http.PostAsJsonAsync("/api/auth/forgot-password", new { email });
        await Task.Delay(300);

        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
        Assert.Equal(0, mail.CountTo(email));
    }

    [Fact]
    public async Task Reset_password_changes_password_and_token_is_single_use()
    {
        var mail = new CapturingEmailSender();
        await using var app = With(factory, mail);
        using var http = app.CreateClient();
        var (login, email) = await RegisterAsync(http);

        Assert.Equal(HttpStatusCode.NoContent, (await http.PostAsJsonAsync("/api/auth/forgot-password", new { email })).StatusCode);
        var token = await mail.TokenAsync(email, "Сброс");

        var reset = await http.PostAsJsonAsync("/api/auth/reset-password", new { token, newPassword = "NewPassw0rd!y" });
        Assert.Equal(HttpStatusCode.NoContent, reset.StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await http.PostAsJsonAsync("/api/auth/login", new { login, password = "NewPassw0rd!y" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await http.PostAsJsonAsync("/api/auth/login", new { login, password = Password })).StatusCode);

        var again = await http.PostAsJsonAsync("/api/auth/reset-password", new { token, newPassword = "Another1Passw0rd" });
        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);
    }

    [Fact]
    public async Task Weak_new_password_is_rejected_and_does_not_burn_the_token()
    {
        var mail = new CapturingEmailSender();
        await using var app = With(factory, mail);
        using var http = app.CreateClient();
        var (_, email) = await RegisterAsync(http);
        await http.PostAsJsonAsync("/api/auth/forgot-password", new { email });
        var token = await mail.TokenAsync(email, "Сброс");

        var weak = await http.PostAsJsonAsync("/api/auth/reset-password", new { token, newPassword = "onlyletters" });
        Assert.Equal(HttpStatusCode.BadRequest, weak.StatusCode);

        var ok = await http.PostAsJsonAsync("/api/auth/reset-password", new { token, newPassword = "GoodPassw0rd!" });
        Assert.Equal(HttpStatusCode.NoContent, ok.StatusCode);
    }

    [Fact]
    public async Task Unknown_reset_token_returns_400()
    {
        await using var app = With(factory, new CapturingEmailSender());
        using var http = app.CreateClient();

        var resp = await http.PostAsJsonAsync("/api/auth/reset-password",
            new { token = new string('a', 43), newPassword = "GoodPassw0rd!" });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task Register_rejects_password_without_digit()
    {
        await using var app = With(factory, new CapturingEmailSender());
        using var http = app.CreateClient();
        var login = "weak" + Guid.NewGuid().ToString("N")[..8];

        var resp = await http.PostAsJsonAsync("/api/auth/register",
            new { login, email = $"{login}@test.local", password = "onlyletters", displayName = login });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task Login_requires_confirmed_email_when_enabled()
    {
        var mail = new CapturingEmailSender();
        await using var app = With(factory, mail, requireConfirmed: true);
        using var http = app.CreateClient();
        var (login, email) = await RegisterAsync(http);

        var before = await http.PostAsJsonAsync("/api/auth/login", new { login, password = Password });
        Assert.Equal(HttpStatusCode.Forbidden, before.StatusCode);

        var token = await mail.TokenAsync(email, "Подтвердите");
        Assert.Equal(HttpStatusCode.NoContent, (await http.PostAsJsonAsync("/api/auth/confirm-email", new { token })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await http.PostAsJsonAsync("/api/auth/confirm-email", new { token })).StatusCode);

        var after = await http.PostAsJsonAsync("/api/auth/login", new { login, password = Password });
        Assert.Equal(HttpStatusCode.OK, after.StatusCode);
    }
}