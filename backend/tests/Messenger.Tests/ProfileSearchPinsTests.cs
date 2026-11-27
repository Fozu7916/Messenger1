using System.Net;
using Messenger.Api.Contracts;
using Microsoft.AspNetCore.SignalR.Client;

namespace Messenger.Tests;

/// <summary>Профиль, раздельный поиск людей/сообщений «по частям», ответы, закреп, пересылка, смена пароля.</summary>
[Collection(ApiCollection.Name)]
public sealed class ProfileSearchPinsTests(ApiFactory factory)
{
    private static async Task<string> SendAsync(HubConnection hub, string dialogId, string text) =>
        await hub.InvokeAsync<string>("SendMessage", Guid.NewGuid().ToString(), dialogId, text);

    [Fact]
    public async Task Bio_is_saved_cleared_and_kept_when_omitted()
    {
        var alice = await factory.RegisterAsync("alice");

        var set = await alice.Http.PutAsJsonAsync("/api/users/me", new { displayName = "Alice", bio = "  Люблю чай  " });
        set.EnsureSuccessStatusCode();
        Assert.Equal("Люблю чай", (await set.Content.ReadFromJsonAsync<ProfileDto>())!.Bio);

        // старый клиент не шлёт bio — оно не должно пропасть
        var keep = await alice.Http.PutAsJsonAsync("/api/users/me", new { displayName = "Alice 2" });
        Assert.Equal("Люблю чай", (await keep.Content.ReadFromJsonAsync<ProfileDto>())!.Bio);

        var clear = await alice.Http.PutAsJsonAsync("/api/users/me", new { displayName = "Alice 2", bio = "" });
        Assert.Null((await clear.Content.ReadFromJsonAsync<ProfileDto>())!.Bio);
    }

    [Fact]
    public async Task Peer_profile_shows_presence_only_to_contacts()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");

        var stranger = await alice.Http.GetFromJsonAsync<ProfileDto>($"/api/users/{bob.User.Id}");
        Assert.Null(stranger!.IsOnline);

        await alice.CreateDialogAsync(bob);
        var contact = await alice.Http.GetFromJsonAsync<ProfileDto>($"/api/users/{bob.User.Id}");
        Assert.False(contact!.IsOnline);

        Assert.Equal(HttpStatusCode.NotFound, (await alice.Http.GetAsync("/api/users/01ARZ3NDEKTSV4RRFFQ69G5FAV")).StatusCode);
    }

    [Fact]
    public async Task People_search_matches_words_in_any_order_and_ignores_at_sign()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        await bob.Http.PutAsJsonAsync("/api/users/me", new { displayName = "Иван Петров" });

        foreach (var q in new[] { "пет ива", "петров иван", "@" + bob.User.Login })
        {
            var found = await alice.Http.GetFromJsonAsync<List<UserDto>>($"/api/users/search?q={Uri.EscapeDataString(q)}");
            Assert.Contains(found!, u => u.Id == bob.User.Id);
        }
        Assert.Equal(HttpStatusCode.BadRequest, (await alice.Http.GetAsync("/api/users/search")).StatusCode);
    }

    [Fact]
    public async Task People_search_scope_contacts_returns_only_existing_dialog_peers()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        await alice.CreateDialogAsync(bob);

        var contacts = await alice.Http.GetFromJsonAsync<List<UserDto>>("/api/users/search?scope=contacts");
        Assert.Contains(contacts!, u => u.Id == bob.User.Id);
        Assert.DoesNotContain(contacts!, u => u.Id == carol.User.Id);
    }

    [Fact]
    public async Task Message_search_requires_all_words()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);
        await using var hub = factory.ConnectHub(alice.Token);
        await hub.StartAsync();
        var marker = "zz" + Guid.NewGuid().ToString("N")[..6];
        var hit = await SendAsync(hub, dialog.Id, $"купим молоко и хлеб {marker}");
        await SendAsync(hub, dialog.Id, $"только молоко {marker}");

        var found = await alice.Http.GetFromJsonAsync<List<MessageDto>>($"/api/messages/search?q={Uri.EscapeDataString("хлеб молоко " + marker)}");
        Assert.Single(found!);
        Assert.Equal(hit, found![0].Id);
    }

    [Fact]
    public async Task Reply_keeps_link_and_rejects_foreign_target()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        var ab = await alice.CreateDialogAsync(bob);
        var ac = await alice.CreateDialogAsync(carol);

        await using var hub = factory.ConnectHub(alice.Token);
        await hub.StartAsync();
        var original = await SendAsync(hub, ab.Id, "вопрос");
        var reply = await hub.InvokeAsync<string>("SendReply", Guid.NewGuid().ToString(), ab.Id, "ответ", original);

        var history = await alice.Http.GetFromJsonAsync<List<MessageDto>>($"/api/dialogs/{ab.Id}/messages");
        Assert.Equal(original, history!.Single(m => m.Id == reply).ReplyToId);

        var ex = await Assert.ThrowsAsync<Microsoft.AspNetCore.SignalR.HubException>(() =>
            hub.InvokeAsync<string>("SendReply", Guid.NewGuid().ToString(), ac.Id, "x", original));
        Assert.Contains("invalid_reply_to", ex.Message);
    }

    [Fact]
    public async Task Pin_unpin_notifies_peer_and_outsider_gets_404()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var eve = await factory.RegisterAsync("eve");
        var dialog = await alice.CreateDialogAsync(bob);

        var pinned = new TaskCompletionSource<MessageDto>();
        await using var bobHub = factory.ConnectHub(bob.Token);
        bobHub.On<string, MessageDto, string>("MessagePinned", (_, m, _) => pinned.TrySetResult(m));
        await bobHub.StartAsync();
        await using var aliceHub = factory.ConnectHub(alice.Token);
        await aliceHub.StartAsync();
        var id = await SendAsync(aliceHub, dialog.Id, "важное");

        Assert.Equal(HttpStatusCode.NoContent, (await bob.Http.PutAsync($"/api/dialogs/{dialog.Id}/pins/{id}", null)).StatusCode);
        Assert.Equal(id, (await pinned.Task.WaitAsync(TimeSpan.FromSeconds(10))).Id);
        Assert.Single((await alice.Http.GetFromJsonAsync<List<MessageDto>>($"/api/dialogs/{dialog.Id}/pins"))!);

        Assert.Equal(HttpStatusCode.NotFound, (await eve.Http.PutAsync($"/api/dialogs/{dialog.Id}/pins/{id}", null)).StatusCode);

        await alice.Http.DeleteAsync($"/api/dialogs/{dialog.Id}/pins/{id}");
        Assert.Empty((await alice.Http.GetFromJsonAsync<List<MessageDto>>($"/api/dialogs/{dialog.Id}/pins"))!);
    }

    [Fact]
    public async Task Deleting_a_pinned_message_unpins_it()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);
        await using var hub = factory.ConnectHub(alice.Token);
        await hub.StartAsync();
        var id = await SendAsync(hub, dialog.Id, "временное");
        await alice.Http.PutAsync($"/api/dialogs/{dialog.Id}/pins/{id}", null);

        await alice.Http.DeleteAsync($"/api/messages/{id}");

        Assert.Empty((await bob.Http.GetFromJsonAsync<List<MessageDto>>($"/api/dialogs/{dialog.Id}/pins"))!);
    }

    [Fact]
    public async Task Forward_copies_text_with_original_author_and_is_idempotent()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        var ab = await alice.CreateDialogAsync(bob);
        var bc = await bob.CreateDialogAsync(carol);

        await using var aliceHub = factory.ConnectHub(alice.Token);
        await aliceHub.StartAsync();
        var id = await SendAsync(aliceHub, ab.Id, "переслать");

        var received = new TaskCompletionSource<MessageDto>();
        await using var carolHub = factory.ConnectHub(carol.Token);
        carolHub.On<MessageDto>("MessageReceived", m => received.TrySetResult(m));
        await carolHub.StartAsync();

        var body = new { toDialogId = bc.Id, messageIds = new[] { id }, clientBatchId = Guid.NewGuid().ToString("N") };
        var r1 = await bob.Http.PostAsJsonAsync($"/api/dialogs/{ab.Id}/forward", body);
        r1.EnsureSuccessStatusCode();
        var first = (await r1.Content.ReadFromJsonAsync<List<MessageDto>>())!.Single();
        Assert.Equal("переслать", first.Text);
        Assert.Equal(alice.User.Id, first.ForwardedFromId);
        Assert.Equal(alice.User.DisplayName, first.ForwardedFromName);
        Assert.Equal(first.Id, (await received.Task.WaitAsync(TimeSpan.FromSeconds(10))).Id);

        var second = (await (await bob.Http.PostAsJsonAsync($"/api/dialogs/{ab.Id}/forward", body))
            .Content.ReadFromJsonAsync<List<MessageDto>>())!.Single();
        Assert.Equal(first.Id, second.Id);   // повтор не создаёт копию

        // в чужой диалог переслать нельзя
        var bad = await bob.Http.PostAsJsonAsync($"/api/dialogs/{ab.Id}/forward",
            new { toDialogId = (await alice.CreateDialogAsync(carol)).Id, messageIds = new[] { id }, clientBatchId = "x" });
        Assert.Equal(HttpStatusCode.NotFound, bad.StatusCode);
    }

    [Fact]
    public async Task Change_password_validates_current_and_revokes_other_sessions()
    {
        var alice = await factory.RegisterAsync("alice");

        var wrong = await alice.Http.PostAsJsonAsync("/api/auth/password", new { currentPassword = "nope-nope", newPassword = "NewPassw0rd!" });
        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);

        var ok = await alice.Http.PostAsJsonAsync("/api/auth/password", new { currentPassword = "Passw0rd!x", newPassword = "NewPassw0rd!" });
        Assert.Equal(HttpStatusCode.NoContent, ok.StatusCode);

        var login = factory.CreateClient();
        var old = await login.PostAsJsonAsync("/api/auth/login", new { login = alice.User.Login, password = "Passw0rd!x" });
        var fresh = await login.PostAsJsonAsync("/api/auth/login", new { login = alice.User.Login, password = "NewPassw0rd!" });
        Assert.Equal(HttpStatusCode.Unauthorized, old.StatusCode);
        Assert.Equal(HttpStatusCode.OK, fresh.StatusCode);
    }
}
