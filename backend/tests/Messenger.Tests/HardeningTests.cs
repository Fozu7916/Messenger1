using System.Net;
using Messenger.Api.Contracts;
using Microsoft.AspNetCore.SignalR.Client;

namespace Messenger.Tests;

/// <summary>Аватар, регистрация (email/пароль/имя), заголовки безопасности, «был(а) в сети».</summary>
[Collection(ApiCollection.Name)]
public sealed class HardeningTests(ApiFactory factory)
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Theory]
    [InlineData("http://example.com/a.png")]
    [InlineData("https://localhost/a.png")]
    [InlineData("https://169.254.169.254/x")]
    [InlineData("https://u:p@example.com/a.png")]
    public async Task Profile_rejects_unsafe_avatar_url(string url)
    {
        var u = await factory.RegisterAsync("ava");
        var resp = await u.Http.PutAsJsonAsync("/api/users/me", new { displayName = "x", avatarUrl = url });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task Profile_accepts_https_avatar_and_clears_it()
    {
        var u = await factory.RegisterAsync("ava");
        var ok = await u.Http.PutAsJsonAsync("/api/users/me", new { displayName = "x", avatarUrl = "https://example.com/a.png" });
        Assert.Equal("https://example.com/a.png", (await ok.Content.ReadFromJsonAsync<UserDto>())!.AvatarUrl);

        var cleared = await u.Http.PutAsJsonAsync("/api/users/me", new { displayName = "x", avatarUrl = "" });
        Assert.Null((await cleared.Content.ReadFromJsonAsync<UserDto>())!.AvatarUrl);
    }

    [Theory]
    [InlineData("s@1.1")]
    [InlineData("a@b")]
    [InlineData("a b@example.com")]
    [InlineData("a@@example.com")]
    public async Task Register_rejects_invalid_email(string email)
    {
        var login = "u" + Guid.NewGuid().ToString("N")[..8];
        var resp = await factory.CreateClient().PostAsJsonAsync("/api/auth/register", new { login, email, password = "Passw0rd!x" });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task Register_without_display_name_succeeds_and_falls_back_to_login()
    {
        var login = "u" + Guid.NewGuid().ToString("N")[..8];
        var resp = await factory.CreateClient().PostAsJsonAsync("/api/auth/register",
            new { login, email = $"{login}@example.com", password = "Passw0rd!x" });
        resp.EnsureSuccessStatusCode();
        var auth = (await resp.Content.ReadFromJsonAsync<AuthResponse>())!;
        Assert.False(string.IsNullOrWhiteSpace(auth.User.DisplayName));
    }

    [Fact]
    public async Task Register_rejects_password_over_72_bytes()
    {
        var login = "u" + Guid.NewGuid().ToString("N")[..8];
        var resp = await factory.CreateClient().PostAsJsonAsync("/api/auth/register",
            new { login, email = $"{login}@example.com", password = new string('ж', 40) });   // 40 символов = 80 байт
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task Responses_carry_security_headers()
    {
        var resp = await factory.CreateClient().GetAsync("/health");
        Assert.Equal("nosniff", resp.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("DENY", resp.Headers.GetValues("X-Frame-Options").Single());
        Assert.Contains("default-src 'self'", resp.Headers.GetValues("Content-Security-Policy").Single());
    }

    [Fact]
    public async Task Last_seen_is_sent_on_disconnect_and_returned_for_offline_contacts()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        await alice.CreateDialogAsync(bob);

        var offline = new TaskCompletionSource<(string User, string Status, DateTime? At)>();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        aliceHub.On<string, string, DateTime?>("PresenceChanged", (u, s, at) => { if (s == "offline") offline.TrySetResult((u, s, at)); });
        await aliceHub.StartAsync();

        var before = DateTime.UtcNow.AddSeconds(-1);
        var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();
        await bobHub.StopAsync();
        await bobHub.DisposeAsync();

        var evt = await offline.Task.WaitAsync(Timeout);
        Assert.Equal(bob.User.Id, evt.User);
        Assert.NotNull(evt.At);
        Assert.True(evt.At >= before);

        var seen = await aliceHub.InvokeAsync<Dictionary<string, DateTime>>("GetLastSeen");
        Assert.True(seen.ContainsKey(bob.User.Id));
    }

    [Fact]
    public async Task Last_seen_is_not_returned_for_online_contacts_or_strangers()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var stranger = await factory.RegisterAsync("eve");
        await alice.CreateDialogAsync(bob);

        await using var strangerHub = factory.ConnectHub(stranger.Token);
        await strangerHub.StartAsync();
        await strangerHub.StopAsync();   // у stranger появится last_seen, но с alice нет диалога

        await using var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        await aliceHub.StartAsync();

        var seen = await aliceHub.InvokeAsync<Dictionary<string, DateTime>>("GetLastSeen");
        Assert.DoesNotContain(bob.User.Id, seen.Keys);
        Assert.DoesNotContain(stranger.User.Id, seen.Keys);
    }
}
