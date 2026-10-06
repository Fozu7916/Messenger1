using Microsoft.EntityFrameworkCore;
using Messenger.Domain.Entities;
using Messenger.Infrastructure.Persistence;
using Messenger.Infrastructure.Persistence.Repositories;

namespace Messenger.IntegrationTests;

public sealed class MessageRepositoryTests
{
    private const string ConnectionString =
        "Host=localhost;Port=5432;Database=messenger;Username=messenger;Password=messenger_dev_password";

    [Fact]
public async Task Can_Save_Message_With_Dapper()
{
    var options = new DbContextOptionsBuilder<MessengerDbContext>()
        .UseNpgsql(ConnectionString)
        .Options;

    await using var db = new MessengerDbContext(options);

    var user = new User($"dapper-test-{Guid.NewGuid():N}");
    var conversation = new Conversation();

    var member = new ConversationMember(
        conversation.Id,
        user.Id);

    db.Users.Add(user);
    db.Conversations.Add(conversation);
    db.ConversationMembers.Add(member);

    await db.SaveChangesAsync();

    var conversationExists = await db.Conversations
        .AsNoTracking()
        .AnyAsync(x => x.Id == conversation.Id);

    Console.WriteLine($"Conversation ID: {conversation.Id}");
    Console.WriteLine($"Conversation exists: {conversationExists}");

    Assert.True(conversationExists);

    var message = new Message(
        conversation.Id,
        user.Id,
        "Hello from Dapper!");

    var repository = new MessageRepository(ConnectionString);

    await repository.AddAsync(message);

    db.ChangeTracker.Clear();

    var savedMessage = await db.Messages
        .AsNoTracking()
        .SingleAsync(x => x.Id == message.Id);

    Assert.Equal(message.Id, savedMessage.Id);
    Assert.Equal(conversation.Id, savedMessage.ConversationId);
    Assert.Equal(user.Id, savedMessage.SenderId);
    Assert.Equal("Hello from Dapper!", savedMessage.Content);
}
}