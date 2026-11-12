using SkiaSharp;

namespace Messenger.Api.Media;

public sealed class InvalidImageException(string message) : Exception(message);

/// <summary>
/// Приём картинок от пользователей: настоящее декодирование (а не доверие к расширению), защита от «бомб» по числу пикселей,
/// поворот по EXIF и перекодирование в WebP. Перекодирование заодно вырезает все метаданные (геолокацию и пр.).
/// </summary>
public static class ImageProcessor
{
    private const long MaxPixels = 36_000_000;   // около 6000×6000: маленький файл не должен разворачиваться в гигабайты памяти

    /// <summary>Аватар: квадрат по центру, до 512×512, WebP.</summary>
    public static byte[] Avatar(Stream input)
    {
        using var src = Decode(input);
        var side = Math.Min(src.Width, src.Height);
        var size = Math.Min(512, side);
        using var dst = Draw(src, SKRect.Create((src.Width - side) / 2f, (src.Height - side) / 2f, side, side), size, size);
        return Encode(dst, 85);
    }

    /// <summary>Обои: вписываются в 1920 px по большей стороне (без увеличения), WebP.</summary>
    public static byte[] Wallpaper(Stream input)
    {
        using var src = Decode(input);
        var scale = Math.Min(1f, 1920f / Math.Max(src.Width, src.Height));
        var w = Math.Max(1, (int)Math.Round(src.Width * scale));
        var h = Math.Max(1, (int)Math.Round(src.Height * scale));
        using var dst = Draw(src, SKRect.Create(0, 0, src.Width, src.Height), w, h);
        return Encode(dst, 80);
    }

    private static SKBitmap Decode(Stream input)
    {
        try
        {
            using var data = SKData.Create(input);
            if (data is null || data.Size == 0) throw new InvalidImageException("Empty file");
            using var codec = SKCodec.Create(data) ?? throw new InvalidImageException("Not an image");
            if (codec.EncodedFormat is not (SKEncodedImageFormat.Jpeg or SKEncodedImageFormat.Png or SKEncodedImageFormat.Webp or SKEncodedImageFormat.Gif))
                throw new InvalidImageException("Unsupported image format");
            var info = codec.Info;
            if (info.Width <= 0 || info.Height <= 0 || (long)info.Width * info.Height > MaxPixels)
                throw new InvalidImageException("Image is too large");
            var bmp = SKBitmap.Decode(codec, new SKImageInfo(info.Width, info.Height, SKColorType.Rgba8888, SKAlphaType.Premul))
                ?? throw new InvalidImageException("Corrupted image");
            return Orient(bmp, codec.EncodedOrigin);
        }
        catch (InvalidImageException) { throw; }
        catch (Exception ex) { throw new InvalidImageException("Corrupted image: " + ex.Message); }
    }

    /// <summary>Приводит картинку к «правильной» ориентации по EXIF (фото с телефона часто лежат боком).</summary>
    private static SKBitmap Orient(SKBitmap src, SKEncodedOrigin origin)
    {
        if (origin is SKEncodedOrigin.TopLeft or SKEncodedOrigin.Default) return src;
        var swap = origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;
        float w = swap ? src.Height : src.Width, h = swap ? src.Width : src.Height;
        var m = origin switch
        {
            SKEncodedOrigin.TopRight => new SKMatrix(-1, 0, w, 0, 1, 0, 0, 0, 1),
            SKEncodedOrigin.BottomRight => new SKMatrix(-1, 0, w, 0, -1, h, 0, 0, 1),
            SKEncodedOrigin.BottomLeft => new SKMatrix(1, 0, 0, 0, -1, h, 0, 0, 1),
            SKEncodedOrigin.LeftTop => new SKMatrix(0, 1, 0, 1, 0, 0, 0, 0, 1),
            SKEncodedOrigin.RightTop => new SKMatrix(0, -1, w, 1, 0, 0, 0, 0, 1),
            SKEncodedOrigin.RightBottom => new SKMatrix(0, -1, w, -1, 0, h, 0, 0, 1),
            SKEncodedOrigin.LeftBottom => new SKMatrix(0, 1, 0, -1, 0, h, 0, 0, 1),
            _ => SKMatrix.Identity,
        };
        var dst = new SKBitmap((int)w, (int)h, src.ColorType, src.AlphaType);
        using (var canvas = new SKCanvas(dst))
        {
            canvas.Clear(SKColors.Transparent);
            canvas.SetMatrix(m);
            canvas.DrawBitmap(src, 0, 0);
        }
        src.Dispose();
        return dst;
    }

    private static SKBitmap Draw(SKBitmap src, SKRect from, int w, int h)
    {
        var dst = new SKBitmap(w, h, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var canvas = new SKCanvas(dst);
        canvas.Clear(SKColors.Transparent);
        using var image = SKImage.FromBitmap(src);
        canvas.DrawImage(image, from, SKRect.Create(0, 0, w, h), new SKSamplingOptions(SKCubicResampler.Mitchell));
        return dst;
    }

    private static byte[] Encode(SKBitmap bmp, int quality)
    {
        using var image = SKImage.FromBitmap(bmp);
        using var data = image.Encode(SKEncodedImageFormat.Webp, quality) ?? throw new InvalidImageException("Could not encode image");
        return data.ToArray();
    }
}
