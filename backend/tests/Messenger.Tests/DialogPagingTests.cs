using Messenger.Api.Contracts;

namespace Messenger.Tests;

[Collection(ApiCollection.Name)]
public sealed class DialogPagingTests(ApiFactory factory)
{
    [Fact]
    public async Task Dialog_list_is_paged_and_limit_is_clamped()
    {
        var me = await factory.RegisterAsync("pgme");
        for (var i = 0; i < 3; i++)
            await me.CreateDialogAsync(await factory.RegisterAsync("pgpeer"));

        var all = await me.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs");
        var first = await me.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs?limit=2&offset=0");
        var rest = await me.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs?limit=2&offset=2");
        var clamped = await me.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs?limit=0&offset=-5");

        Assert.Equal(3, all!.Count);
        Assert.Equal(2, first!.Count);
        Assert.Single(rest!);
        Assert.Equal(all.Select(d => d.Id), first.Concat(rest).Select(d => d.Id));   // страницы не пересекаются и идут в том же порядке
        Assert.Single(clamped!);                                                        // limit=0 поднимается до 1, offset<0 до 0
    }
}
