using System.Net;
using Messenger.Api.Contracts;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace Messenger.Tests;

[Collection(ApiCollection.Name)]
public sealed class ChatHubTests(ApiFactory factory)
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task Message_is_delivered_to_peer_and_acked_to_sender()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);

        var received = new TaskCompletionSource<MessageDto>();
        var acked = new TaskCompletionSource<(string Client, string Server)>();

        await using var bobHub = factory.ConnectHub(bob.Token);
        bobHub.On<MessageDto>("MessageReceived", m => { received.TrySetResult(m); });
        await bobHub.StartAsync();

        await using var aliceHub = factory.ConnectHub(alice.Token);
        aliceHub.On<string, string>("MessageAcked", (c, s) => { acked.TrySetResult((c, s)); });
        await aliceHub.StartAsync();

        var clientId = Guid.NewGuid().ToString();
        var serverId = await aliceHub.InvokeAsync<string>("SendMessage", clientId, dialog.Id, "привет");

        var msg = await received.Task.WaitAsync(Timeout);
        var ack = await acked.Task.WaitAsync(Timeout);

        Assert.Equal(serverId, msg.Id);
        Assert.Equal("привет", msg.Text);
        Assert.Equal(alice.User.Id, msg.SenderId);
        Assert.Equal((clientId, serverId), ack);
    }

    [Fact]
    public async Task Resending_same_client_message_id_does_not_create_duplicate()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);
        await using var hub = factory.ConnectHub(alice.Token);
        await hub.StartAsync();

        var clientId = Guid.NewGuid().ToString();
        var first = await hub.InvokeAsync<string>("SendMessage", clientId, dialog.Id, "once");
        var second = await hub.InvokeAsync<string>("SendMessage", clientId, dialog.Id, "once");

        Assert.Equal(first, second);
        var history = await alice.Http.GetFromJsonAsync<List<MessageDto>>($"/api/dialogs/{dialog.Id}/messages");
        Assert.Single(history!);
    }

    [Fact]
    public async Task Stranger_cannot_send_to_foreign_dialog()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        var dialog = await alice.CreateDialogAsync(bob);
        await using var hub = factory.ConnectHub(carol.Token);
        await hub.StartAsync();

        await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "hi"));
    }

    [Fact]
    public async Task Hub_rejects_empty_text()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);
        await using var hub = factory.ConnectHub(alice.Token);
        await hub.StartAsync();

        await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "   "));
    }

    [Fact]
    public async Task Hub_connection_without_token_is_rejected()
    {
        var hub = new HubConnectionBuilder()
            .WithUrl(new Uri(factory.Server.BaseAddress, "/hubs/chat"), o =>
            {
                o.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                o.Transports = Microsoft.AspNetCore.Http.Connections.HttpTransportType.LongPolling;
            })
            .Build();

        await Assert.ThrowsAnyAsync<Exception>(() => hub.StartAsync());
    }

    [Fact]
    public async Task History_after_ulid_returns_only_newer_messages_in_order()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);
        await using var hub = factory.ConnectHub(alice.Token);
        await hub.StartAsync();

        var ids = new List<string>();
        foreach (var text in new[] { "one", "two", "three" })
            ids.Add(await hub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, text));

        var delta = await bob.Http.GetFromJsonAsync<List<MessageDto>>(
            $"/api/dialogs/{dialog.Id}/messages?after={ids[0]}");
        var older = await bob.Http.GetFromJsonAsync<List<MessageDto>>(
            $"/api/dialogs/{dialog.Id}/messages?before={ids[2]}");

        Assert.Equal(new[] { ids[1], ids[2] }, delta!.Select(m => m.Id));
        Assert.Equal(new[] { ids[0], ids[1] }, older!.Select(m => m.Id));
    }

    [Fact]
    public async Task Stranger_cannot_delete_message_but_any_member_can_delete_it_for_everyone()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        var dialog = await alice.CreateDialogAsync(bob);
        await using var hub = factory.ConnectHub(alice.Token);
        await hub.StartAsync();
        var id = await hub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialog.Id, "secret");

        var byCarol = await carol.Http.DeleteAsync($"/api/messages/{id}");
        var byBob = await bob.Http.DeleteAsync($"/api/messages/{id}");   // чужое сообщение, удаляем у всех

        Assert.Equal(HttpStatusCode.NotFound, byCarol.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, byBob.StatusCode);
        var history = await alice.Http.GetFromJsonAsync<List<MessageDto>>($"/api/dialogs/{dialog.Id}/messages");
        Assert.Empty(history!);
    }
}
