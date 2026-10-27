using System.Net;
using System.Net.Http.Json;
using Messenger.Api.Contracts;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace Messenger.Tests;

/// <summary>Refresh-токены, блокировка перебора пароля, лимиты хаба, дубли диалогов.</summary>
[Collection(ApiCollection.Name)]
public sealed class SecurityTests(ApiFactory factory)
{
    private static string? RefreshCookie(HttpResponseMessage r) =>
        r.Headers.TryGetValues("Set-Cookie", out var v)
            ? v.FirstOrDefault(c => c.StartsWith("rt="))?.Split(';')[0]
            : null;

    private async Task<(string Login, string Cookie)> RegisterRawAsync()
    {
        var login = "rt" + Guid.NewGuid().ToString("N")[..8];
        var client = factory.CreateClient(new() { HandleCookies = false });
        var resp = await client.PostAsJsonAsync("/api/auth/register", new { login, email = $"{login}@test.local", password = "Passw0rd!x" });
        resp.EnsureSuccessStatusCode();
        return (login, RefreshCookie(resp)!);
    }

    private static HttpRequestMessage RefreshRequest(string cookie, bool xhr = true)
    {
        var m = new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh");
        m.Headers.Add("Cookie", cookie);
        if (xhr) m.Headers.Add("X-Requested-With", "fetch");
        return m;
    }

    [Fact]
    public async Task Register_sets_httponly_refresh_cookie()
    {
        var login = "rt" + Guid.NewGuid().ToString("N")[..8];
        var resp = await factory.CreateClient().PostAsJsonAsync("/api/auth/register", new { login, email = $"{login}@test.local", password = "Passw0rd!x" });
        var cookie = resp.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith("rt="));
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("path=/api/auth", cookie, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Refresh_rotates_token_and_returns_working_access_token()
    {
        var (_, cookie) = await RegisterRawAsync();
        var client = factory.CreateClient(new() { HandleCookies = false });

        var resp = await client.SendAsync(RefreshRequest(cookie));
        resp.EnsureSuccessStatusCode();
        var auth = (await resp.Content.ReadFromJsonAsync<AuthResponse>())!;
        Assert.NotEqual(cookie, RefreshCookie(resp));

        var api = factory.CreateClient();
        api.DefaultRequestHeaders.Authorization = new("Bearer", auth.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await api.GetAsync("/api/users/me")).StatusCode);
    }

    [Fact]
    public async Task Refresh_requires_csrf_header_and_cookie()
    {
        var (_, cookie) = await RegisterRawAsync();
        var client = factory.CreateClient(new() { HandleCookies = false });
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(RefreshRequest(cookie, xhr: false))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(RefreshRequest("rt=garbage"))).StatusCode);
    }

    [Fact]
    public async Task Reusing_a_rotated_refresh_token_revokes_the_whole_session()
    {
        var (_, cookie) = await RegisterRawAsync();
        var client = factory.CreateClient(new() { HandleCookies = false });

        var first = await client.SendAsync(RefreshRequest(cookie));
        first.EnsureSuccessStatusCode();
        var newer = RefreshCookie(first)!;

        // старый токен предъявлен повторно → кража: 401 и все токены отозваны
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(RefreshRequest(cookie))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(RefreshRequest(newer))).StatusCode);
    }

    [Fact]
    public async Task Logout_revokes_refresh_token()
    {
        var (_, cookie) = await RegisterRawAsync();
        var client = factory.CreateClient(new() { HandleCookies = false });

        var logout = new HttpRequestMessage(HttpMethod.Post, "/api/auth/logout");
        logout.Headers.Add("Cookie", cookie);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(logout)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(RefreshRequest(cookie))).StatusCode);
    }

    [Fact]
    public async Task Repeated_wrong_passwords_lock_the_account_even_for_correct_password()
    {
        var (login, _) = await RegisterRawAsync();
        var client = factory.CreateClient();
        for (var i = 0; i < 10; i++)
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await client.PostAsJsonAsync("/api/auth/login", new { login, password = "wrong-password" })).StatusCode);

        var blocked = await client.PostAsJsonAsync("/api/auth/login", new { login, password = "Passw0rd!x" });
        Assert.Equal(HttpStatusCode.TooManyRequests, blocked.StatusCode);
        Assert.True(blocked.Headers.Contains("Retry-After"));
    }

    [Fact]
    public async Task Successful_login_resets_failure_counter()
    {
        var (login, _) = await RegisterRawAsync();
        var client = factory.CreateClient();
        for (var i = 0; i < 5; i++) await client.PostAsJsonAsync("/api/auth/login", new { login, password = "wrong-password" });
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/auth/login", new { login, password = "Passw0rd!x" })).StatusCode);
        for (var i = 0; i < 9; i++) await client.PostAsJsonAsync("/api/auth/login", new { login, password = "wrong-password" });
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/auth/login", new { login, password = "Passw0rd!x" })).StatusCode);
    }

    [Fact]
    public async Task Hub_rejects_message_flood()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);
        await using var hub = factory.ConnectHub(alice.Token);
        await hub.StartAsync();

        var ex = await Assert.ThrowsAsync<HubException>(async () =>
        {
            for (var i = 0; i < 40; i++)
                await hub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "spam " + i);
        });
        Assert.Contains("rate_limited", ex.Message);
    }

    [Fact]
    public async Task Concurrent_dialog_creation_yields_a_single_dialog()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");

        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            var r = await alice.Http.PostAsJsonAsync("/api/dialogs", new { userId = bob.User.Id });
            r.EnsureSuccessStatusCode();
            return (await r.Content.ReadFromJsonAsync<DialogDto>())!.Id;
        }));

        Assert.Single(results.Distinct());
        var list = await alice.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        Assert.Single(list!, d => d.Peer?.Id == bob.User.Id);
        // из другой стороны тот же диалог
        Assert.Equal(results[0], (await bob.CreateDialogAsync(alice)).Id);
    }
}
