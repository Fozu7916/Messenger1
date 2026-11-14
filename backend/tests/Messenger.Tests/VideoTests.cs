using System.Net;
using Messenger.Api.Contracts;
using Messenger.Api.Media;
using Messenger.Api.Storage;
using Microsoft.Extensions.DependencyInjection;
using SkiaSharp;

namespace Messenger.Tests;

/// <summary>Видео: загрузка прямо в хранилище по временной ссылке, подтверждение, ссылка для просмотра, удаление, пересылка.</summary>
[Collection(ApiCollection.Name)]
public sealed class VideoTests(ApiFactory factory)
{
    // начало файла MP4: ....ftypisom
    private static readonly byte[] Mp4 = [0, 0, 0, 0x18, (byte)'f', (byte)'t', (byte)'y', (byte)'p', (byte)'i', (byte)'s', (byte)'o', (byte)'m', 0, 0, 2, 0, 1, 2, 3, 4];

    private InMemoryFileStorage Storage => (InMemoryFileStorage)factory.Services.GetRequiredService<IFileStorage>();

    private static byte[] Png()
    {
        using var bmp = new SKBitmap(64, 36);
        using (var c = new SKCanvas(bmp)) c.Clear(SKColors.Purple);
        using var img = SKImage.FromBitmap(bmp);
        using var data = img.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static Task<HttpResponseMessage> Intent(TestUser u, string dialogId, string type = "video/mp4", long size = 1000) =>
        u.Http.PostAsJsonAsync($"/api/dialogs/{dialogId}/video/upload", new { contentType = type, size, durationMs = 5000 });

    private static Task<HttpResponseMessage> Confirm(TestUser u, string dialogId, VideoUploadDto intent, string clientId, bool poster)
    {
        var form = new MultipartFormDataContent
        {
            { new StringContent(clientId), "clientMessageId" },
            { new StringContent(intent.FileId), "fileId" },
            { new StringContent(intent.Ext), "ext" },
            { new StringContent("5000"), "durationMs" },
            { new StringContent("640"), "width" },
            { new StringContent("360"), "height" },
        };
        if (poster) form.Add(new ByteArrayContent(Png()), "poster", "p.png");
        return u.Http.PostAsync($"/api/dialogs/{dialogId}/messages/video", form);
    }

    /// <summary>Весь путь: ссылка → «загрузка» (имитируем PUT) → подтверждение.</summary>
    private async Task<MessageDto> SendAsync(TestUser u, string dialogId, string clientId, bool poster = true)
    {
        var res = await Intent(u, dialogId);
        res.EnsureSuccessStatusCode();
        var intent = (await res.Content.ReadFromJsonAsync<VideoUploadDto>())!;
        Storage.Seed(MediaKeys.Key(dialogId, $"{intent.FileId}.{intent.Ext}"), Mp4);
        var sent = await Confirm(u, dialogId, intent, clientId, poster);
        sent.EnsureSuccessStatusCode();
        return (await sent.Content.ReadFromJsonAsync<MessageDto>())!;
    }

    [Fact]
    public async Task Video_flow_creates_a_message_with_poster_and_a_temporary_link_for_members_only()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var eve = await factory.RegisterAsync("eve");
        var dialog = await alice.CreateDialogAsync(bob);

        var intent = (await (await Intent(alice, dialog.Id)).Content.ReadFromJsonAsync<VideoUploadDto>())!;
        Assert.Equal("mp4", intent.Ext);
        Assert.Contains(intent.FileId, intent.UploadUrl);

        var msg = await SendAsync(alice, dialog.Id, "v1");
        Assert.Equal("video", msg.Kind);
        Assert.Equal(5000, msg.MediaDurationMs);
        Assert.Equal(640, msg.MediaWidth);
        Assert.Equal(360, msg.MediaHeight);
        Assert.EndsWith(".mp4", msg.MediaUrl);

        var poster = await bob.Http.GetAsync(msg.MediaUrl!.Replace(".mp4", ".webp"));
        Assert.Equal(HttpStatusCode.OK, poster.StatusCode);
        Assert.Equal("image/webp", poster.Content.Headers.ContentType!.MediaType);

        var link = await bob.Http.GetFromJsonAsync<System.Text.Json.JsonElement>(msg.MediaUrl + "/url");
        Assert.StartsWith("http", link.GetProperty("url").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await eve.Http.GetAsync(msg.MediaUrl + "/url")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await bob.Http.GetAsync(msg.MediaUrl)).StatusCode);   // видео через API не отдаётся
    }

    [Fact]
    public async Task Confirming_without_an_upload_or_with_a_foreign_format_is_rejected()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);

        var intent = (await (await Intent(alice, dialog.Id)).Content.ReadFromJsonAsync<VideoUploadDto>())!;
        Assert.Equal(HttpStatusCode.BadRequest, (await Confirm(alice, dialog.Id, intent, "c1", false)).StatusCode);   // файл не загружали

        var key = MediaKeys.Key(dialog.Id, $"{intent.FileId}.{intent.Ext}");
        Storage.Seed(key, "MZ это не видео"u8.ToArray());
        Assert.Equal(HttpStatusCode.BadRequest, (await Confirm(alice, dialog.Id, intent, "c2", false)).StatusCode);
        Assert.Null(await Storage.SizeAsync(key));   // чужой файл удалён
    }

    [Fact]
    public async Task Upload_links_are_limited_by_type_size_and_membership()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var eve = await factory.RegisterAsync("eve");
        var dialog = await alice.CreateDialogAsync(bob);

        Assert.Equal(HttpStatusCode.BadRequest, (await Intent(alice, dialog.Id, "video/x-msvideo")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Intent(alice, dialog.Id, "video/mp4", 60L * 1024 * 1024)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Intent(eve, dialog.Id)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Intent(alice, dialog.Id, "video/quicktime")).StatusCode);   // .mov с H.264 принимаем как MP4
    }

    [Fact]
    public async Task Repeated_confirmation_returns_the_same_message()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);
        var intent = (await (await Intent(alice, dialog.Id)).Content.ReadFromJsonAsync<VideoUploadDto>())!;
        Storage.Seed(MediaKeys.Key(dialog.Id, $"{intent.FileId}.{intent.Ext}"), Mp4);

        var first = (await (await Confirm(alice, dialog.Id, intent, "same", true)).Content.ReadFromJsonAsync<MessageDto>())!;
        var again = (await (await Confirm(alice, dialog.Id, intent, "same", true)).Content.ReadFromJsonAsync<MessageDto>())!;

        Assert.Equal(first.Id, again.Id);
        Assert.NotNull(await Storage.SizeAsync(MediaKeys.Key(dialog.Id, $"{intent.FileId}.{intent.Ext}")));   // повтор файл не трогает
    }

    [Fact]
    public async Task Deleting_the_message_removes_the_video_and_its_poster()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var dialog = await alice.CreateDialogAsync(bob);
        var msg = await SendAsync(alice, dialog.Id, "d1");
        var name = MediaKeys.Parse(msg.MediaUrl)!.Value.Name;

        await alice.Http.DeleteAsync($"/api/messages/{msg.Id}?scope=all");

        Assert.Null(await Storage.SizeAsync(MediaKeys.Key(dialog.Id, name)));
        Assert.Null(await Storage.SizeAsync(MediaKeys.Key(dialog.Id, MediaKeys.Poster(name))));
    }

    [Fact]
    public async Task Forwarded_video_gets_its_own_copy_with_poster()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");
        var carol = await factory.RegisterAsync("carol");
        var ab = await alice.CreateDialogAsync(bob);
        var ac = await alice.CreateDialogAsync(carol);
        var msg = await SendAsync(alice, ab.Id, "f1");

        var res = await alice.Http.PostAsJsonAsync($"/api/dialogs/{ab.Id}/forward", new { toDialogId = ac.Id, messageIds = new[] { msg.Id }, clientBatchId = "fv" });
        res.EnsureSuccessStatusCode();
        var copy = (await res.Content.ReadFromJsonAsync<List<MessageDto>>())!.Single();

        Assert.Equal("video", copy.Kind);
        Assert.StartsWith($"/api/dialogs/{ac.Id}/media/", copy.MediaUrl);
        var copyName = MediaKeys.Parse(copy.MediaUrl)!.Value.Name;
        Assert.NotNull(await Storage.SizeAsync(MediaKeys.Key(ac.Id, copyName)));
        Assert.NotNull(await Storage.SizeAsync(MediaKeys.Key(ac.Id, MediaKeys.Poster(copyName))));
    }
}
