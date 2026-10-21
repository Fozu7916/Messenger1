using System.Net;
using Messenger.Api.Contracts;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.SignalR;

namespace Messenger.Tests;

/// <summary>Список людей, редактирование, «прочитано», поиск по сообщениям, список онлайн.</summary>
[Collection(ApiCollection.Name)]
public sealed class FeatureTests(ApiFactory factory)
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task People_list_without_query_returns_other_users_and_supports_paging()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");

        var all = await alice.Http.GetFromJsonAsync<List<UserDto>>("/api/users?limit=100");
        var second = await alice.Http.GetFromJsonAsync<List<UserDto>>("/api/users?limit=1&offset=1");

        Assert.Contains(all!, u => u.Id == bob.User.Id);
        Assert.Contains(all!, u => u.Id == carol.User.Id);
        Assert.DoesNotContain(all!, u => u.Id == alice.User.Id);
        Assert.Single(second!);
        Assert.Equal(all![1].Id, second![0].Id);
    }

    [Fact]
    public async Task Only_sender_can_edit_message_and_peer_receives_event()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);

        var edited = new TaskCompletionSource<MessageDto>();
        await using var bobHub = factory.ConnectHub(bob.Token);
        bobHub.On<MessageDto>("MessageEdited", m => { edited.TrySetResult(m); });
        await bobHub.StartAsync();

        await using var aliceHub = factory.ConnectHub(alice.Token);
        await aliceHub.StartAsync();
        var id = await aliceHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "helo");

        var byBob = await bob.Http.PutAsJsonAsync($"/api/messages/{id}", new { text = "hacked" });
        var byAlice = await alice.Http.PutAsJsonAsync($"/api/messages/{id}", new { text = "hello" });

        Assert.Equal(HttpStatusCode.NotFound, byBob.StatusCode);
        Assert.Equal(HttpStatusCode.OK, byAlice.StatusCode);

        var evt = await edited.Task.WaitAsync(Timeout);
        Assert.Equal("hello", evt.Text);
        Assert.NotNull(evt.EditedAt);

        var history = await bob.Http.GetFromJsonAsync<List<MessageDto>>($"/api/dialogs/{dialog.Id}/messages");
        Assert.Equal("hello", history!.Single().Text);
        Assert.NotNull(history!.Single().EditedAt);
    }

    [Fact]
    public async Task MarkRead_reduces_unread_count_and_tells_the_sender()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);

        var read = new TaskCompletionSource<(string Dialog, string Reader, string UpTo)>();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        aliceHub.On<string, string, string>("MessagesRead", (d, r, u) => { read.TrySetResult((d, r, u)); });
        await aliceHub.StartAsync();

        var ids = new List<string>();
        foreach (var text in new[] { "one", "two" })
            ids.Add(await aliceHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, text));

        var before = await bob.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        Assert.Equal(2, before!.Single(d => d.Id == dialog.Id).UnreadCount);

        await using var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();
        await bobHub.InvokeAsync("MarkRead", dialog.Id, ids[0]);

        var evt = await read.Task.WaitAsync(Timeout);
        Assert.Equal(bob.User.Id, evt.Reader);
        Assert.Equal(ids[0], evt.UpTo);

        var middle = await bob.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        Assert.Equal(1, middle!.Single(d => d.Id == dialog.Id).UnreadCount);
        var seenByAlice = await alice.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        Assert.Equal(ids[0], seenByAlice!.Single(d => d.Id == dialog.Id).PeerLastReadId);

        await bobHub.InvokeAsync("MarkRead", dialog.Id, ids[1]);
        var after = await bob.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        Assert.Equal(0, after!.Single(d => d.Id == dialog.Id).UnreadCount);
    }

    [Fact]
    public async Task Stranger_cannot_mark_foreign_dialog_as_read()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        var dialog = await alice.CreateDialogAsync(bob);
        await using var hub = factory.ConnectHub(carol.Token);
        await hub.StartAsync();

        await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync("MarkRead", dialog.Id, Ulid.NewUlid().ToString()));
    }

    [Fact]
    public async Task Message_search_is_limited_to_own_dialogs_and_escapes_wildcards()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        var ab = await alice.CreateDialogAsync(bob);
        var bc = await bob.CreateDialogAsync(carol);

        await using var aliceHub = factory.ConnectHub(alice.Token);
        await aliceHub.StartAsync();
        await aliceHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), ab.Id, "Hello World");
        await aliceHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), ab.Id, "abc");

        await using var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();
        await bobHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), bc.Id, "hello from bob and carol");

        var hits = await alice.Http.GetFromJsonAsync<List<MessageDto>>("/api/messages/search?q=hello");
        var wildcard = await alice.Http.GetFromJsonAsync<List<MessageDto>>($"/api/messages/search?q={Uri.EscapeDataString("a%c")}");
        var tooShort = await alice.Http.GetAsync("/api/messages/search?q=h");

        Assert.Equal("Hello World", hits!.Single().Text);   // без учёта регистра, чужой диалог не виден
        Assert.Empty(wildcard!);                            // % — не маска
        Assert.Equal(HttpStatusCode.BadRequest, tooShort.StatusCode);
    }

    [Fact]
    public async Task GetOnlineContacts_returns_connected_peers_only()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        await alice.CreateDialogAsync(bob);
        await alice.CreateDialogAsync(carol);

        await using var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        await aliceHub.StartAsync();

        var online = await aliceHub.InvokeAsync<List<string>>("GetOnlineContacts");

        Assert.Equal(new[] { bob.User.Id }, online);
    }

    [Fact]
    public async Task Delete_for_me_hides_message_only_for_the_caller()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);
        await using var aliceHub = factory.ConnectHub(alice.Token);
        await aliceHub.StartAsync();
        var id = await aliceHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "hi");

        var del = await bob.Http.DeleteAsync($"/api/messages/{id}?scope=me");

        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);
        var bobHistory = await bob.Http.GetFromJsonAsync<List<MessageDto>>($"/api/dialogs/{dialog.Id}/messages");
        var aliceHistory = await alice.Http.GetFromJsonAsync<List<MessageDto>>($"/api/dialogs/{dialog.Id}/messages");
        Assert.Empty(bobHistory!);
        Assert.Single(aliceHistory!);

        var bobDialog = (await bob.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs"))!.Single(d => d.Id == dialog.Id);
        var aliceDialog = (await alice.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs"))!.Single(d => d.Id == dialog.Id);
        Assert.Null(bobDialog.LastMessage);
        Assert.Equal(0, bobDialog.UnreadCount);   // скрытое сообщение не считается непрочитанным
        Assert.NotNull(aliceDialog.LastMessage);

        var repeat = await bob.Http.DeleteAsync($"/api/messages/{id}?scope=me");   // повтор безопасен
        Assert.Equal(HttpStatusCode.NoContent, repeat.StatusCode);
    }

    [Fact]
    public async Task Delete_for_all_by_recipient_notifies_the_sender_and_rejects_bad_scope()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);

        var deleted = new TaskCompletionSource<(string Dialog, string Message)>();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        aliceHub.On<string, string>("MessageDeleted", (d, m) => { deleted.TrySetResult((d, m)); });
        await aliceHub.StartAsync();
        var id = await aliceHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "oops");

        var bad = await bob.Http.DeleteAsync($"/api/messages/{id}?scope=nope");
        var del = await bob.Http.DeleteAsync($"/api/messages/{id}?scope=all");

        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);
        var evt = await deleted.Task.WaitAsync(Timeout);
        Assert.Equal((dialog.Id, id), evt);
    }
}
