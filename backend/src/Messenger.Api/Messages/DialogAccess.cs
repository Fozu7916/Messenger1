using Messenger.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Messenger.Api.Messages;

/// <summary>Проверка членства в диалоге — единая точка авторизации для REST и SignalR.</summary>
public interface IDialogAccess
{
    Task<IReadOnlyList<string>> GetMemberIdsAsync(string dialogId, CancellationToken ct = default);
    Task<bool> IsMemberAsync(string dialogId, string userId, CancellationToken ct = default);
    /// <summary>Все, с кем у пользователя есть диалоги (для рассылки presence).</summary>
    Task<IReadOnlyList<string>> GetContactIdsAsync(string userId, CancellationToken ct = default);
}

public sealed class DialogAccess(AppDbContext db) : IDialogAccess
{
    public async Task<IReadOnlyList<string>> GetMemberIdsAsync(string dialogId, CancellationToken ct = default) =>
        await db.DialogMembers.AsNoTracking()
            .Where(m => m.DialogId == dialogId)
            .Select(m => m.UserId)
            .ToListAsync(ct);

    public Task<bool> IsMemberAsync(string dialogId, string userId, CancellationToken ct = default) =>
        db.DialogMembers.AsNoTracking().AnyAsync(m => m.DialogId == dialogId && m.UserId == userId, ct);

    public async Task<IReadOnlyList<string>> GetContactIdsAsync(string userId, CancellationToken ct = default) =>
        await db.DialogMembers.AsNoTracking()
            .Where(m => m.UserId == userId)
            .SelectMany(m => m.Dialog.Members)
            .Where(x => x.UserId != userId)
            .Select(x => x.UserId)
            .Distinct()
            .ToListAsync(ct);
}
