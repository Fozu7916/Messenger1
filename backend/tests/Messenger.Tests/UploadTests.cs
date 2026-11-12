using System.Net;
using System.Net.Http.Headers;
using Messenger.Api.Contracts;
using SkiaSharp;

namespace Messenger.Tests;

/// <summary>Аватарки, обои и настройки оформления.</summary>
[Collection(ApiCollection.Name)]
public sealed class UploadTests(ApiFactory factory)
{
    private static byte[] Png(int w, int h)
    {
        using var bmp = new SKBitmap(w, h);
        using (var c = new SKCanvas(bmp)) c.Clear(SKColors.Teal);
        using var img = SKImage.FromBitmap(bmp);
        using var data = img.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static MultipartFormDataContent Form(byte[] bytes, string name = "a.png")
    {
        var form = new MultipartFormDataContent();
        var part = new ByteArrayContent(bytes);
        part.Headers.ContentType = new MediaTypeHeaderValue("image/png");
        form.Add(part, "file", name);
        return form;
    }

    private static SKBitmap Decode(byte[] bytes) => SKBitmap.Decode(bytes) ?? throw new InvalidOperationException("not an image");

    [Fact]
    public async Task Avatar_is_cropped_square_stored_and_served_publicly_with_long_cache()
    {
        var alice = await factory.RegisterAsync("alice");

        var up = await alice.Http.PostAsync("/api/users/me/avatar", Form(Png(800, 400)));
        up.EnsureSuccessStatusCode();
        var profile = (await up.Content.ReadFromJsonAsync<ProfileDto>())!;
        Assert.StartsWith($"/api/files/avatars/{alice.User.Id}/", profile.AvatarUrl);

        var anon = factory.CreateClient();   // без токена: <img> не умеет слать Authorization
        var img = await anon.GetAsync(profile.AvatarUrl);
        Assert.Equal(HttpStatusCode.OK, img.StatusCode);
        Assert.Equal("image/webp", img.Content.Headers.ContentType!.MediaType);
        Assert.Contains("immutable", img.Headers.CacheControl!.ToString());
        using var bmp = Decode(await img.Content.ReadAsByteArrayAsync());
        Assert.Equal(400, bmp.Width);
        Assert.Equal(400, bmp.Height);
    }

    [Fact]
    public async Task Replacing_the_avatar_removes_the_previous_file()
    {
        var alice = await factory.RegisterAsync("alice");
        var first = (await (await alice.Http.PostAsync("/api/users/me/avatar", Form(Png(64, 64)))).Content.ReadFromJsonAsync<ProfileDto>())!.AvatarUrl!;
        await alice.Http.PostAsync("/api/users/me/avatar", Form(Png(80, 80)));

        Assert.Equal(HttpStatusCode.NotFound, (await factory.CreateClient().GetAsync(first)).StatusCode);
    }

    [Fact]
    public async Task Renaming_keeps_the_uploaded_avatar()
    {
        var alice = await factory.RegisterAsync("alice");
        var url = (await (await alice.Http.PostAsync("/api/users/me/avatar", Form(Png(64, 64)))).Content.ReadFromJsonAsync<ProfileDto>())!.AvatarUrl;

        var put = await alice.Http.PutAsJsonAsync("/api/users/me", new { displayName = "Alice 2", avatarUrl = url });

        Assert.Equal(url, (await put.Content.ReadFromJsonAsync<ProfileDto>())!.AvatarUrl);
    }

    [Fact]
    public async Task Avatar_can_be_removed()
    {
        var alice = await factory.RegisterAsync("alice");
        await alice.Http.PostAsync("/api/users/me/avatar", Form(Png(64, 64)));

        var del = await alice.Http.DeleteAsync("/api/users/me/avatar");

        Assert.Null((await del.Content.ReadFromJsonAsync<ProfileDto>())!.AvatarUrl);
    }

    [Fact]
    public async Task Non_images_and_missing_files_are_rejected()
    {
        var alice = await factory.RegisterAsync("alice");

        var text = await alice.Http.PostAsync("/api/users/me/avatar", Form("это не картинка"u8.ToArray(), "evil.png"));
        Assert.Equal(HttpStatusCode.BadRequest, text.StatusCode);

        var empty = await alice.Http.PostAsync("/api/users/me/avatar", new MultipartFormDataContent());
        Assert.Equal(HttpStatusCode.BadRequest, empty.StatusCode);
    }

    [Fact]
    public async Task Upload_requires_authentication()
    {
        var anon = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.PostAsync("/api/users/me/avatar", Form(Png(8, 8)))).StatusCode);
    }

    [Fact]
    public async Task Wallpapers_are_resized_private_listed_and_deletable()
    {
        var alice = await factory.RegisterAsync("alice");
        var bob = await factory.RegisterAsync("bob");

        var up = await alice.Http.PostAsync("/api/users/me/wallpapers", Form(Png(3000, 2000)));
        Assert.Equal(HttpStatusCode.Created, up.StatusCode);
        var id = (await up.Content.ReadFromJsonAsync<WallpaperDto>())!.Id;

        var list = await alice.Http.GetFromJsonAsync<List<WallpaperDto>>("/api/users/me/wallpapers");
        Assert.Contains(list!, w => w.Id == id);

        var file = await alice.Http.GetAsync($"/api/users/me/wallpapers/{id}");
        using (var bmp = Decode(await file.Content.ReadAsByteArrayAsync()))
        {
            Assert.Equal(1920, bmp.Width);
            Assert.Equal(1280, bmp.Height);
        }

        // чужие обои по тому же id недоступны: путь всегда строится от текущего пользователя
        Assert.Equal(HttpStatusCode.NotFound, (await bob.Http.GetAsync($"/api/users/me/wallpapers/{id}")).StatusCode);
        Assert.DoesNotContain((await bob.Http.GetFromJsonAsync<List<WallpaperDto>>("/api/users/me/wallpapers"))!, w => w.Id == id);

        Assert.Equal(HttpStatusCode.NoContent, (await alice.Http.DeleteAsync($"/api/users/me/wallpapers/{id}")).StatusCode);
        Assert.Empty((await alice.Http.GetFromJsonAsync<List<WallpaperDto>>("/api/users/me/wallpapers"))!);
    }

    [Fact]
    public async Task Wallpaper_count_is_limited()
    {
        var alice = await factory.RegisterAsync("alice");
        for (var i = 0; i < 12; i++)
            (await alice.Http.PostAsync("/api/users/me/wallpapers", Form(Png(16, 16)))).EnsureSuccessStatusCode();

        Assert.Equal(HttpStatusCode.Conflict, (await alice.Http.PostAsync("/api/users/me/wallpapers", Form(Png(16, 16)))).StatusCode);
    }

    [Fact]
    public async Task Appearance_roundtrips_and_validates()
    {
        var alice = await factory.RegisterAsync("alice");
        Assert.Equal("{}", await alice.Http.GetStringAsync("/api/users/me/appearance"));

        var put = await alice.Http.PutAsJsonAsync("/api/users/me/appearance", new { mode = "dark", accent = "emerald", wallpaper = new { kind = "preset", id = "dusk" } });
        Assert.Equal(HttpStatusCode.NoContent, put.StatusCode);
        var back = await alice.Http.GetFromJsonAsync<System.Text.Json.JsonElement>("/api/users/me/appearance");
        Assert.Equal("dark", back.GetProperty("mode").GetString());
        Assert.Equal("dusk", back.GetProperty("wallpaper").GetProperty("id").GetString());

        Assert.Equal(HttpStatusCode.BadRequest, (await alice.Http.PutAsJsonAsync("/api/users/me/appearance", new[] { 1, 2 })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await alice.Http.PutAsJsonAsync("/api/users/me/appearance", new { big = new string('x', 5000) })).StatusCode);
    }
}
