using System.Net;
using Messenger.Api.Contracts;
using Microsoft.AspNetCore.SignalR.Client;

namespace Messenger.Tests;

/// <summary>Беседы: создание, участники, роли, выход, служебные сообщения.</summary>
[Collection(ApiCollection.Name)]
public sealed class GroupTests(ApiFactory factory)
{
    private static async Task<DialogDto> CreateGroupAsync(TestUser owner, string title, params TestUser[] members)
    {
        var res = await owner.Http.PostAsJsonAsync("/api/dialogs/group", new { title, memberIds = members.Select(m => m.User.Id).ToArray() });
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<DialogDto>())!;
    }

    private static Task<List<DialogDto>?> DialogsAsync(TestUser u) => u.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");

    [Fact]
    public async Task Group_is_created_listed_for_everyone_with_a_system_message_and_no_unread()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");

        var g = await CreateGroupAsync(alice, "Дача", bob, carol);
        Assert.Equal("group", g.Kind);
        Assert.Equal(3, g.MemberCount);
        Assert.Equal("owner", g.MyRole);

        var seen = (await DialogsAsync(bob))!.Single(d => d.Id == g.Id);
        Assert.Equal("Дача", seen.Peer!.DisplayName);   // «собеседник» у беседы — её название
        Assert.Equal("member", seen.MyRole);
        Assert.Equal(0, seen.UnreadCount);              // служебные сообщения в непрочитанные не считаются
        Assert.Null(seen.PeerLastReadId);

        var history = await bob.Http.GetFromJsonAsync<List<MessageDto>>($"/api/dialogs/{g.Id}/messages");
        Assert.Contains(history!, m => m.Kind == "system" && m.Text.Contains("Дача"));
    }

    [Fact]
    public async Task Group_messages_reach_every_member_through_the_hub()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        var g = await CreateGroupAsync(alice, "Чат", bob, carol);

        var got = new TaskCompletionSource<MessageDto>();
        await using var carolHub = factory.ConnectHub(carol.Token);
        carolHub.On<MessageDto>("MessageReceived", m => { if (m.Kind == "text") got.TrySetResult(m); });
        await carolHub.StartAsync();
        await using var bobHub = factory.ConnectHub(bob.Token);
        await bobHub.StartAsync();

        await bobHub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), g.Id, "всем привет");

        Assert.Equal("всем привет", (await got.Task.WaitAsync(TimeSpan.FromSeconds(10))).Text);
        Assert.Equal(1, (await DialogsAsync(carol))!.Single(d => d.Id == g.Id).UnreadCount);
    }

    [Fact]
    public async Task Creating_a_direct_dialog_ignores_groups_the_pair_shares()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var g = await CreateGroupAsync(alice, "Двое", bob);

        var direct = await alice.CreateDialogAsync(bob);

        Assert.NotEqual(g.Id, direct.Id);
        Assert.Equal("direct", (await DialogsAsync(alice))!.Single(d => d.Id == direct.Id).Kind);
    }

    [Fact]
    public async Task Only_the_owner_removes_or_renames_and_any_member_can_add()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        var dave = await factory.RegisterAsync("dave");
        var g = await CreateGroupAsync(alice, "Клуб", bob, carol);

        Assert.Equal(HttpStatusCode.Forbidden, (await bob.Http.DeleteAsync($"/api/dialogs/{g.Id}/members/{carol.User.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await bob.Http.PutAsJsonAsync($"/api/dialogs/{g.Id}", new { title = "Новое" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dave.Http.GetAsync($"/api/dialogs/{g.Id}/members")).StatusCode);

        var added = await bob.Http.PostAsJsonAsync($"/api/dialogs/{g.Id}/members", new { userIds = new[] { dave.User.Id } });
        Assert.Equal(4, (await added.Content.ReadFromJsonAsync<List<MemberDto>>())!.Count);

        Assert.Equal(HttpStatusCode.NoContent, (await alice.Http.DeleteAsync($"/api/dialogs/{g.Id}/members/{carol.User.Id}")).StatusCode);
        Assert.DoesNotContain((await DialogsAsync(carol))!, d => d.Id == g.Id);   // исключённый больше не видит беседу
        Assert.Equal(HttpStatusCode.NoContent, (await alice.Http.PutAsJsonAsync($"/api/dialogs/{g.Id}", new { title = "Новое" })).StatusCode);
        Assert.Equal("Новое", (await DialogsAsync(bob))!.Single(d => d.Id == g.Id).Title);
    }

    [Fact]
    public async Task Owner_leaving_hands_the_group_to_the_earliest_member_and_the_last_one_deletes_it()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var g = await CreateGroupAsync(alice, "Пара", bob);

        Assert.Equal(HttpStatusCode.NoContent, (await alice.Http.DeleteAsync($"/api/dialogs/{g.Id}/members/me")).StatusCode);
        Assert.Equal("owner", (await DialogsAsync(bob))!.Single(d => d.Id == g.Id).MyRole);

        Assert.Equal(HttpStatusCode.NoContent, (await bob.Http.DeleteAsync($"/api/dialogs/{g.Id}/members/me")).StatusCode);
        Assert.DoesNotContain((await DialogsAsync(bob))!, d => d.Id == g.Id);
    }

    [Fact]
    public async Task Members_cannot_delete_a_group_but_the_owner_can()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var g = await CreateGroupAsync(alice, "Удаляемая", bob);

        Assert.Equal(HttpStatusCode.Forbidden, (await bob.Http.DeleteAsync($"/api/dialogs/{g.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await alice.Http.DeleteAsync($"/api/dialogs/{g.Id}")).StatusCode);
        Assert.DoesNotContain((await DialogsAsync(bob))!, d => d.Id == g.Id);
    }

    [Fact]
    public async Task Group_validation_rejects_bad_requests()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");

        Assert.Equal(HttpStatusCode.BadRequest, (await alice.Http.PostAsJsonAsync("/api/dialogs/group", new { title = "x", memberIds = new[] { alice.User.Id } })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await alice.Http.PostAsJsonAsync("/api/dialogs/group", new { title = "x", memberIds = new[] { "01ARZ3NDEKTSV4RRFFQ69G5FAV" } })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await alice.Http.PostAsJsonAsync("/api/dialogs/group", new { title = "", memberIds = new[] { bob.User.Id } })).StatusCode);
    }
}
