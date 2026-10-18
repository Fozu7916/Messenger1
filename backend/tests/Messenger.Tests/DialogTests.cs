using System.Net;
using Messenger.Api.Contracts;

namespace Messenger.Tests;

[Collection(ApiCollection.Name)]
public sealed class DialogTests(ApiFactory factory)
{
    [Fact]
    public async Task Creating_dialog_twice_for_same_pair_returns_same_dialog()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");

        var first = await alice.Http.PostAsJsonAsync("/api/dialogs", new { userId = bob.User.Id });
        var second = await bob.Http.PostAsJsonAsync("/api/dialogs", new { userId = alice.User.Id });

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Equal(
            (await first.Content.ReadFromJsonAsync<DialogDto>())!.Id,
            (await second.Content.ReadFromJsonAsync<DialogDto>())!.Id);
    }

    [Fact]
    public async Task Stranger_cannot_read_foreign_dialog_history()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        var dialog = await alice.CreateDialogAsync(bob);

        var resp = await carol.Http.GetAsync($"/api/dialogs/{dialog.Id}/messages");

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task Dialog_list_shows_peer_and_member_can_delete_dialog()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);

        var list = await alice.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        Assert.Equal(bob.User.Id, list!.Single(d => d.Id == dialog.Id).Peer!.Id);

        var del = await alice.Http.DeleteAsync($"/api/dialogs/{dialog.Id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var afterDelete = await bob.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        Assert.DoesNotContain(afterDelete!, d => d.Id == dialog.Id);
    }

    [Fact]
    public async Task Search_finds_user_by_login_prefix_and_excludes_self()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");

        var found = await alice.Http.GetFromJsonAsync<List<UserDto>>($"/api/users?query={bob.User.Login}");
        var self = await alice.Http.GetFromJsonAsync<List<UserDto>>($"/api/users?query={alice.User.Login}");

        Assert.Contains(found!, u => u.Id == bob.User.Id);
        Assert.DoesNotContain(self!, u => u.Id == alice.User.Id);
    }
}
