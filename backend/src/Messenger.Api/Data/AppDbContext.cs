using Messenger.Api.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Messenger.Api.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Dialog> Dialogs => Set<Dialog>();
    public DbSet<DialogMember> DialogMembers => Set<DialogMember>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<MessageHide> MessageHides => Set<MessageHide>();

    // ULID — 26 символов Crockford Base32. Лексикографический порядок == хронологический,
    // но только при коллации "C" (побайтовое сравнение), поэтому задаём её явно.
    private static PropertyBuilder<string> UlidColumn(PropertyBuilder<string> p) =>
        p.HasMaxLength(26).UseCollation("C");

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<User>(e =>
        {
            e.ToTable("users");
            e.HasKey(x => x.Id);
            UlidColumn(e.Property(x => x.Id));
            e.Property(x => x.Login).HasMaxLength(32).IsRequired();
            e.Property(x => x.Email).HasMaxLength(254).IsRequired();
            e.Property(x => x.PasswordHash).HasMaxLength(100).IsRequired();
            e.Property(x => x.DisplayName).HasMaxLength(64).IsRequired();
            e.Property(x => x.AvatarUrl).HasMaxLength(2048);
            e.HasIndex(x => x.Login).IsUnique();
            e.HasIndex(x => x.Email).IsUnique();
        });

        b.Entity<Dialog>(e =>
        {
            e.ToTable("dialogs");
            e.HasKey(x => x.Id);
            UlidColumn(e.Property(x => x.Id));
            e.Property(x => x.PairKey).HasMaxLength(64);
            e.HasIndex(x => x.PairKey).IsUnique();
        });

        b.Entity<RefreshToken>(e =>
        {
            e.ToTable("refresh_tokens");
            e.HasKey(x => x.Id);
            UlidColumn(e.Property(x => x.Id));
            UlidColumn(e.Property(x => x.UserId));
            e.Property(x => x.ReplacedById).HasMaxLength(26).UseCollation("C");
            e.Property(x => x.TokenHash).HasMaxLength(64);
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.UserId);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<DialogMember>(e =>
        {
            e.ToTable("dialog_members");
            e.HasKey(x => new { x.DialogId, x.UserId });
            UlidColumn(e.Property(x => x.DialogId));
            UlidColumn(e.Property(x => x.UserId));
            e.HasOne(x => x.Dialog).WithMany(d => d.Members).HasForeignKey(x => x.DialogId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.LastReadId).HasMaxLength(26).UseCollation("C");
            e.HasIndex(x => x.UserId);
        });

        b.Entity<Message>(e =>
        {
            e.ToTable("messages");
            e.HasKey(x => x.Id);
            UlidColumn(e.Property(x => x.Id));
            UlidColumn(e.Property(x => x.DialogId));
            UlidColumn(e.Property(x => x.SenderId));
            e.Property(x => x.ClientMessageId).HasMaxLength(64).IsRequired();
            e.Property(x => x.Text).HasMaxLength(4000).IsRequired();
            e.Property(x => x.MediaUrl).HasMaxLength(2048);
            e.Property(x => x.CreatedAt).HasDefaultValueSql("now()");
            e.HasOne(x => x.Dialog).WithMany(d => d.Messages).HasForeignKey(x => x.DialogId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Sender).WithMany().HasForeignKey(x => x.SenderId).OnDelete(DeleteBehavior.Restrict);

            // идемпотентность на уровне БД
            e.HasIndex(x => new { x.SenderId, x.ClientMessageId }).IsUnique();
            // история диалога и дельта-синхронизация
            e.HasIndex(x => new { x.DialogId, x.Id });
        });

        b.Entity<MessageHide>(e =>
        {
            e.ToTable("message_hides");
            e.HasKey(x => new { x.MessageId, x.UserId });
            UlidColumn(e.Property(x => x.MessageId));
            UlidColumn(e.Property(x => x.UserId));
            e.Property(x => x.CreatedAt).HasDefaultValueSql("now()");
            e.HasOne<Message>().WithMany().HasForeignKey(x => x.MessageId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => x.UserId);
        });
    }
}
