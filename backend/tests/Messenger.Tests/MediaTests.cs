using System.Net;
using Messenger.Api.Contracts;
using Messenger.Api.Storage;
using Microsoft.Extensions.DependencyInjection;
using SkiaSharp;

namespace Messenger.Tests;

/// <summary>Фото и голосовые сообщения.</summary>
[Collection(ApiCollection.Name)]
public sealed class MediaTests(ApiFactory factory)
{
    private static byte[] Png(int w, int h)
    {
        using var bmp = new SKBitmap(w, h);
        using (var c = new SKCanvas(bmp)) c.Clear(SKColors.Orange);
        using var img = SKImage.FromBitmap(bmp);
        using var data = img.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    // начало контейнера WebM (EBML) — этого достаточно для проверки формата
    private static readonly byte[] Webm = [0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3, 4, 5, 6, 7, 8];

    private static MultipartFormDataContent Form(string kind, byte[] bytes, string clientId, string? text = null, int? durationMs = null)
    {
        var form = new MultipartFormDataContent
        {
            { new ByteArrayContent(bytes), "file", kind == "image" ? "p.png" : "v.webm" },
            { new StringContent(kind), "kind" },
            { new StringContent(clientId), "clientMessageId" },
        };
        if (text is not null) form.Add(new StringContent(text), "text");
        if (durationMs is not null) form.Add(new StringContent(durationMs.Value.ToString()), "durationMs");
        return form;
    }

    private InMemoryFileStorage Storage => (InMemoryFileStorage)factory.Services.GetRequiredService<IFileStorage>();

    [Fact]
    public async Task Photo_is_resized_stored_and_visible_only_to_dialog_members()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var eve = await factory.RegisterAsync("eve");
        var dialog = await alice.CreateDialogAsync(bob);

        var res = await alice.Http.PostAsync($"/api/dialogs/{dialog.Id}/messages/media", Form("image", Png(3200, 1600), "c1", "смотри"));
        res.EnsureSuccessStatusCode();
        var msg = (await res.Content.ReadFromJsonAsync<MessageDto>())!;
        Assert.Equal("image", msg.Kind);
        Assert.Equal("смотри", msg.Text);
        Assert.Equal(1600, msg.MediaWidth);
        Assert.Equal(800, msg.MediaHeight);
        Assert.StartsWith($"/api/dialogs/{dialog.Id}/media/", msg.MediaUrl);

        var file = await bob.Http.GetAsync(msg.MediaUrl);
        Assert.Equal(HttpStatusCode.OK, file.StatusCode);
        Assert.Equal("image/webp", file.Content.Headers.ContentType!.MediaType);
        Assert.Equal(HttpStatusCode.NotFound, (await eve.Http.GetAsync(msg.MediaUrl)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync(msg.MediaUrl)).StatusCode);
    }

    [Fact]
    public async Task Sending_the_same_client_id_twice_creates_one_message_and_one_file()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);

        var first = (await (await alice.Http.PostAsync($"/api/dialogs/{dialog.Id}/messages/media", Form("image", Png(40, 40), "same"))).Content.ReadFromJsonAsync<MessageDto>())!;
        var again = (await (await alice.Http.PostAsync($"/api/dialogs/{dialog.Id}/messages/media", Form("image", Png(40, 40), "same"))).Content.ReadFromJsonAsync<MessageDto>())!;

        Assert.Equal(first.Id, again.Id);
        Assert.Single(await Storage.ListAsync($"media/{dialog.Id}/", 10));
    }

    [Fact]
    public async Task Voice_message_keeps_duration_and_rejects_foreign_formats()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);

        var ok = await alice.Http.PostAsync($"/api/dialogs/{dialog.Id}/messages/media", Form("voice", Webm, "v1", durationMs: 4200));
        ok.EnsureSuccessStatusCode();
        var msg = (await ok.Content.ReadFromJsonAsync<MessageDto>())!;
        Assert.Equal("voice", msg.Kind);
        Assert.Equal(4200, msg.MediaDurationMs);
        Assert.EndsWith(".webm", msg.MediaUrl);
        Assert.Equal("audio/webm", (await bob.Http.GetAsync(msg.MediaUrl)).Content.Headers.ContentType!.MediaType);

        var bad = await alice.Http.PostAsync($"/api/dialogs/{dialog.Id}/messages/media", Form("voice", "MZ не звук"u8.ToArray(), "v2"));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var notImage = await alice.Http.PostAsync($"/api/dialogs/{dialog.Id}/messages/media", Form("image", "это не картинка"u8.ToArray(), "v3"));
        Assert.Equal(HttpStatusCode.BadRequest, notImage.StatusCode);
    }

    [Fact]
    public async Task Non_members_cannot_send_media()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var eve = await factory.RegisterAsync("eve");
        var dialog = await alice.CreateDialogAsync(bob);

        Assert.Equal(HttpStatusCode.NotFound, (await eve.Http.PostAsync($"/api/dialogs/{dialog.Id}/messages/media", Form("image", Png(8, 8), "e1"))).StatusCode);
    }

    [Fact]
    public async Task Deleting_the_message_for_everyone_removes_the_file()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);
        var msg = (await (await alice.Http.PostAsync($"/api/dialogs/{dialog.Id}/messages/media", Form("image", Png(20, 20), "d1"))).Content.ReadFromJsonAsync<MessageDto>())!;

        await alice.Http.DeleteAsync($"/api/messages/{msg.Id}?scope=all");

        Assert.Equal(HttpStatusCode.NotFound, (await bob.Http.GetAsync(msg.MediaUrl)).StatusCode);
    }

    [Fact]
    public async Task Forwarded_photo_gets_its_own_copy_of_the_file()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        var ab = await alice.CreateDialogAsync(bob);
        var ac = await alice.CreateDialogAsync(carol);
        var msg = (await (await alice.Http.PostAsync($"/api/dialogs/{ab.Id}/messages/media", Form("image", Png(30, 30), "f1"))).Content.ReadFromJsonAsync<MessageDto>())!;

        var res = await alice.Http.PostAsJsonAsync($"/api/dialogs/{ab.Id}/forward", new { toDialogId = ac.Id, messageIds = new[] { msg.Id }, clientBatchId = "b1" });
        res.EnsureSuccessStatusCode();
        var copy = (await res.Content.ReadFromJsonAsync<List<MessageDto>>())!.Single();

        Assert.Equal("image", copy.Kind);
        Assert.StartsWith($"/api/dialogs/{ac.Id}/media/", copy.MediaUrl);
        Assert.Equal(HttpStatusCode.OK, (await carol.Http.GetAsync(copy.MediaUrl)).StatusCode);

        await alice.Http.DeleteAsync($"/api/messages/{msg.Id}?scope=all");   // оригинал удалён — копия цела
        Assert.Equal(HttpStatusCode.OK, (await carol.Http.GetAsync(copy.MediaUrl)).StatusCode);
    }

    [Fact]
    public async Task Group_avatar_can_be_set_and_is_public()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var g = await (await alice.Http.PostAsJsonAsync("/api/dialogs/group", new { title = "Фото", memberIds = new[] { bob.User.Id } })).Content.ReadFromJsonAsync<DialogDto>();
        var form = new MultipartFormDataContent { { new ByteArrayContent(Png(300, 200)), "file", "g.png" } };

        Assert.Equal(HttpStatusCode.NoContent, (await bob.Http.PostAsync($"/api/dialogs/{g!.Id}/avatar", form)).StatusCode);

        var url = (await bob.Http.GetFromJsonAsync<List<DialogDto>>("/api/dialogs"))!.Single(d => d.Id == g.Id).Peer!.AvatarUrl;
        Assert.StartsWith($"/api/files/group-avatars/{g.Id}/", url);
        Assert.Equal(HttpStatusCode.OK, (await factory.CreateClient().GetAsync(url)).StatusCode);
    }
}
