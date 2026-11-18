using System.Net;
using Microsoft.AspNetCore.SignalR.Client;
using Messenger.Api.Contracts;

namespace Messenger.Tests;

/// <summary>Реакции на сообщения: REST (поставить, заменить, снять, список), права доступа и событие ReactionChanged.</summary>
[Collection(ApiCollection.Name)]
public sealed class ReactionTests(ApiFactory factory)
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private sealed record Reaction(string MessageId, string UserId, string Emoji);

    private async Task<string> SendAsync(TestUser u, string dialogId, string text = "привет")
    {
        await using var hub = factory.ConnectHub(u.Token);
        await hub.StartAsync();
        return await hub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialogId, text);
    }

    private async Task<(TestUser Alice, TestUser Bob, DialogDto Dialog, string MessageId)> ArrangeAsync()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);
        var id = await SendAsync(alice, dialog.Id);
        return (alice, bob, dialog, id);
    }

    private static Task<HttpResponseMessage> Put(TestUser u, string dialogId, string messageId, string emoji) =>
        u.Http.PutAsJsonAsync($"/api/dialogs/{dialogId}/reactions/{messageId}", new { emoji });

    private static async Task<List<Reaction>> ListAsync(TestUser u, string dialogId) =>
        (await u.Http.GetFromJsonAsync<List<Reaction>>($"/api/dialogs/{dialogId}/reactions"))!;

    [Fact]
    public async Task Member_can_set_a_reaction_and_it_appears_in_the_list()
    {
        var (alice, bob, dialog, msg) = await ArrangeAsync();

        var res = await Put(bob, dialog.Id, msg, "👍");
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);

        var list = await ListAsync(alice, dialog.Id);
        var r = Assert.Single(list);
        Assert.Equal((msg, bob.User.Id, "👍"), (r.MessageId, r.UserId, r.Emoji));
    }

    [Fact]
    public async Task New_reaction_replaces_the_previous_one_from_the_same_user()
    {
        var (_, bob, dialog, msg) = await ArrangeAsync();

        (await Put(bob, dialog.Id, msg, "👍")).EnsureSuccessStatusCode();
        (await Put(bob, dialog.Id, msg, "🔥")).EnsureSuccessStatusCode();

        var r = Assert.Single(await ListAsync(bob, dialog.Id));
        Assert.Equal("🔥", r.Emoji);
    }

    [Fact]
    public async Task Different_users_can_react_to_the_same_message()
    {
        var (alice, bob, dialog, msg) = await ArrangeAsync();

        (await Put(alice, dialog.Id, msg, "❤️")).EnsureSuccessStatusCode();
        (await Put(bob, dialog.Id, msg, "😂")).EnsureSuccessStatusCode();

        var list = await ListAsync(alice, dialog.Id);
        Assert.Equal(2, list.Count);
        Assert.Contains(list, r => r.UserId == alice.User.Id && r.Emoji == "❤️");
        Assert.Contains(list, r => r.UserId == bob.User.Id && r.Emoji == "😂");
    }

    [Fact]
    public async Task Reaction_can_be_removed_and_removing_twice_is_harmless()
    {
        var (_, bob, dialog, msg) = await ArrangeAsync();
        (await Put(bob, dialog.Id, msg, "👍")).EnsureSuccessStatusCode();

        var del = await bob.Http.DeleteAsync($"/api/dialogs/{dialog.Id}/reactions/{msg}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);
        Assert.Empty(await ListAsync(bob, dialog.Id));

        var again = await bob.Http.DeleteAsync($"/api/dialogs/{dialog.Id}/reactions/{msg}");
        Assert.Equal(HttpStatusCode.NoContent, again.StatusCode);
    }

    [Theory]
    [InlineData("🙈")]
    [InlineData("")]
    [InlineData("текст")]
    public async Task Unsupported_emoji_is_rejected(string emoji)
    {
        var (_, bob, dialog, msg) = await ArrangeAsync();

        var res = await Put(bob, dialog.Id, msg, emoji);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Empty(await ListAsync(bob, dialog.Id));
    }

    [Fact]
    public async Task Reacting_to_an_unknown_message_returns_404()
    {
        var (_, bob, dialog, _) = await ArrangeAsync();

        var res = await Put(bob, dialog.Id, Ulid.NewUlid().ToString(), "👍");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Reacting_with_a_malformed_message_id_returns_404()
    {
        var (_, bob, dialog, _) = await ArrangeAsync();

        var res = await Put(bob, dialog.Id, "not-a-ulid", "👍");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Stranger_cannot_read_set_or_remove_reactions_in_foreign_dialog()
    {
        var (_, bob, dialog, msg) = await ArrangeAsync();
        var carol = await factory.RegisterAsync("carol");
        (await Put(bob, dialog.Id, msg, "👍")).EnsureSuccessStatusCode();

        Assert.Equal(HttpStatusCode.NotFound, (await carol.Http.GetAsync($"/api/dialogs/{dialog.Id}/reactions")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Put(carol, dialog.Id, msg, "🔥")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await carol.Http.DeleteAsync($"/api/dialogs/{dialog.Id}/reactions/{msg}")).StatusCode);

        var r = Assert.Single(await ListAsync(bob, dialog.Id));   // чужие запросы ничего не изменили
        Assert.Equal("👍", r.Emoji);
    }

    [Fact]
    public async Task Reactions_require_authentication()
    {
        var (_, _, dialog, msg) = await ArrangeAsync();
        var anon = factory.CreateClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync($"/api/dialogs/{dialog.Id}/reactions")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.PutAsJsonAsync($"/api/dialogs/{dialog.Id}/reactions/{msg}", new { emoji = "👍" })).StatusCode);
    }

    [Fact]
    public async Task ReactionChanged_event_reaches_the_peer_on_set_and_on_remove()
    {
        var (alice, bob, dialog, msg) = await ArrangeAsync();
        var events = new System.Collections.Concurrent.BlockingCollection<(string Dialog, string Message, string User, string? Emoji)>();

        await using var aliceHub = factory.ConnectHub(alice.Token);
        aliceHub.On<string, string, string, string?>("ReactionChanged", (d, m, u, e) => events.Add((d, m, u, e)));
        await aliceHub.StartAsync();

        (await Put(bob, dialog.Id, msg, "🔥")).EnsureSuccessStatusCode();
        Assert.True(events.TryTake(out var set, Timeout), "событие об установке реакции не пришло");
        Assert.Equal((dialog.Id, msg, bob.User.Id, "🔥"), set);

        (await bob.Http.DeleteAsync($"/api/dialogs/{dialog.Id}/reactions/{msg}")).EnsureSuccessStatusCode();
        Assert.True(events.TryTake(out var removed, Timeout), "событие о снятии реакции не пришло");
        Assert.Equal((dialog.Id, msg, bob.User.Id, (string?)null), removed);
    }

    [Fact]
    public async Task Removing_a_reaction_that_does_not_exist_sends_no_event()
    {
        var (alice, bob, dialog, msg) = await ArrangeAsync();
        var got = new TaskCompletionSource<bool>();

        await using var aliceHub = factory.ConnectHub(alice.Token);
        aliceHub.On<string, string, string, string?>("ReactionChanged", (_, _, _, _) => got.TrySetResult(true));
        await aliceHub.StartAsync();

        (await bob.Http.DeleteAsync($"/api/dialogs/{dialog.Id}/reactions/{msg}")).EnsureSuccessStatusCode();

        await Task.Delay(500);
        Assert.False(got.Task.IsCompleted);
    }
}
