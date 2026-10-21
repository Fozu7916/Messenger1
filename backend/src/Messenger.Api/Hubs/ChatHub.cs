using Messenger.Api.Messages;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace Messenger.Api.Hubs;

/// <summary>
/// Клиент → сервер: SendMessage, Typing, MarkRead, GetOnlineContacts.
/// Сервер → клиент: MessageReceived, MessageAcked, MessageDeleted, MessageEdited, MessagesRead, UserTyping, PresenceChanged.
/// Рассылка идёт через Clients.Users(...) — работает между инстансами благодаря Redis backplane.
/// </summary>
[Authorize]
public sealed class ChatHub(IMessageRepository messages, IDialogAccess dialogs, IPresenceTracker presence) : Hub
{
    public const string Path = "/hubs/chat";
    private const int MaxTextLength = 4000;
    private const int MaxClientMessageIdLength = 64;

    private string UserId => Context.UserIdentifier ?? throw new HubException("unauthorized");

    public override async Task OnConnectedAsync()
    {
        if (presence.UserConnected(UserId, Context.ConnectionId))
            await NotifyPresenceAsync(UserId, "online");
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Context.UserIdentifier is { } userId && presence.UserDisconnected(userId, Context.ConnectionId))
            await NotifyPresenceAsync(userId, "offline");
        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>
    /// Сохраняет сообщение и рассылает его участникам диалога. Возвращает серверный ULID.
    /// Повторный вызов с тем же clientMessageId не создаёт дубликат и не рассылает событие повторно.
    /// </summary>
    public async Task<string> SendMessage(string clientMessageId, string dialogId, string text)
    {
        var senderId = UserId;
        text = text?.Trim() ?? "";

        if (string.IsNullOrWhiteSpace(clientMessageId) || clientMessageId.Length > MaxClientMessageIdLength)
            throw new HubException("invalid_client_message_id");
        if (text.Length == 0 || text.Length > MaxTextLength)
            throw new HubException("invalid_text");

        var members = await dialogs.GetMemberIdsAsync(dialogId ?? "");
        if (!members.Contains(senderId))
            throw new HubException("forbidden");   // одинаково для «нет диалога» и «чужой диалог»

        var result = await messages.SaveAsync(new NewMessage(
            Id: Ulid.NewUlid().ToString(),
            ClientMessageId: clientMessageId,
            DialogId: dialogId!,
            SenderId: senderId,
            Text: text,
            MediaUrl: null));

        await Clients.Caller.SendAsync("MessageAcked", clientMessageId, result.Message.Id);
        if (result.IsNew)
            await Clients.Users(members).SendAsync("MessageReceived", result.Message);

        return result.Message.Id;
    }

    public async Task Typing(string dialogId)
    {
        var members = await dialogs.GetMemberIdsAsync(dialogId ?? "");
        if (!members.Contains(UserId))
            throw new HubException("forbidden");

        var others = members.Where(id => id != UserId).ToList();
        await Clients.Users(others).SendAsync("UserTyping", dialogId, UserId);
    }

    /// <summary>
    /// Отмечает диалог прочитанным до сообщения upToId. Участникам (включая другие устройства читающего)
    /// уходит MessagesRead(dialogId, readerId, upToId) — собеседник видит «прочитано».
    /// </summary>
    public async Task MarkRead(string dialogId, string upToId)
    {
        var members = await dialogs.GetMemberIdsAsync(dialogId ?? "");
        if (!members.Contains(UserId))
            throw new HubException("forbidden");
        if (string.IsNullOrWhiteSpace(upToId) || !Ulid.TryParse(upToId, out _))
            throw new HubException("invalid_message_id");

        var readUpTo = await messages.MarkReadAsync(dialogId!, UserId, upToId);
        if (readUpTo is not null)
            await Clients.Users(members).SendAsync("MessagesRead", dialogId, UserId, readUpTo);
    }

    /// <summary>Кто из собеседников сейчас онлайн. Клиент вызывает при (пере)подключении, чтобы не ждать событий PresenceChanged.</summary>
    public async Task<IReadOnlyList<string>> GetOnlineContacts()
    {
        var contacts = await dialogs.GetContactIdsAsync(UserId);
        return contacts.Where(presence.IsOnline).ToList();
    }

    private async Task NotifyPresenceAsync(string userId, string status)
    {
        var contacts = await dialogs.GetContactIdsAsync(userId);
        if (contacts.Count > 0)
            await Clients.Users(contacts).SendAsync("PresenceChanged", userId, status);
    }
}
