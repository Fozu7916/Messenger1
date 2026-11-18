using Messenger.Api.Contracts;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace Messenger.Tests;

/// <summary>Хаб: «прочитано» (MarkRead), присутствие (GetOnlineContacts, GetLastSeen, PresenceChanged).</summary>
[Collection(ApiCollection.Name)]
public sealed class ReadAndPresenceTests(ApiFactory factory)
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private async Task<(TestUser Alice, TestUser Bob, DialogDto Dialog)> TwoUsersAsync()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        return (alice, bob, await alice.CreateDialogAsync(bob));
    }

    // ---------- MarkRead ----------

    [Fact]
    public async Task MarkRead_notifies_members_and_updates_unread_and_peer_read_marker()
    {
        var (alice, bob, dialog) = await TwoUsersAsync();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        var read = new TaskCompletionSource<(string Dialog, string Reader, string UpTo)>();
        aliceHub.On<string, string, string>("MessagesRead", (d, r, u) => read.TrySetResult((d, r, u)));
        await aliceHub.StartAsync();
        var last = await aliceHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "раз");

        var bobDialogs = await bob.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        Assert.Equal(1, bobDialogs!.Single().UnreadCount);

        await using var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();
        await bobHub.InvokeAsync("MarkRead", dialog.Id, last);

        var ev = await read.Task.WaitAsync(Timeout);
        Assert.Equal((dialog.Id, bob.User.Id, last), ev);

        bobDialogs = await bob.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        Assert.Equal(0, bobDialogs!.Single().UnreadCount);
        var aliceDialogs = await alice.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        Assert.Equal(last, aliceDialogs!.Single().PeerLastReadId);
    }

    [Fact]
    public async Task MarkRead_with_a_future_id_is_clamped_to_the_latest_existing_message()
    {
        var (alice, bob, dialog) = await TwoUsersAsync();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        await aliceHub.StartAsync();
        await aliceHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "раз");
        var last = await aliceHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "два");

        var read = new TaskCompletionSource<string>();
        await using var bobHub = factory.ConnectHub(bob.Token);
        bobHub.On<string, string, string>("MessagesRead", (_, _, u) => read.TrySetResult(u));
        await bobHub.StartAsync();
        await bobHub.InvokeAsync("MarkRead", dialog.Id, "7ZZZZZZZZZZZZZZZZZZZZZZZZZ");

        Assert.Equal(last, await read.Task.WaitAsync(Timeout));
    }

    [Fact]
    public async Task MarkRead_never_moves_the_marker_backwards()
    {
        var (alice, bob, dialog) = await TwoUsersAsync();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        await aliceHub.StartAsync();
        var first = await aliceHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "раз");
        var second = await aliceHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "два");

        await using var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();
        await bobHub.InvokeAsync("MarkRead", dialog.Id, second);
        await bobHub.InvokeAsync("MarkRead", dialog.Id, first);

        var dialogs = await alice.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        Assert.Equal(second, dialogs!.Single().PeerLastReadId);
    }

    [Fact]
    public async Task MarkRead_rejects_a_stranger_and_a_malformed_id()
    {
        var (_, bob, dialog) = await TwoUsersAsync();
        var carol = await factory.RegisterAsync("carol");

        await using var carolHub = factory.ConnectHub(carol.Token);
        await carolHub.StartAsync();
        var forbidden = await Assert.ThrowsAsync<HubException>(() => carolHub.InvokeAsync("MarkRead", dialog.Id, Ulid.NewUlid().ToString()));
        Assert.Contains("forbidden", forbidden.Message);

        await using var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();
        var invalid = await Assert.ThrowsAsync<HubException>(() => bobHub.InvokeAsync("MarkRead", dialog.Id, "не-ulid"));
        Assert.Contains("invalid_message_id", invalid.Message);
    }

    // ---------- Присутствие ----------

    [Fact]
    public async Task GetOnlineContacts_lists_only_connected_peers()
    {
        var (alice, bob, _) = await TwoUsersAsync();
        var bobOnline = new TaskCompletionSource<bool>();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        aliceHub.On<string, string, DateTime?>("PresenceChanged", (_, s, _) => { if (s == "online") bobOnline.TrySetResult(true); });
        await aliceHub.StartAsync();

        Assert.Empty(await aliceHub.InvokeAsync<List<string>>("GetOnlineContacts"));

        await using var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();
        await bobOnline.Task.WaitAsync(Timeout);   // ждём событие, а не опрашиваем: у метода есть лимит вызовов

        Assert.Equal([bob.User.Id], await aliceHub.InvokeAsync<List<string>>("GetOnlineContacts"));
    }

    [Fact]
    public async Task GetOnlineContacts_ignores_users_without_a_shared_dialog()
    {
        var alice = await factory.RegisterAsync("alice");
        var stranger = await factory.RegisterAsync("stranger");
        await using var aliceHub = factory.ConnectHub(alice.Token);
        await aliceHub.StartAsync();
        await using var strangerHub = factory.ConnectHub(stranger.Token);
        await strangerHub.StartAsync();

        await Task.Delay(300);
        Assert.Empty(await aliceHub.InvokeAsync<List<string>>("GetOnlineContacts"));
    }

    [Fact]
    public async Task PresenceChanged_is_sent_on_connect_and_on_disconnect_with_last_seen()
    {
        var (alice, bob, _) = await TwoUsersAsync();
        var events = new System.Collections.Concurrent.BlockingCollection<(string User, string Status, DateTime? LastSeen)>();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        aliceHub.On<string, string, DateTime?>("PresenceChanged", (u, s, l) => events.Add((u, s, l)));
        await aliceHub.StartAsync();

        var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();
        Assert.True(events.TryTake(out var online, Timeout), "online не пришёл");
        Assert.Equal((bob.User.Id, "online"), (online.User, online.Status));

        await bobHub.StopAsync();
        await bobHub.DisposeAsync();
        Assert.True(events.TryTake(out var offline, Timeout), "offline не пришёл");
        Assert.Equal((bob.User.Id, "offline"), (offline.User, offline.Status));
        Assert.NotNull(offline.LastSeen);
    }

    [Fact]
    public async Task GetLastSeen_returns_the_time_for_a_peer_who_went_offline()
    {
        var (alice, bob, _) = await TwoUsersAsync();
        var bobOffline = new TaskCompletionSource<bool>();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        aliceHub.On<string, string, DateTime?>("PresenceChanged", (_, s, _) => { if (s == "offline") bobOffline.TrySetResult(true); });
        await aliceHub.StartAsync();

        Assert.Empty(await aliceHub.InvokeAsync<Dictionary<string, DateTime>>("GetLastSeen"));   // bob ещё ни разу не был в сети

        var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();
        await bobHub.StopAsync();
        await bobHub.DisposeAsync();
        await bobOffline.Task.WaitAsync(Timeout);   // событие приходит после записи last_seen_at в БД

        var seen = await aliceHub.InvokeAsync<Dictionary<string, DateTime>>("GetLastSeen");
        Assert.True(seen.ContainsKey(bob.User.Id));
        Assert.InRange(seen[bob.User.Id], DateTime.UtcNow.AddMinutes(-1), DateTime.UtcNow.AddMinutes(1));
    }
}
